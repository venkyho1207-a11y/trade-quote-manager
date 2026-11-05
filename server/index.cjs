const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const multer = require('multer')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { z } = require('zod')
const { db, id, isoDate } = require('./db.cjs')
const auth = require('./auth.cjs')

// 首次启动没有账号时，用环境变量建一个；都不设就生成随机密码打印到控制台，
// 保证默认部署不会以"空白口令"暴露出去
function ensureInitialUser() {
  if (auth.userCount() > 0) return
  const username = process.env.ADMIN_USER || 'admin'
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url')
  auth.createUser(username, password, '管理员')
  console.info('[auth] 已创建初始账号')
  console.info(`[auth] 用户名: ${username}`)
  if (!process.env.ADMIN_PASSWORD) console.info(`[auth] 初始密码（仅本次显示，请立即登录后修改）: ${password}`)
}
ensureInitialUser()

const schemaColumns = db.prepare('PRAGMA table_info(quote_items)').all().map((column) => column.name)
for (const [name, definition] of [['exw', 'REAL NOT NULL DEFAULT 0'], ['fob', 'REAL NOT NULL DEFAULT 0'], ['cif', 'REAL NOT NULL DEFAULT 0'], ['selected_unit_price', 'REAL NOT NULL DEFAULT 0'], ['total_price', 'REAL NOT NULL DEFAULT 0']]) {
  if (!schemaColumns.includes(name)) db.exec(`ALTER TABLE quote_items ADD COLUMN ${name} ${definition}`)
}

// 汇率：内存缓存 + exchange_rates 表持久化，启动读最新、每小时抓一次公开免费接口（免 key），支持手动覆盖
// 央行中间价无稳定公开 JSON 接口，此处先用公开免费汇率接口近似，source 记录来源，后续可替换为定时抓中间价
const EXCHANGE_FALLBACK_RATE = 7.1
let exchangeRateCache = { rate: EXCHANGE_FALLBACK_RATE, source: '默认值', updatedAt: isoDate() }
function loadExchangeRate() {
  const row = db.prepare('SELECT rate, source, created_at FROM exchange_rates ORDER BY created_at DESC LIMIT 1').get()
  if (row) exchangeRateCache = { rate: row.rate, source: row.source, updatedAt: row.created_at }
}
const EXCHANGE_SOURCES = [
  { name: 'frankfurter(ECB)', url: 'https://api.frankfurter.app/latest?from=USD&to=CNY', parse: (json) => json?.rates?.CNY },
  { name: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD', parse: (json) => json?.rates?.CNY },
]
async function fetchExchangeRate() {
  for (const src of EXCHANGE_SOURCES) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const rate = src.parse(await res.json())
      if (typeof rate === 'number' && rate > 0) {
        exchangeRateCache = { rate, source: src.name, updatedAt: isoDate() }
        db.prepare('INSERT INTO exchange_rates (id, rate, source, created_at) VALUES (?,?,?,?)').run(id('fx'), rate, src.name, isoDate())
        console.info('[fx] 汇率已更新', rate, src.name)
        return exchangeRateCache
      }
    } catch (error) { console.warn('[fx] 抓取失败', src.name, String(error)) }
  }
  return exchangeRateCache
}
loadExchangeRate()
fetchExchangeRate()
setInterval(fetchExchangeRate, 60 * 60 * 1000)

const app = express()
const port = Number(process.env.PORT || 3000)
const uploadDir = path.join(__dirname, '..', 'uploads')
fs.mkdirSync(uploadDir, { recursive: true })
// 单证模板文件单独存放，避免与产品图片混在一起
const templateDir = path.join(__dirname, '..', 'uploads', 'templates')
fs.mkdirSync(templateDir, { recursive: true })
// Cookie 认证不能用通配 origin：未配置 CORS_ORIGIN 时只允许同源访问，
// 需要跨域部署就显式设置环境变量为前端地址
const allowedOrigin = process.env.CORS_ORIGIN || false
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({ origin: allowedOrigin, credentials: true }))
app.use(express.json({ limit: '1mb' }))

// ===== 认证 =====
const loginSchema = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(200) }).strict()
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }).strict()

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.post('/api/auth/login', (req, res) => {
  const data = parseBody(loginSchema, req.body, res); if (!data) return
  const key = req.ip || 'unknown'
  if (auth.tooManyAttempts(key)) return sendError(res, 429, '尝试次数过多，请 5 分钟后再试')
  const user = auth.verifyPassword(data.username, data.password)
  if (!user) { auth.recordFailure(key); return sendError(res, 401, '用户名或密码错误') }
  auth.clearAttempts(key)
  auth.setSessionCookie(res, auth.createSession(user.id))
  console.info('[auth] 登录成功', user.username, key)
  res.json({ user: auth.publicUser(user) })
})

app.get('/api/auth/me', (req, res) => {
  const session = auth.findSession(auth.tokenFromRequest(req))
  if (!session) return sendError(res, 401, '未登录')
  res.json({ user: { id: session.user_id, username: session.username, displayName: session.display_name } })
})

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(auth.tokenFromRequest(req))
  auth.clearSessionCookie(res)
  res.json({ ok: true })
})

app.post('/api/auth/password', (req, res) => {
  const session = auth.findSession(auth.tokenFromRequest(req))
  if (!session) return sendError(res, 401, '未登录')
  const data = parseBody(changePasswordSchema, req.body, res); if (!data) return
  const user = auth.verifyPassword(session.username, data.currentPassword)
  if (!user) return sendError(res, 400, '当前密码不正确')
  const salt = crypto.randomBytes(32).toString('hex')
  db.prepare('UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?')
    .run(auth.hashPassword(data.newPassword, salt), salt, isoDate(), user.id)
  // 改密后踢掉该账号所有会话，旧 token 立即失效
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
  auth.clearSessionCookie(res)
  console.info('[auth] 密码已修改', user.username)
  res.json({ ok: true })
})

// 除健康检查和登录相关外，所有接口都要求有效会话
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login'])
app.use('/api', (req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/auth/')) return next()
  const session = auth.findSession(auth.tokenFromRequest(req))
  if (!session) return sendError(res, 401, '未登录或登录已过期')
  req.user = session
  next()
})

// 上传文件同样要求登录：产品图、模板 xlsx 都属于业务资料，不该匿名可下载
app.use('/uploads', (req, res, next) => {
  if (!auth.findSession(auth.tokenFromRequest(req))) return sendError(res, 401, '未登录')
  next()
}, express.static(uploadDir, { maxAge: '1d' }))

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
})

const text = (max = 200) => z.string().trim().max(max)
const positive = z.number().finite().positive()
const nonNegative = z.number().finite().nonnegative()
const productSchema = z.object({ name: text(120).min(1), sku: text(80).min(1), model: text(120).default(''), cost: positive, image: text(500).default(''), specification: text(300).min(1), description: text(2000).default(''), surfaceTreatment: text(200).default(''), moq: z.number().int().nonnegative().default(0), packingQuantity: z.number().int().nonnegative().default(0), packingRequirement: text(500).default(''), note: text(1000).default(''), supplierIds: z.array(text(80)).default([]),
  // 单证用：单位按件，装箱数沿用已有 packingQuantity；重量体积是「单箱」口径，生成时按箱数累加
  unit: text(20).default('PCS'), hsCode: text(40).default(''),
  cartonGrossWeight: nonNegative.default(0), cartonNetWeight: nonNegative.default(0), cartonVolume: nonNegative.default(0), cartonSize: text(80).default(''),
}).strict()
const supplierSchema = z.object({ name: text(120).min(1), contact: text(80).min(1), position: text(80).default(''), whatsapp: text(80).default(''), phone: text(80).default(''), email: text(160).default(''), address: text(300).default(''), note: text(1000).default(''), productIds: z.array(text(80)).default([]) }).strict()
const customerSchema = z.object({ code: text(80).default(''), name: text(120).min(1), type: z.enum(['新客户', '订单客户', '样单客户', '重潜在客户', '轻潜在客户']).default('新客户'), country: text(80).min(1), timezone: text(80).default(''), business: text(300).default(''), website: text(300).default(''), contact: text(80).min(1), phone: text(80).default(''), address: text(300).default(''), email: text(160).default(''), zip: text(40).default(''), fax: text(80).default(''), salesperson: text(80).default(''), note: text(1000).default('') }).strict()
// 客户类型 → 跟进间隔天数：新客户走固定节点序列，其余按固定频率顺延
const FOLLOWUP_DAYS = { '订单客户': 30, '样单客户': 60, '重潜在客户': 90, '轻潜在客户': 120 }
const NEW_CUSTOMER_STAGES = [1, 3, 7, 14, 30]
const inquirySchema = z.object({ productId: text(80).min(1), supplierId: text(80).min(1), quote: positive, inquiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: text(500).default('') }).strict()
const followUpSchema = z.object({ followedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), content: text(2000).min(1) }).strict()
const quoteItemSchema = z.object({ productId: text(80).min(1), quantity: z.number().int().positive(), packagingFee: nonNegative, profit: nonNegative, customExw: nonNegative.nullable().default(null), customFob: nonNegative.nullable().default(null), customCif: nonNegative.nullable().default(null), priceCurrency: z.enum(['CNY', 'USD']).default('CNY') }).strict()
const quoteSchema = z.object({ customerId: text(80).min(1), mode: z.enum(['散货', '整柜']), tradeTerm: z.enum(['EXW', 'FOB', 'CIF']), domesticFreight: nonNegative, customsFee: nonNegative, bankFee: nonNegative, oceanFreight: nonNegative, insuranceFee: nonNegative, paymentNote: text(1000).default(''), currency: z.enum(['CNY', 'USD']).default('CNY'), exchangeRate: nonNegative.default(1), quoteNo: text(80).default(''), items: z.array(quoteItemSchema).min(1) }).strict()
const myCompanySchema = z.object({
  nameCn: text(160).default(''), nameEn: text(160).default(''),
  addressCn: text(400).default(''), addressEn: text(400).default(''),
  tel: text(80).default(''), fax: text(80).default(''), email: text(160).default(''),
  website: text(200).default(''), zip: text(40).default(''),
  unifiedCode: text(60).default(''), customsCode: text(60).default(''), logo: text(500).default(''),
  beneficiaryAccount: text(120).default(''), swiftCode: text(40).default(''),
  beneficiaryCountry: text(120).default(''), beneficiaryName: text(160).default(''),
  beneficiaryAddress: text(300).default(''), beneficiaryBank: text(200).default(''),
  beneficiaryBankAddress: text(300).default(''), bankCode: text(40).default(''), branchCode: text(40).default(''),
}).strict()
const templateUpdateSchema = z.object({ name: text(120).optional(), docType: z.enum(['PI', '报价单', '商业发票', '装箱单', '报关单', '其他']).optional(), mapping: z.record(z.any()).optional() }).strict()
const documentFieldsSchema = z.object({
  from: text(160).default(''), to: text(160).default(''), vessel: text(160).default(''),
  marks: text(1000).default(''), poNo: text(80).default(''), scNo: text(80).default(''),
  loadingDate: text(80).default(''), countryOfOrigin: text(80).default(''),
  termOfDelivery: text(500).default(''), remark: text(2000).default(''),
  items: z.record(z.object({ unit: text(40).default(''), hsCode: text(40).default(''), ctns: text(40).default(''), gw: text(40).default(''), nw: text(40).default(''), cbm: text(40).default(''), size: text(80).default('') }).strict()).default({}),
}).strict()

function sendError(res, status, message) { return res.status(status).json({ message }) }
function parseBody(schema, body, res) { const result = schema.safeParse(body); if (!result.success) { sendError(res, 400, result.error.issues[0]?.message || '输入参数不合法'); return null } return result.data }
function productView(row) {
  const suppliers = db.prepare(`SELECT i.id, s.name AS supplierName, s.contact, i.quote, i.inquiry_date AS inquiryDate, i.note FROM inquiries i JOIN suppliers s ON s.id=i.supplier_id WHERE i.product_id=? ORDER BY i.inquiry_date DESC`).all(row.id)
  const supplierIds = db.prepare('SELECT supplier_id FROM product_suppliers WHERE product_id=?').all(row.id).map((link) => link.supplier_id)
  return { id: row.id, name: row.name, sku: row.sku, model: row.model, cost: row.cost, image: row.image, specification: row.specification, description: row.description, surfaceTreatment: row.surface_treatment, moq: row.moq, packingQuantity: row.packing_quantity, packingRequirement: row.packing_requirement, note: row.note, unit: row.unit || 'PCS', hsCode: row.hs_code || '', cartonGrossWeight: row.carton_gross_weight || 0, cartonNetWeight: row.carton_net_weight || 0, cartonVolume: row.carton_volume || 0, cartonSize: row.carton_size || '', supplierIds, suppliers, createdAt: row.created_at, updatedAt: row.updated_at }
}
function supplierView(row) {
  const productIds = db.prepare('SELECT product_id FROM product_suppliers WHERE supplier_id=?').all(row.id).map((link) => link.product_id)
  return { id: row.id, name: row.name, contact: row.contact, position: row.position, whatsapp: row.whatsapp, phone: row.phone, email: row.email, address: row.address, note: row.note, productIds, createdAt: row.created_at }
}
// 全量替换 product_suppliers 关联：先删后插，保持表单提交的多选与库一致
function setProductSuppliers(productId, supplierIds) {
  db.prepare('DELETE FROM product_suppliers WHERE product_id=?').run(productId)
  const insert = db.prepare('INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id) VALUES (?,?)')
  for (const supplierId of supplierIds) insert.run(productId, supplierId)
}
// 计算下一次跟进日期：新客户按固定节点序列（1/3/7/14/30天）推进，其余类型按固定间隔顺延
function nextFollowUpDate(customer) {
  if (customer.type === '新客户') {
    const stage = Number(customer.followup_stage) || 0
    const days = NEW_CUSTOMER_STAGES[Math.min(stage, NEW_CUSTOMER_STAGES.length - 1)]
    return addDays(customer.last_follow_up_at || customer.created_at, days)
  }
  return addDays(customer.last_follow_up_at || customer.created_at, FOLLOWUP_DAYS[customer.type] || 30)
}
function addDays(iso, days) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
function daysLeft(iso) { if (!iso) return null; const today = new Date(`${isoDate()}T00:00:00Z`); const target = new Date(`${iso}T00:00:00Z`); return Math.round((target - today) / 86400000) }
function customerView(row) { return { id: row.id, code: row.code, name: row.name, type: row.type, country: row.country, timezone: row.timezone, business: row.business, website: row.website, contact: row.contact, phone: row.phone, address: row.address, email: row.email, zip: row.zip || '', fax: row.fax || '', salesperson: row.salesperson, note: row.note, lastFollowUpAt: row.last_follow_up_at, nextFollowUpAt: row.next_follow_up_at, followupStage: row.followup_stage, daysLeft: daysLeft(row.next_follow_up_at), createdAt: row.created_at } }

app.post('/api/uploads', upload.single('image'), (req, res) => { if (!req.file) return sendError(res, 400, '仅支持 JPG、PNG、WebP 图片且大小不超过5MB'); res.status(201).json({ url: `/uploads/${req.file.filename}` }) })

app.get('/api/products', (_req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY updated_at DESC').all().map(productView)))
app.post('/api/products', (req, res) => { const data = parseBody(productSchema, req.body, res); if (!data) return; const now = isoDate(); const { supplierIds, ...fields } = data; const product = { id: id('prod'), ...fields, created_at: now, updated_at: now }; try { db.prepare('INSERT INTO products (id,name,sku,model,cost,image,specification,description,surface_treatment,moq,packing_quantity,packing_requirement,note,unit,hs_code,carton_gross_weight,carton_net_weight,carton_volume,carton_size,created_at,updated_at) VALUES (@id,@name,@sku,@model,@cost,@image,@specification,@description,@surfaceTreatment,@moq,@packingQuantity,@packingRequirement,@note,@unit,@hsCode,@cartonGrossWeight,@cartonNetWeight,@cartonVolume,@cartonSize,@created_at,@updated_at)').run(product); setProductSuppliers(product.id, supplierIds); console.info('[audit] product created', product.id); res.status(201).json(productView(product)) } catch (error) { if (String(error).includes('UNIQUE')) return sendError(res, 409, 'SKU已存在'); throw error } })
app.put('/api/products/:id', (req, res) => { const data = parseBody(productSchema.partial(), req.body, res); if (!data) return; const current = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id); if (!current) return sendError(res, 404, '产品不存在'); const { supplierIds, ...fields } = data; const next = { ...current, ...fields, updated_at: isoDate() }; try { db.prepare('UPDATE products SET name=@name,sku=@sku,model=@model,cost=@cost,image=@image,specification=@specification,description=@description,surface_treatment=@surfaceTreatment,moq=@moq,packing_quantity=@packingQuantity,packing_requirement=@packingRequirement,note=@note,unit=@unit,hs_code=@hsCode,carton_gross_weight=@cartonGrossWeight,carton_net_weight=@cartonNetWeight,carton_volume=@cartonVolume,carton_size=@cartonSize,updated_at=@updated_at WHERE id=@id').run({ ...next, id: req.params.id }); if (supplierIds !== undefined) setProductSuppliers(req.params.id, supplierIds); console.info('[audit] product updated', req.params.id); res.json(productView(next)) } catch (error) { if (String(error).includes('UNIQUE')) return sendError(res, 409, 'SKU已存在'); throw error } })
app.delete('/api/products/:id', (req, res) => { const result = db.prepare('DELETE FROM products WHERE id=?').run(req.params.id); if (!result.changes) return sendError(res, 404, '产品不存在'); console.info('[audit] product deleted', req.params.id); res.json({ ok: true }) })
app.post('/api/products/inquiries', (req, res) => { const data = parseBody(inquirySchema, req.body, res); if (!data) return; if (!db.prepare('SELECT id FROM products WHERE id=?').get(data.productId) || !db.prepare('SELECT id FROM suppliers WHERE id=?').get(data.supplierId)) return sendError(res, 404, '产品或供应商不存在'); const row = { id: id('inq'), ...data }; db.prepare('INSERT INTO inquiries (id,product_id,supplier_id,quote,inquiry_date,note) VALUES (@id,@productId,@supplierId,@quote,@inquiryDate,@note)').run(row); res.status(201).json(row) })

app.get('/api/suppliers', (_req, res) => res.json(db.prepare('SELECT * FROM suppliers ORDER BY created_at DESC').all().map(supplierView)))
app.post('/api/suppliers', (req, res) => { const data = parseBody(supplierSchema, req.body, res); if (!data) return; const { productIds, ...fields } = data; const row = { id: id('sup'), ...fields, created_at: isoDate() }; db.prepare('INSERT INTO suppliers (id,name,contact,position,whatsapp,phone,email,address,note,created_at) VALUES (@id,@name,@contact,@position,@whatsapp,@phone,@email,@address,@note,@created_at)').run(row); const insertLink = db.prepare('INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id) VALUES (?,?)'); for (const productId of productIds) insertLink.run(productId, row.id); console.info('[audit] supplier created', row.id); res.status(201).json(supplierView(row)) })
app.put('/api/suppliers/:id', (req, res) => { const data = parseBody(supplierSchema.partial(), req.body, res); if (!data) return; const current = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id); if (!current) return sendError(res, 404, '供应商不存在'); const { productIds, ...fields } = data; const next = { ...current, ...fields }; db.prepare('UPDATE suppliers SET name=@name,contact=@contact,position=@position,whatsapp=@whatsapp,phone=@phone,email=@email,address=@address,note=@note WHERE id=@id').run({ ...next, id: req.params.id }); if (productIds !== undefined) { db.prepare('DELETE FROM product_suppliers WHERE supplier_id=?').run(req.params.id); const insertLink = db.prepare('INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id) VALUES (?,?)'); for (const productId of productIds) insertLink.run(productId, req.params.id) } console.info('[audit] supplier updated', req.params.id); res.json(supplierView(next)) })
app.delete('/api/suppliers/:id', (req, res) => { try { const result = db.prepare('DELETE FROM suppliers WHERE id=?').run(req.params.id); if (!result.changes) return sendError(res, 404, '供应商不存在'); res.json({ ok: true }) } catch { sendError(res, 409, '该供应商已有询价记录，不能删除') } })

app.get('/api/customers', (_req, res) => res.json(db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all().map(customerView)))
app.post('/api/customers', (req, res) => { const data = parseBody(customerSchema, req.body, res); if (!data) return; if (data.code && db.prepare('SELECT id FROM customers WHERE code=?').get(data.code)) return sendError(res, 409, '客户代码已存在'); const row = { id: id('cus'), ...data, last_follow_up_at: null, followup_stage: 0, created_at: isoDate() }; row.next_follow_up_at = nextFollowUpDate(row); db.prepare('INSERT INTO customers (id,code,name,type,country,timezone,business,website,contact,phone,address,email,zip,fax,salesperson,note,last_follow_up_at,next_follow_up_at,followup_stage,created_at) VALUES (@id,@code,@name,@type,@country,@timezone,@business,@website,@contact,@phone,@address,@email,@zip,@fax,@salesperson,@note,@last_follow_up_at,@next_follow_up_at,@followup_stage,@created_at)').run(row); res.status(201).json(customerView(row)) })
app.put('/api/customers/:id', (req, res) => { const data = parseBody(customerSchema.partial(), req.body, res); if (!data) return; const current = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id); if (!current) return sendError(res, 404, '客户不存在'); if (data.code && db.prepare('SELECT id FROM customers WHERE code=? AND id!=?').get(data.code, req.params.id)) return sendError(res, 409, '客户代码已存在'); const next = { ...current, ...data }; next.next_follow_up_at = nextFollowUpDate(next); db.prepare('UPDATE customers SET code=@code,name=@name,type=@type,country=@country,timezone=@timezone,business=@business,website=@website,contact=@contact,phone=@phone,address=@address,email=@email,zip=@zip,fax=@fax,salesperson=@salesperson,note=@note,last_follow_up_at=@last_follow_up_at,next_follow_up_at=@next_follow_up_at,followup_stage=@followup_stage WHERE id=@id').run({ ...next, id: req.params.id }); res.json(customerView(next)) })
app.delete('/api/customers/:id', (req, res) => { try { const result = db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id); if (!result.changes) return sendError(res, 404, '客户不存在'); res.json({ ok: true }) } catch { sendError(res, 409, '该客户已有报价单，不能删除') } })
// 新增跟进记录：写入时间轴，并推进「最近跟进时间 / 下一次跟进日期 / 新客户阶段」
// 最近跟进时间取时间轴里最新的一条跟进日期（MAX(followed_at)），与记录的新建/更新顺序无关，
// 补录历史日期不会把最近跟进时间带乱
app.post('/api/customers/:id/follow-ups', (req, res) => { const data = parseBody(followUpSchema, req.body, res); if (!data) return; const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id); if (!customer) return sendError(res, 404, '客户不存在'); const now = isoDate(); const followup = { id: id('fu'), customer_id: req.params.id, followed_at: data.followedAt, content: data.content, created_at: now }; const next = db.transaction(() => { db.prepare('INSERT INTO customer_follow_ups (id,customer_id,followed_at,content,created_at) VALUES (@id,@customer_id,@followed_at,@content,@created_at)').run(followup); const latest = db.prepare('SELECT MAX(followed_at) AS latest FROM customer_follow_ups WHERE customer_id=?').get(req.params.id).latest; const next = { ...customer, last_follow_up_at: latest, followup_stage: customer.type === '新客户' ? (Number(customer.followup_stage) || 0) + 1 : (Number(customer.followup_stage) || 0) }; next.next_follow_up_at = nextFollowUpDate(next); db.prepare('UPDATE customers SET last_follow_up_at=@last_follow_up_at,next_follow_up_at=@next_follow_up_at,followup_stage=@followup_stage WHERE id=@id').run({ ...next, id: req.params.id }); return next })(); res.status(201).json({ followup: { id: followup.id, customerId: followup.customer_id, followedAt: followup.followed_at, content: followup.content, createdAt: followup.created_at }, customer: customerView(next) }) })
app.get('/api/customers/:id/follow-ups', (req, res) => { if (!db.prepare('SELECT id FROM customers WHERE id=?').get(req.params.id)) return sendError(res, 404, '客户不存在'); res.json(db.prepare('SELECT id,customer_id AS customerId,followed_at AS followedAt,content,created_at AS createdAt FROM customer_follow_ups WHERE customer_id=? ORDER BY followed_at DESC, created_at DESC').all(req.params.id)) })
// 删除跟进记录：删除后重算「最近跟进时间 / 下一次跟进日期」，新客户阶段按剩余记录条数回退
app.delete('/api/customers/:id/follow-ups/:followUpId', (req, res) => { const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id); if (!customer) return sendError(res, 404, '客户不存在'); const target = db.prepare('SELECT id FROM customer_follow_ups WHERE id=? AND customer_id=?').get(req.params.followUpId, req.params.id); if (!target) return sendError(res, 404, '跟进记录不存在'); const next = db.transaction(() => { db.prepare('DELETE FROM customer_follow_ups WHERE id=?').run(req.params.followUpId); const latest = db.prepare('SELECT MAX(followed_at) AS latest FROM customer_follow_ups WHERE customer_id=?').get(req.params.id).latest; const count = db.prepare('SELECT COUNT(*) AS count FROM customer_follow_ups WHERE customer_id=?').get(req.params.id).count; const next = { ...customer, last_follow_up_at: latest, followup_stage: customer.type === '新客户' ? Math.max(0, count) : (Number(customer.followup_stage) || 0) }; next.next_follow_up_at = nextFollowUpDate(next); db.prepare('UPDATE customers SET last_follow_up_at=@last_follow_up_at,next_follow_up_at=@next_follow_up_at,followup_stage=@followup_stage WHERE id=@id').run({ ...next, id: req.params.id }); return next })(); res.json({ ok: true, customer: customerView(next) }) })

function calculateQuote(data) {
  const rate = data.exchangeRate || 1
  const rows = data.items.map((item) => ({ item, product: db.prepare('SELECT * FROM products WHERE id=?').get(item.productId) })).filter((row) => row.product)
  if (rows.length !== data.items.length) throw new Error('报价中的产品不存在')
  const totalQuantity = rows.reduce((sum, row) => sum + row.item.quantity, 0)
  const shared = data.domesticFreight + data.customsFee + data.bankFee + data.oceanFreight + data.insuranceFee
  const results = rows.map(({ item, product }) => {
    const base = product.cost + item.packagingFee + item.profit
    return { item, product, exw: Math.round((base + data.domesticFreight / totalQuantity) * 100) / 100, fob: Math.round((base + (data.domesticFreight + data.customsFee + data.bankFee) / totalQuantity) * 100) / 100, cif: Math.round((base + shared / totalQuantity) * 100) / 100 }
  })
  const items = results.map(({ item, product, exw, fob, cif }) => {
    const customKey = { EXW: 'customExw', FOB: 'customFob', CIF: 'customCif' }[data.tradeTerm]
    const recommended = { EXW: exw, FOB: fob, CIF: cif }[data.tradeTerm]
    let rawCustom = item[customKey]
    // 行按美元定价时，手动价换算成人民币参与计算，保证内部统一人民币基准；展示层再按整单币种换算
    if (rawCustom != null && item.priceCurrency === 'USD') rawCustom = rawCustom * rate
    const rawUnit = rawCustom ?? recommended
    return { item, product, exw, fob, cif, rawUnit }
  })
  const targetCents = Math.round(items.reduce((sum, row) => sum + row.rawUnit * row.item.quantity, 0) * 100)
  const lineCents = items.map((row) => Math.round(row.rawUnit * row.item.quantity * 100))
  const remainder = targetCents - lineCents.reduce((sum, value) => sum + value, 0)
  if (lineCents.length) lineCents[lineCents.length - 1] += remainder
  const totalAmount = targetCents / 100
  // 单价按分四舍五入，避免浮点误差；行金额（分）作为整单汇总基准，最后一行已做尾差补齐
  return { rows: items.map((row, index) => ({ ...row, unit: Math.round(lineCents[index] / row.item.quantity) / 100, totalPrice: lineCents[index] / 100 })), totalQuantity, totalAmount }
}
function quoteView(row) {
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(row.customer_id)
  const items = db.prepare(`SELECT qi.*, p.name AS product_name, p.sku, p.cost, p.model, p.specification, p.description, p.image, p.unit, p.hs_code, p.packing_quantity, p.carton_gross_weight, p.carton_net_weight, p.carton_volume, p.carton_size FROM quote_items qi JOIN products p ON p.id=qi.product_id WHERE qi.quote_id=?`).all(row.id)
  return { id: row.id, quoteNo: row.quote_no, customerId: row.customer_id, customerCode: customer?.code || '', customerName: customer?.name || '', customerCountry: customer?.country || '', customerContact: customer?.contact || '', customerEmail: customer?.email || '', customerAddress: customer?.address || '', customerZip: customer?.zip || '', customerFax: customer?.fax || '', mode: row.mode, tradeTerm: row.trade_term, domesticFreight: row.domestic_freight, customsFee: row.customs_fee, bankFee: row.bank_fee, oceanFreight: row.ocean_freight, insuranceFee: row.insurance_fee, paymentNote: row.payment_note, totalQuantity: row.total_quantity, totalAmount: row.total_amount, currency: row.currency, exchangeRate: row.exchange_rate, items: items.map((item) => ({ id: item.id, productId: item.product_id, productName: item.product_name, sku: item.sku, image: item.image || '', model: item.model || '', specification: item.specification || '', description: item.description || '', unit: item.unit || 'PCS', hsCode: item.hs_code || '', packingQuantity: item.packing_quantity || 0, cartonGrossWeight: item.carton_gross_weight || 0, cartonNetWeight: item.carton_net_weight || 0, cartonVolume: item.carton_volume || 0, cartonSize: item.carton_size || '', quantity: item.quantity, cost: item.cost, packagingFee: item.packaging_fee, profit: item.profit, exwUnitPrice: item.exw, fobUnitPrice: item.fob, cifUnitPrice: item.cif, selectedUnitPrice: item.selected_unit_price, totalPrice: item.total_price, tradeTerm: row.trade_term, priceCurrency: item.price_currency })), createdAt: row.created_at, updatedAt: row.updated_at }
}
app.get('/api/quotes', (_req, res) => res.json(db.prepare('SELECT * FROM quotes ORDER BY updated_at DESC').all().map(quoteView)))
app.get('/api/quotes/:id', (req, res) => { const row = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id); if (!row) return sendError(res, 404, '报价单不存在'); res.json(quoteView(row)) })
// 汇率查询与手动覆盖：GET 返回当前缓存值，POST 允许业务员手动改（写库并更新缓存）
app.get('/api/exchange-rate', (_req, res) => res.json(exchangeRateCache))
app.post('/api/exchange-rate', (req, res) => { const result = z.object({ rate: positive }).safeParse(req.body); if (!result.success) return sendError(res, 400, '汇率必须为正数'); const rate = result.data.rate; exchangeRateCache = { rate, source: '手动输入', updatedAt: isoDate() }; db.prepare('INSERT INTO exchange_rates (id, rate, source, created_at) VALUES (?,?,?,?)').run(id('fx'), rate, '手动输入', isoDate()); res.json(exchangeRateCache) })
// 新建报价单后，自动为客户写入一条当天的「发送报价单」跟进记录，并入跟进排期
function addQuoteFollowUp(customerId, quoteNo) {
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId)
  if (!customer) return
  const now = isoDate()
  const followup = { id: id('fu'), customer_id: customerId, followed_at: now, content: `发送报价单 ${quoteNo}`, created_at: now }
  db.transaction(() => {
    db.prepare('INSERT INTO customer_follow_ups (id,customer_id,followed_at,content,created_at) VALUES (@id,@customer_id,@followed_at,@content,@created_at)').run(followup)
    const latest = db.prepare('SELECT MAX(followed_at) AS latest FROM customer_follow_ups WHERE customer_id=?').get(customerId).latest
    const next = { ...customer, last_follow_up_at: latest, followup_stage: customer.type === '新客户' ? (Number(customer.followup_stage) || 0) + 1 : (Number(customer.followup_stage) || 0) }
    next.next_follow_up_at = nextFollowUpDate(next)
    db.prepare('UPDATE customers SET last_follow_up_at=@last_follow_up_at,next_follow_up_at=@next_follow_up_at,followup_stage=@followup_stage WHERE id=@id').run({ ...next, id: customerId })
  })()
}
function saveQuote(req, res, isUpdate) {
  const data = parseBody(quoteSchema, req.body, res); if (!data) return
  try {
    const calculated = calculateQuote(data)
    const now = isoDate()
    const quoteId = isUpdate ? req.params.id : id('quote')
    const current = isUpdate ? db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId) : null
    if (isUpdate && !current) return sendError(res, 404, '报价单不存在')
    // 新建且未填单号时自动生成；编辑保留原单号；复制场景前端传空 quoteNo，后端重新生成新单号
    const quoteNo = data.quoteNo && data.quoteNo.trim() ? data.quoteNo.trim() : (isUpdate ? current.quote_no : `QT-${now.replaceAll('-', '')}-${String(Date.now()).slice(-4)}`)
    if (!isUpdate && db.prepare('SELECT id FROM quotes WHERE quote_no=?').get(quoteNo)) return sendError(res, 409, '该报价单号已存在，请更换')
    const transaction = db.transaction(() => {
      if (isUpdate) {
        db.prepare('DELETE FROM quote_items WHERE quote_id=?').run(quoteId)
        db.prepare('UPDATE quotes SET customer_id=@customerId,quote_no=@quoteNo,mode=@mode,trade_term=@tradeTerm,domestic_freight=@domesticFreight,customs_fee=@customsFee,bank_fee=@bankFee,ocean_freight=@oceanFreight,insurance_fee=@insuranceFee,payment_note=@paymentNote,total_quantity=@totalQuantity,total_amount=@totalAmount,currency=@currency,exchange_rate=@exchangeRate,updated_at=@updatedAt WHERE id=@id').run({ ...data, quoteNo, totalQuantity: calculated.totalQuantity, totalAmount: calculated.totalAmount, updatedAt: now, id: quoteId })
      } else {
        db.prepare('INSERT INTO quotes (id,quote_no,customer_id,mode,trade_term,domestic_freight,customs_fee,bank_fee,ocean_freight,insurance_fee,payment_note,total_quantity,total_amount,currency,exchange_rate,created_at,updated_at) VALUES (@id,@quoteNo,@customerId,@mode,@tradeTerm,@domesticFreight,@customsFee,@bankFee,@oceanFreight,@insuranceFee,@paymentNote,@totalQuantity,@totalAmount,@currency,@exchangeRate,@createdAt,@updatedAt)').run({ id: quoteId, quoteNo, ...data, totalQuantity: calculated.totalQuantity, totalAmount: calculated.totalAmount, createdAt: now, updatedAt: now })
      }
      const stmt = db.prepare('INSERT INTO quote_items (id,quote_id,product_id,quantity,packaging_fee,profit,custom_exw,custom_fob,custom_cif,exw,fob,cif,selected_unit_price,total_price,price_currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      calculated.rows.forEach(({ item, exw, fob, cif, unit, totalPrice }) => stmt.run(id('qi'), quoteId, item.productId, item.quantity, item.packagingFee, item.profit, item.customExw, item.customFob, item.customCif, exw, fob, cif, unit, totalPrice, item.priceCurrency))
    })
    transaction()
    if (!isUpdate) addQuoteFollowUp(data.customerId, quoteNo)
    res.status(isUpdate ? 200 : 201).json(quoteView(db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId)))
  } catch (error) { sendError(res, 400, error.message || '报价单保存失败') }
}
app.post('/api/quotes', (req, res) => saveQuote(req, res, false))
app.put('/api/quotes/:id', (req, res) => saveQuote(req, res, true))

// ===== 单证模板：我的企业 / 模板管理 / 生成单证 =====

// 字段目录：前端映射界面按此分组展示，后端按同一份键解析取值，避免两边字段名漂移
const DOC_FIELDS = [
  { group: '我的企业（卖方）', items: [
    ['company.nameCn', '公司中文名'], ['company.nameEn', '公司英文名'],
    ['company.addressCn', '公司中文地址'], ['company.addressEn', '公司英文地址'],
    ['company.tel', '电话 TEL'], ['company.fax', '传真 FAX'], ['company.email', '邮箱'],
    ['company.website', '网站'], ['company.zip', '邮编'],
    ['company.unifiedCode', '统一社会信用代码'], ['company.customsCode', '报关企业代码'],
    ['company.beneficiaryAccount', '收款账号'], ['company.swiftCode', 'SWIFT'],
    ['company.beneficiaryCountry', '收款国家/地区'], ['company.beneficiaryName', '收款人名称'],
    ['company.beneficiaryAddress', '收款人地址'], ['company.beneficiaryBank', '收款银行'],
    ['company.beneficiaryBankAddress', '收款银行地址'], ['company.bankCode', '银行代码'],
    ['company.branchCode', '分行代码'],
  ] },
  { group: '客户（买方）', items: [
    ['buyer.name', '客户名称'], ['buyer.code', '客户代码'], ['buyer.country', '客户国家'],
    ['buyer.contact', '联系人'], ['buyer.phone', '电话'], ['buyer.email', '邮箱'],
    ['buyer.address', '地址'], ['buyer.zip', '邮编'], ['buyer.fax', '传真'],
  ] },
  { group: '报价单', items: [
    ['quote.quoteNo', '单号 PI号/发票号'], ['quote.date', '日期'], ['quote.tradeTerm', '贸易术语'],
    ['quote.mode', '运输模式'], ['quote.currency', '币种'], ['quote.totalQuantity', '总数量'],
    ['quote.totalAmount', '总金额'], ['quote.amountInWords', '金额大写'],
    ['quote.paymentNote', '付款备注'],
  ] },
  { group: '商品明细（循环行）', items: [
    ['item.index', '项号'], ['item.productName', '品名'], ['item.sku', 'SKU'],
    ['item.model', '型号'], ['item.specification', '规格'], ['item.description', '描述'],
    ['item.quantity', '数量'], ['item.unit', '单位'], ['item.unitPrice', '单价'],
    ['item.totalPrice', '小计'], ['item.tradeTerm', '行贸易术语'],
    // 图片字段单独标记，前端映射界面按「插图」而非写文本处理
    ['item.image', '产品主图（插入图片）'],
  ] },
  { group: '单证补充（弹窗填写）', items: [
    ['doc.from', '起运地'], ['doc.to', '目的地'], ['doc.vessel', '船名/航次'],
    ['doc.marks', '唛头'], ['doc.poNo', 'PO No.'], ['doc.scNo', 'S/C No.'],
    ['doc.loadingDate', '发货时间'], ['doc.countryOfOrigin', '原产国'],
    ['doc.termOfDelivery', '交货与付款条款'], ['doc.remark', '备注'],
  ] },
  { group: '商品明细补充（弹窗填写）', items: [
    ['item.hsCode', '商品编号 HS'], ['item.ctns', '件数 CTNS'],
    ['item.gw', '毛重 G.W.'], ['item.nw', '净重 N.W.'], ['item.cbm', '体积 CBM'],
    ['item.size', '外箱尺寸'],
  ] },
]

const templateUpload = multer({
  storage: multer.diskStorage({
    destination: templateDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.xlsx`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  // 只收 .xlsx：旧版 .xls 无法用 ExcelJS 保留版式写回
  fileFilter: (_req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.xlsx'),
})

const emptyCompany = () => ({ id: 'company', nameCn: '', nameEn: '', addressCn: '', addressEn: '', tel: '', fax: '', email: '', website: '', zip: '', unifiedCode: '', customsCode: '', logo: '', beneficiaryAccount: '', swiftCode: '', beneficiaryCountry: '', beneficiaryName: '', beneficiaryAddress: '', beneficiaryBank: '', beneficiaryBankAddress: '', bankCode: '', branchCode: '', updatedAt: '' })
function companyView(row) {
  if (!row) return emptyCompany()
  return { id: row.id, nameCn: row.name_cn, nameEn: row.name_en, addressCn: row.address_cn, addressEn: row.address_en, tel: row.tel, fax: row.fax, email: row.email, website: row.website, zip: row.zip, unifiedCode: row.unified_code, customsCode: row.customs_code, logo: row.logo, beneficiaryAccount: row.beneficiary_account, swiftCode: row.swift_code, beneficiaryCountry: row.beneficiary_country, beneficiaryName: row.beneficiary_name, beneficiaryAddress: row.beneficiary_address, beneficiaryBank: row.beneficiary_bank, beneficiaryBankAddress: row.beneficiary_bank_address, bankCode: row.bank_code, branchCode: row.branch_code, updatedAt: row.updated_at }
}

app.get('/api/document-fields', (_req, res) => res.json(DOC_FIELDS))
app.get('/api/my-company', (_req, res) => res.json(companyView(db.prepare('SELECT * FROM my_company WHERE id=?').get('company'))))
// 单条记录：不存在则插入，存在则覆盖，id 固定为 company
app.put('/api/my-company', (req, res) => {
  const data = parseBody(myCompanySchema, req.body, res); if (!data) return
  const now = isoDate()
  const row = { id: 'company', name_cn: data.nameCn, name_en: data.nameEn, address_cn: data.addressCn, address_en: data.addressEn, tel: data.tel, fax: data.fax, email: data.email, website: data.website, zip: data.zip, unified_code: data.unifiedCode, customs_code: data.customsCode, logo: data.logo, beneficiary_account: data.beneficiaryAccount, swift_code: data.swiftCode, beneficiary_country: data.beneficiaryCountry, beneficiary_name: data.beneficiaryName, beneficiary_address: data.beneficiaryAddress, beneficiary_bank: data.beneficiaryBank, beneficiary_bank_address: data.beneficiaryBankAddress, bank_code: data.bankCode, branch_code: data.branchCode, updated_at: now }
  if (db.prepare('SELECT id FROM my_company WHERE id=?').get('company')) {
    db.prepare('UPDATE my_company SET name_cn=@name_cn,name_en=@name_en,address_cn=@address_cn,address_en=@address_en,tel=@tel,fax=@fax,email=@email,website=@website,zip=@zip,unified_code=@unified_code,customs_code=@customs_code,logo=@logo,beneficiary_account=@beneficiary_account,swift_code=@swift_code,beneficiary_country=@beneficiary_country,beneficiary_name=@beneficiary_name,beneficiary_address=@beneficiary_address,beneficiary_bank=@beneficiary_bank,beneficiary_bank_address=@beneficiary_bank_address,bank_code=@bank_code,branch_code=@branch_code,updated_at=@updated_at WHERE id=@id').run(row)
  } else {
    db.prepare('INSERT INTO my_company (id,name_cn,name_en,address_cn,address_en,tel,fax,email,website,zip,unified_code,customs_code,logo,beneficiary_account,swift_code,beneficiary_country,beneficiary_name,beneficiary_address,beneficiary_bank,beneficiary_bank_address,bank_code,branch_code,updated_at) VALUES (@id,@name_cn,@name_en,@address_cn,@address_en,@tel,@fax,@email,@website,@zip,@unified_code,@customs_code,@logo,@beneficiary_account,@swift_code,@beneficiary_country,@beneficiary_name,@beneficiary_address,@beneficiary_bank,@beneficiary_bank_address,@bank_code,@branch_code,@updated_at)').run(row)
  }
  res.json(companyView(row))
})

function templateView(row) {
  return { id: row.id, name: row.name, docType: row.doc_type, fileName: row.file_name, mapping: JSON.parse(row.mapping || '{}'), createdAt: row.created_at, updatedAt: row.updated_at }
}
app.get('/api/document-templates', (_req, res) => res.json(db.prepare('SELECT * FROM document_templates ORDER BY updated_at DESC').all().map(templateView)))
app.post('/api/document-templates', templateUpload.single('file'), (req, res) => {
  if (!req.file) return sendError(res, 400, '请上传 .xlsx 格式的模板文件（旧版 .xls 请先另存为 .xlsx）')
  const name = String(req.body.name || req.file.originalname).trim().slice(0, 120) || '未命名模板'
  const docType = ['PI', '报价单', '商业发票', '装箱单', '报关单', '其他'].includes(req.body.docType) ? req.body.docType : 'PI'
  const now = isoDate()
  const row = { id: id('tpl'), name, doc_type: docType, file_path: req.file.filename, file_name: req.file.originalname, mapping: '{}', created_at: now, updated_at: now }
  db.prepare('INSERT INTO document_templates (id,name,doc_type,file_path,file_name,mapping,created_at,updated_at) VALUES (@id,@name,@doc_type,@file_path,@file_name,@mapping,@created_at,@updated_at)').run(row)
  res.status(201).json(templateView(row))
})
app.put('/api/document-templates/:id', (req, res) => {
  const data = parseBody(templateUpdateSchema, req.body, res); if (!data) return
  const current = db.prepare('SELECT * FROM document_templates WHERE id=?').get(req.params.id)
  if (!current) return sendError(res, 404, '模板不存在')
  const next = { ...current, name: data.name ?? current.name, doc_type: data.docType ?? current.doc_type, mapping: data.mapping ? JSON.stringify(data.mapping) : current.mapping, updated_at: isoDate() }
  db.prepare('UPDATE document_templates SET name=@name,doc_type=@doc_type,mapping=@mapping,updated_at=@updated_at WHERE id=@id').run(next)
  res.json(templateView(next))
})
app.delete('/api/document-templates/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM document_templates WHERE id=?').get(req.params.id)
  if (!current) return sendError(res, 404, '模板不存在')
  db.prepare('DELETE FROM document_templates WHERE id=?').run(req.params.id)
  // 删库记录的同时清掉磁盘文件，避免 uploads 越积越多
  fs.promises.unlink(path.join(templateDir, current.file_path)).catch(() => {})
  res.json({ ok: true })
})
// 模板结构：返回每个 sheet 的单元格文本与合并区域，供前端映射界面点选
app.get('/api/document-templates/:id/structure', async (req, res) => {
  const current = db.prepare('SELECT * FROM document_templates WHERE id=?').get(req.params.id)
  if (!current) return sendError(res, 404, '模板不存在')
  try {
    const workbook = await loadWorkbook(path.join(templateDir, current.file_path))
    const sheets = workbook.worksheets.map((ws) => {
      // 合并单元格的文本只认左上角，否则同一段文字会在整块区域出现 N 次，映射时无法判断该点哪个格
      const mergeMap = new Map()
      const merges = []
      ;(ws.model.merges || []).forEach((range) => {
        merges.push(range)
        const parts = range.split(':')
        const start = parts[0]
        const end = parts[1] || parts[0]
        const startCell = worksheetCell(ws, start)
        const endCell = worksheetCell(ws, end)
        if (!startCell || !endCell) return
        mergeMap.set(start, { top: startCell.row, left: startCell.col, bottom: endCell.row, right: endCell.col })
      })
      const isHiddenByMerge = (rowNumber, colNumber) => {
        for (const box of mergeMap.values()) {
          if (box.top === rowNumber && box.left === colNumber) return false
          if (rowNumber >= box.top && rowNumber <= box.bottom && colNumber >= box.left && colNumber <= box.right) return true
        }
        return false
      }
      const cells = []
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          if (isHiddenByMerge(rowNumber, colNumber)) return
          const text = cellText(cell)
          if (text === '') return
          cells.push({ row: rowNumber, col: colNumber, address: cell.address, text })
        })
      })
      return { name: ws.name, rowCount: ws.rowCount, columnCount: ws.columnCount, cells, merges }
    })
    res.json({ sheets })
  } catch (error) { sendError(res, 400, `模板解析失败：${error.message}`) }
})
app.get('/api/document-templates/:id/file', (req, res) => {
  const current = db.prepare('SELECT * FROM document_templates WHERE id=?').get(req.params.id)
  if (!current) return sendError(res, 404, '模板不存在')
  res.download(path.join(templateDir, current.file_path), current.file_name || 'template.xlsx')
})

// 报价单上的单证补充字段（起运地/唛头/HS 等），随单保存，下次导出自动带出
app.get('/api/quotes/:id/document-fields', (req, res) => {
  const row = db.prepare('SELECT fields FROM quote_document_fields WHERE quote_id=?').get(req.params.id)
  res.json(row ? JSON.parse(row.fields) : {})
})
function quoteDocumentFields(quoteId) {
  const row = db.prepare('SELECT fields FROM quote_document_fields WHERE quote_id=?').get(quoteId)
  return row ? JSON.parse(row.fields || '{}') : {}
}

function loadWorkbook(filePath) {
  const ExcelJS = require('exceljs')
  const workbook = new ExcelJS.Workbook()
  return workbook.xlsx.readFile(filePath)
}

// "A1" / "AB12" → { row, col }，服务端不依赖 ExcelJS 的 cell 对象也能算坐标
function worksheetCell(ws, address) {
  const match = /^([A-Z]+)(\d+)$/.exec(String(address).replace(/\$/g, '').toUpperCase())
  if (!match) return null
  let col = 0
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(match[2]), col }
}
function colLetter(index) {
  let s = ''
  let n = index
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26) }
  return s
}

// 单元格取文本：富文本/公式/超链接/日期都归一成字符串，映射界面和填充共用
function cellText(cell) {
  const v = cell.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if (v.richText) return v.richText.map((part) => part.text).join('')
    if ('result' in v) return String(v.result ?? '')
    if ('text' in v) return String(v.text ?? '')
    if ('error' in v) return ''
    return ''
  }
  return String(v)
}

// 金额大写（USD），用于 SAY TOTAL 一行
const DIGITS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN']
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY']
function under1000(n) {
  const out = []
  if (n >= 100) { out.push(`${DIGITS[Math.floor(n / 100)]} HUNDRED`); n %= 100 }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10 }
  if (n > 0) out.push(DIGITS[n])
  return out.join(' ')
}
function amountInWords(amount) {
  const value = Math.floor(Math.abs(Number(amount) || 0))
  const cents = Math.round((Math.abs(Number(amount) || 0) - value) * 100)
  if (!value && !cents) return 'ZERO'
  const parts = []
  const units = [[1e9, 'BILLION'], [1e6, 'MILLION'], [1e3, 'THOUSAND']]
  let rest = value
  for (const [size, label] of units) {
    if (rest >= size) { parts.push(`${under1000(Math.floor(rest / size))} ${label}`); rest %= size }
  }
  if (rest > 0) parts.push(under1000(rest))
  const main = parts.join(' ').replace(/\s+/g, ' ').trim()
  return cents ? `${main} AND CENTS ${under1000(cents)}` : main
}

// 生成单证：读取模板 → 解析映射 → 按明细行数复制行 → 写值 → 返回 xlsx
function buildFieldValues(quote, company, customer, overrides) {
  const rate = quote.currency === 'USD' && quote.exchangeRate > 0 ? quote.exchangeRate : 1
  return {
    'company.nameCn': company.nameCn, 'company.nameEn': company.nameEn,
    'company.addressCn': company.addressCn, 'company.addressEn': company.addressEn,
    'company.tel': company.tel, 'company.fax': company.fax, 'company.email': company.email,
    'company.website': company.website, 'company.zip': company.zip,
    'company.unifiedCode': company.unifiedCode, 'company.customsCode': company.customsCode,
    'company.beneficiaryAccount': company.beneficiaryAccount, 'company.swiftCode': company.swiftCode,
    'company.beneficiaryCountry': company.beneficiaryCountry, 'company.beneficiaryName': company.beneficiaryName,
    'company.beneficiaryAddress': company.beneficiaryAddress, 'company.beneficiaryBank': company.beneficiaryBank,
    'company.beneficiaryBankAddress': company.beneficiaryBankAddress, 'company.bankCode': company.bankCode,
    'company.branchCode': company.branchCode,
    'buyer.name': customer?.name || '', 'buyer.code': customer?.code || '', 'buyer.country': customer?.country || '',
    'buyer.contact': customer?.contact || '', 'buyer.phone': customer?.phone || '', 'buyer.email': customer?.email || '',
    'buyer.address': customer?.address || '', 'buyer.zip': customer?.zip || '', 'buyer.fax': customer?.fax || '',
    'quote.quoteNo': quote.quoteNo, 'quote.date': quote.createdAt, 'quote.tradeTerm': quote.tradeTerm,
    'quote.mode': quote.mode, 'quote.currency': quote.currency,
    'quote.totalQuantity': quote.totalQuantity,
    // 金额统一换算到结算币种展示，与页面预览保持一致
    'quote.totalAmount': Math.round((quote.totalAmount / rate) * 100) / 100,
    'quote.amountInWords': amountInWords(quote.totalAmount / rate),
    'quote.paymentNote': quote.paymentNote || '',
    'doc.from': overrides.from || '', 'doc.to': overrides.to || '', 'doc.vessel': overrides.vessel || '',
    'doc.marks': overrides.marks || '', 'doc.poNo': overrides.poNo || '', 'doc.scNo': overrides.scNo || '',
    'doc.loadingDate': overrides.loadingDate || '', 'doc.countryOfOrigin': overrides.countryOfOrigin || 'CHINA',
    'doc.termOfDelivery': overrides.termOfDelivery || '', 'doc.remark': overrides.remark || '',
  }
}
function itemFieldValues(item, index, rate, overrides) {
  const extra = overrides.items?.[item.productId] || {}
  // 产品库已存单箱参数：总箱数 = 总数量 ÷ 装箱数（向上取整，零头也占一个整箱）
  const packQty = Number(item.packingQuantity) || 0
  const autoCartons = packQty > 0 ? Math.ceil(item.quantity / packQty) : 0
  // 弹窗留空则用产品库默认值；填了则以弹窗为准（允许一单一个例外）
  const unit = extra.unit || item.unit || 'PCS'
  const hsCode = extra.hsCode || item.hsCode || ''
  const cartons = extra.ctns !== undefined && extra.ctns !== '' ? extra.ctns : (autoCartons || '')
  // 毛重/净重/体积按「单箱 × 总箱数」累加，得出整单该行的总量
  const cartonCount = Number(cartons) || 0
  const round2 = (value) => Math.round(value * 100) / 100
  const gw = extra.gw !== undefined && extra.gw !== '' ? extra.gw : (cartonCount && item.cartonGrossWeight ? round2(cartonCount * item.cartonGrossWeight) : '')
  const nw = extra.nw !== undefined && extra.nw !== '' ? extra.nw : (cartonCount && item.cartonNetWeight ? round2(cartonCount * item.cartonNetWeight) : '')
  const cbm = extra.cbm !== undefined && extra.cbm !== '' ? extra.cbm : (cartonCount && item.cartonVolume ? round2(cartonCount * item.cartonVolume) : '')
  const size = extra.size || item.cartonSize || ''
  return {
    'item.index': index + 1,
    'item.productName': item.productName,
    'item.sku': item.sku,
    'item.model': item.model || '',
    'item.specification': item.specification || '',
    'item.description': item.description || '',
    'item.quantity': item.quantity,
    'item.unit': unit,
    'item.unitPrice': Math.round((item.selectedUnitPrice / rate) * 100) / 100,
    'item.totalPrice': Math.round((item.totalPrice / rate) * 100) / 100,
    'item.tradeTerm': item.tradeTerm,
    'item.hsCode': hsCode, 'item.ctns': cartons, 'item.gw': gw,
    'item.nw': nw, 'item.cbm': cbm, 'item.size': size,
  }
}

// 把 /uploads/xxx.png 转成本地路径；只允许 uploads 目录内的文件，挡住 ../ 之类的路径穿越
function resolveUploadPath(url) {
  if (!url || typeof url !== 'string') return null
  if (!url.startsWith('/uploads/')) return null
  const relative = url.slice('/uploads/'.length)
  const absolute = path.resolve(uploadDir, relative)
  // 解析后必须仍在 uploads 目录下，否则视为非法路径
  if (!absolute.startsWith(path.resolve(uploadDir) + path.sep)) return null
  return fs.existsSync(absolute) ? absolute : null
}

// 填充模板：预览与下载共用同一套逻辑，保证"看到的就是导出的"
async function renderTemplate(quoteId, templateId) {
  const quoteRow = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId)
  if (!quoteRow) throw Object.assign(new Error('报价单不存在'), { status: 404 })
  const template = db.prepare('SELECT * FROM document_templates WHERE id=?').get(templateId)
  if (!template) throw Object.assign(new Error('模板不存在'), { status: 404 })
  const mapping = JSON.parse(template.mapping || '{}')
  const quote = quoteView(quoteRow)
  const company = companyView(db.prepare('SELECT * FROM my_company WHERE id=?').get('company'))
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(quoteRow.customer_id)
  const overrides = quoteDocumentFields(quoteId)
  const rate = quote.currency === 'USD' && quote.exchangeRate > 0 ? quote.exchangeRate : 1

  const workbook = await loadWorkbook(path.join(templateDir, template.file_path))
  const worksheet = mapping.sheet ? workbook.getWorksheet(mapping.sheet) : workbook.worksheets[0]
  if (!worksheet) throw Object.assign(new Error('模板中找不到指定工作表'), { status: 400 })

  const values = buildFieldValues(quote, company, customer, overrides)
  // 静态单元格：坐标 → 字段键；也支持块模式（一个格子里多行标签，按行依次填值）
  for (const [address, spec] of Object.entries(mapping.cells || {})) {
    const cell = worksheet.getCell(address)
    if (spec && typeof spec === 'object' && Array.isArray(spec.block)) {
      // 块模式：保留原有标签行，把对应字段的值追加到「标签：」之后，适合银行信息那种整块单元格
      const lines = cellText(cell).split('\n')
      let lineIndex = 0
      const rebuilt = lines.map((line) => {
        if (!line.trim()) return line
        const field = spec.block[lineIndex]
        lineIndex += 1
        if (!field) return line
        const value = values[field]
        if (value === undefined || value === '') return line
        return `${line.trim()} ${value}`
      })
      cell.value = rebuilt.join('\n')
      continue
    }
    const field = typeof spec === 'string' ? spec : spec?.field
    if (!field) continue
    const value = values[field]
    if (value === undefined) continue
    if (value === '') { if (spec?.append) continue; cell.value = null; continue }
    // append：模板格子里原本有标签文字（如 "公司名字 英文"），保留标签并在后面接值
    if (spec?.append) { cell.value = `${cellText(cell).trim()} ${value}`.trim(); continue }
    cell.value = value
  }
  // 明细循环行：先按明细条数复制模板行（保留样式），再逐行写值
  const imageAnchors = []
  if (mapping.items && Number(mapping.items.startRow) > 0) {
    const startRow = Number(mapping.items.startRow)
    const extraRows = quote.items.length - 1
    // duplicateRow 不搬合并区，先记下起始行之后的合并范围，插行后手动下移，否则会盖住新明细行
    const shiftedMerges = []
    if (extraRows !== 0) {
      for (const range of worksheet.model.merges || []) {
        const [start, end = start] = range.split(':')
        const s = worksheetCell(null, start); const e = worksheetCell(null, end)
        if (!s || !e) continue
        // 只处理整体位于明细起始行之后的合并区（明细行自身不合并）
        if (s.row <= startRow) continue
        shiftedMerges.push({ old: range, s, e, shift: extraRows })
      }
      for (const item of shiftedMerges) worksheet.unMergeCells(item.old)
    }
    // duplicateRow 只复制值与样式，不复制图片，所以图片必须在插行之后逐行单独贴
    if (extraRows > 0) worksheet.duplicateRow(startRow, extraRows, true)
    // 合并区按行数偏移重新合并
    for (const item of shiftedMerges) {
      worksheet.mergeCells(
        `${colLetter(item.s.col)}${item.s.row + item.shift}:${colLetter(item.e.col)}${item.e.row + item.shift}`,
      )
    }
    const itemValues = quote.items.map((item, index) => itemFieldValues(item, index, rate, overrides))
    itemValues.forEach((rowValues, index) => {
      const row = worksheet.getRow(startRow + index)
      for (const [col, field] of Object.entries(mapping.items.columns || {})) {
        // 图片字段不写文本，记录下来等所有行确定后再统一插入
        if (field === 'item.image') {
          const product = quote.items[index]
          if (product?.image) imageAnchors.push({ col: Number(col), row: startRow + index, src: product.image })
          continue
        }
        const value = rowValues[field]
        if (value === undefined) continue
        // 映射里的列号以字符串键存储（JSON 限制），ExcelJS 只接受数字下标
        row.getCell(Number(col)).value = value === '' ? null : value
      }
      row.commit()
    })
    // 图片所在行给个最低行高，否则图片会压住下面的内容
    for (const anchor of imageAnchors) {
      const row = worksheet.getRow(anchor.row)
      if (!row.height || row.height < 60) row.height = 60
    }
  }
  // 静态图片字段（如公司 Logo）：坐标写在 cells 里，值固定为 item.image 之外的图片字段
  for (const [address, spec] of Object.entries(mapping.cells || {})) {
    const field = typeof spec === 'string' ? spec : spec?.field
    if (field !== 'company.logo' || !company.logo) continue
    const ref = worksheetCell(null, address)
    if (ref) imageAnchors.push({ col: ref.col, row: ref.row, src: company.logo })
  }
  // 统一插图：addImage 以 0 基行列定位，tl 与 br 配合可让图片撑满整个单元格
  const images = []
  for (const anchor of imageAnchors) {
    const filePath = resolveUploadPath(anchor.src)
    if (!filePath) continue
    const extension = path.extname(filePath).slice(1).toLowerCase()
    if (!['png', 'jpeg', 'jpg', 'gif'].includes(extension)) continue
    try {
      const imageId = workbook.addImage({ filename: filePath, extension: extension === 'jpg' ? 'jpeg' : extension })
      // 用 tl/br 锚到同一个格子，图片会自动贴合单元格大小；单元格宽度未知，靠 br 收缩留白
      worksheet.addImage(imageId, {
        tl: { col: anchor.col - 1 + 0.08, row: anchor.row - 1 + 0.08 },
        br: { col: anchor.col - 0.08, row: anchor.row - 0.08 },
        editAs: 'oneCell',
      })
      images.push({ file: anchor.src })
    } catch (error) { console.warn('[doc] 图片插入失败', anchor.src, String(error)) }
  }
  return { workbook, worksheet, template, quote, startRow: Number(mapping.items?.startRow) || 0, images }
}

// 预览：把填充后的工作表转成二维文本数组返回，前端画成表格；不上传文件也不落盘
app.post('/api/quotes/:id/documents/preview', async (req, res) => {
  const result = z.object({ templateId: text(80).min(1) }).safeParse(req.body)
  if (!result.success) return sendError(res, 400, '请选择模板')
  try {
    const { worksheet, images } = await renderTemplate(req.params.id, result.data.templateId)
    // 预览要跳过合并区域内的非左上角格：Excel 里这些格显示的是左上角内容，逐格取值会重复一遍
    const mergeBoxes = (worksheet.model.merges || []).map((range) => {
      const [start, end = start] = range.split(':')
      const s = worksheetCell(null, start); const e = worksheetCell(null, end)
      return s && e ? { top: s.row, left: s.col, bottom: e.row, right: e.col } : null
    }).filter(Boolean)
    const covered = (row, col) => mergeBoxes.some((box) => (row > box.top || col > box.left) && row >= box.top && row <= box.bottom && col >= box.left && col <= box.right)
    const rows = []
    // 按行号连续输出：纯空行也占位，否则前端按顺序渲染会跟真实行号对不上
    const totalRows = worksheet.rowCount
    const cellByRow = new Map()
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells = []
      let column = 1
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        while (column < colNumber) { cells.push(''); column += 1 }
        cells.push(covered(rowNumber, colNumber) ? '' : cellText(cell))
        column = colNumber + 1
      })
      cellByRow.set(rowNumber, cells)
    })
    for (let rowNumber = 1; rowNumber <= totalRows; rowNumber += 1) {
      const cells = cellByRow.get(rowNumber) || []
      // 补足列数，保证每行等长
      while (cells.length < worksheet.columnCount) cells.push('')
      rows.push({ row: rowNumber, cells })
    }
    // images：预览是文本表格，图片无法呈现，告诉前端哪些位置有图，提示"下载后可查看"
    res.json({ sheet: worksheet.name, columnCount: worksheet.columnCount, rows, merges: worksheet.model.merges || [], imageCount: images.length })
  } catch (error) { sendError(res, error.status || 400, `预览失败：${error.message}`) }
})

app.post('/api/quotes/:id/documents/generate', async (req, res) => {
  const result = z.object({ templateId: text(80).min(1) }).safeParse(req.body)
  if (!result.success) return sendError(res, 400, '请选择模板')
  try {
    const { workbook, template, quote } = await renderTemplate(req.params.id, result.data.templateId)
    const buffer = await workbook.xlsx.writeBuffer()
    const safeName = `${(template.name || 'document').replace(/[\\/:*?"<>|]/g, '_')}_${quote.quoteNo}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`)
    res.send(Buffer.from(buffer))
  } catch (error) { sendError(res, error.status || 400, `单证生成失败：${error.message}`) }
})

// 保存报价单的单证补充字段（弹窗填写的内容）
app.put('/api/quotes/:id/document-fields', (req, res) => {
  const quoteRow = db.prepare('SELECT id FROM quotes WHERE id=?').get(req.params.id)
  if (!quoteRow) return sendError(res, 404, '报价单不存在')
  const result = documentFieldsSchema.safeParse(req.body)
  if (!result.success) return sendError(res, 400, result.error.issues[0]?.message || '字段不合法')
  const json = JSON.stringify(result.data)
  const now = isoDate()
  if (db.prepare('SELECT quote_id FROM quote_document_fields WHERE quote_id=?').get(req.params.id)) {
    db.prepare('UPDATE quote_document_fields SET fields=?, updated_at=? WHERE quote_id=?').run(json, now, req.params.id)
  } else {
    db.prepare('INSERT INTO quote_document_fields (quote_id, fields, updated_at) VALUES (?,?,?)').run(req.params.id, json, now)
  }
  res.json(result.data)
})

// 生产模式：SERVE_STATIC=1 时由后端直接托管前端构建产物，便于单端口部署到外网
if (process.env.SERVE_STATIC === '1') {
  const distDir = path.join(__dirname, '..', 'dist')
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { maxAge: '1h', index: false }))
    // SPA 兜底：非 /api 非 /uploads 的路径一律返回 index.html，刷新子页面才不会 404
    app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')))
    console.info('[static] 已托管前端构建产物', distDir)
  } else {
    console.warn('[static] 未找到 dist 目录，请先执行 npm run build')
  }
}

app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ message: '服务器内部错误' }) })
app.listen(port, () => console.info(`API server listening on http://localhost:${port}`))
