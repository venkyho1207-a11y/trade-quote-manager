const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')

class SqliteAdapter {
  constructor(filename) {
    this.connection = new DatabaseSync(filename)
  }

  exec(sql) {
    return this.connection.exec(sql)
  }

  pragma(sql) {
    return this.connection.exec(`PRAGMA ${sql}`)
  }

  prepare(sql) {
    const statement = this.connection.prepare(sql)
    const bind = (parameters) => {
      if (parameters.length !== 1 || parameters[0] === null || typeof parameters[0] !== 'object' || Array.isArray(parameters[0])) return parameters
      const values = []
      const named = parameters[0]
      const namedSql = sql.replace(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
        values.push(named[name])
        return '?'
      })
      if (namedSql !== sql) {
        return { sql: namedSql, values }
      }
      return parameters
    }
    const execute = (method, parameters) => {
      const bound = bind(parameters)
      if (bound && bound.sql) return this.connection.prepare(bound.sql)[method](...bound.values)
      return statement[method](...bound)
    }
    return {
      all: (...parameters) => execute('all', parameters),
      get: (...parameters) => execute('get', parameters),
      run: (...parameters) => execute('run', parameters),
    }
  }

  transaction(callback) {
    return (...args) => {
      this.exec('BEGIN')
      try {
        const result = callback(...args)
        this.exec('COMMIT')
        return result
      } catch (error) {
        this.exec('ROLLBACK')
        throw error
      }
    }
  }
}

const dataDir = path.join(__dirname, '..', 'data')
fs.mkdirSync(dataDir, { recursive: true })
const db = new SqliteAdapter(path.join(dataDir, 'trade-quote.sqlite'))
db.pragma('foreign_keys = ON')
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL DEFAULT '',
  cost REAL NOT NULL CHECK(cost > 0),
  image TEXT NOT NULL DEFAULT '',
  specification TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  surface_treatment TEXT NOT NULL DEFAULT '',
  moq INTEGER NOT NULL DEFAULT 0,
  packing_quantity INTEGER NOT NULL DEFAULT 0,
  packing_requirement TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'PCS',
  hs_code TEXT NOT NULL DEFAULT '',
  carton_gross_weight REAL NOT NULL DEFAULT 0,
  carton_net_weight REAL NOT NULL DEFAULT 0,
  carton_volume REAL NOT NULL DEFAULT 0,
  carton_size TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_suppliers (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, supplier_id)
);
CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  quote REAL NOT NULL CHECK(quote > 0),
  inquiry_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '新客户',
  country TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT '',
  business TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  salesperson TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  last_follow_up_at TEXT,
  next_follow_up_at TEXT,
  followup_stage INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_follow_ups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  followed_at TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  quote_no TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(mode IN ('散货', '整柜')),
  trade_term TEXT NOT NULL CHECK(trade_term IN ('EXW', 'FOB', 'CIF')),
  domestic_freight REAL NOT NULL DEFAULT 0,
  customs_fee REAL NOT NULL DEFAULT 0,
  bank_fee REAL NOT NULL DEFAULT 0,
  ocean_freight REAL NOT NULL DEFAULT 0,
  insurance_fee REAL NOT NULL DEFAULT 0,
  payment_note TEXT NOT NULL DEFAULT '',
  total_quantity INTEGER NOT NULL,
  total_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  exchange_rate REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT '待发送',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  packaging_fee REAL NOT NULL CHECK(packaging_fee >= 0),
  profit REAL NOT NULL CHECK(profit >= 0),
  custom_exw REAL,
  custom_fob REAL,
  custom_cif REAL,
  exw REAL NOT NULL DEFAULT 0,
  fob REAL NOT NULL DEFAULT 0,
  cif REAL NOT NULL DEFAULT 0,
  selected_unit_price REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  price_currency TEXT NOT NULL DEFAULT 'CNY'
);
CREATE TABLE IF NOT EXISTS exchange_rates (
  id TEXT PRIMARY KEY,
  rate REAL NOT NULL CHECK(rate > 0),
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
-- 我的企业：单条记录（id 固定为 'company'），存卖方抬头与银行收款信息
CREATE TABLE IF NOT EXISTS my_company (
  id TEXT PRIMARY KEY,
  name_cn TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  address_cn TEXT NOT NULL DEFAULT '',
  address_en TEXT NOT NULL DEFAULT '',
  tel TEXT NOT NULL DEFAULT '',
  fax TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  unified_code TEXT NOT NULL DEFAULT '',
  customs_code TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  beneficiary_account TEXT NOT NULL DEFAULT '',
  swift_code TEXT NOT NULL DEFAULT '',
  beneficiary_country TEXT NOT NULL DEFAULT '',
  beneficiary_name TEXT NOT NULL DEFAULT '',
  beneficiary_address TEXT NOT NULL DEFAULT '',
  beneficiary_bank TEXT NOT NULL DEFAULT '',
  beneficiary_bank_address TEXT NOT NULL DEFAULT '',
  bank_code TEXT NOT NULL DEFAULT '',
  branch_code TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
-- 单证模板：上传的 xlsx 原件路径 + 字段映射 JSON（单元格坐标 → 字段键）
CREATE TABLE IF NOT EXISTS document_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'PI',
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  mapping TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 报价单上的单证补充字段：起运地、唛头、PO号等非固定项，随单保存供下次复用
CREATE TABLE IF NOT EXISTS quote_document_fields (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id) ON DELETE CASCADE,
  fields TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
-- 登录账号：只存 scrypt 哈希与盐，never 存明文
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 会话：token 只存哈希，库里泄漏也拿不到可用凭证
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
`)

// 兼容旧库：products 表新增的列若不存在则补上，避免旧数据报错
const productColumns = db.prepare('PRAGMA table_info(products)').all().map((column) => column.name)
for (const [name, definition] of [
  ['model', "TEXT NOT NULL DEFAULT ''"],
  ['description', "TEXT NOT NULL DEFAULT ''"],
  ['surface_treatment', "TEXT NOT NULL DEFAULT ''"],
  ['moq', 'INTEGER NOT NULL DEFAULT 0'],
  ['packing_quantity', 'INTEGER NOT NULL DEFAULT 0'],
  ['packing_requirement', "TEXT NOT NULL DEFAULT ''"],
  // 单证用：产品单位、HS 编码、单箱毛净重/体积/尺寸（总箱数由 总数量÷装箱数 推算）
  ['unit', "TEXT NOT NULL DEFAULT 'PCS'"],
  ['hs_code', "TEXT NOT NULL DEFAULT ''"],
  ['carton_gross_weight', 'REAL NOT NULL DEFAULT 0'],
  ['carton_net_weight', 'REAL NOT NULL DEFAULT 0'],
  ['carton_volume', 'REAL NOT NULL DEFAULT 0'],
  ['carton_size', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (!productColumns.includes(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`)
}

// 兼容旧库：suppliers 表新增 position/phone 列
const supplierColumns = db.prepare('PRAGMA table_info(suppliers)').all().map((column) => column.name)
for (const [name, definition] of [
  ['position', "TEXT NOT NULL DEFAULT ''"],
  ['phone', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (!supplierColumns.includes(name)) db.exec(`ALTER TABLE suppliers ADD COLUMN ${name} ${definition}`)
}

// 兼容旧库：customers 表扩展的列若不存在则补上，避免旧数据报错
const customerColumns = db.prepare('PRAGMA table_info(customers)').all().map((column) => column.name)
for (const [name, definition] of [
  ['code', "TEXT NOT NULL DEFAULT ''"],
  ['type', "TEXT NOT NULL DEFAULT '新客户'"],
  ['timezone', "TEXT NOT NULL DEFAULT ''"],
  ['business', "TEXT NOT NULL DEFAULT ''"],
  ['website', "TEXT NOT NULL DEFAULT ''"],
  ['phone', "TEXT NOT NULL DEFAULT ''"],
  ['salesperson', "TEXT NOT NULL DEFAULT ''"],
  ['last_follow_up_at', 'TEXT'],
  ['next_follow_up_at', 'TEXT'],
  ['followup_stage', 'INTEGER NOT NULL DEFAULT 0'],
  // 单证模板需要买家邮编与传真
  ['zip', "TEXT NOT NULL DEFAULT ''"],
  ['fax', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (!customerColumns.includes(name)) db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${definition}`)
}

// 兼容旧库：quotes 表新增币种/汇率/状态列
const quoteColumns = db.prepare('PRAGMA table_info(quotes)').all().map((column) => column.name)
for (const [name, definition] of [
  ['currency', "TEXT NOT NULL DEFAULT 'CNY'"],
  ['exchange_rate', 'REAL NOT NULL DEFAULT 1'],
  ['status', "TEXT NOT NULL DEFAULT '待发送'"],
]) {
  if (!quoteColumns.includes(name)) db.exec(`ALTER TABLE quotes ADD COLUMN ${name} ${definition}`)
}

// 兼容旧库：quote_items 表新增行币种列
const quoteItemColumns = db.prepare('PRAGMA table_info(quote_items)').all().map((column) => column.name)
if (!quoteItemColumns.includes('price_currency')) db.exec("ALTER TABLE quote_items ADD COLUMN price_currency TEXT NOT NULL DEFAULT 'CNY'")

function isoDate() { return new Date().toISOString().slice(0, 10) }
function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

const productCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count
if (!productCount) {
  const insertProduct = db.prepare('INSERT INTO products (id,name,sku,model,cost,image,specification,description,surface_treatment,moq,packing_quantity,packing_requirement,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insertSupplier = db.prepare('INSERT INTO suppliers (id,name,contact,position,whatsapp,phone,email,address,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const insertCustomer = db.prepare('INSERT INTO customers (id,code,name,type,country,timezone,business,website,contact,phone,address,email,salesperson,note,last_follow_up_at,next_follow_up_at,followup_stage,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insertInquiry = db.prepare('INSERT INTO inquiries (id,product_id,supplier_id,quote,inquiry_date,note) VALUES (?,?,?,?,?,?)')
  const seed = db.transaction(() => {
    const supplierA = id('sup'); const supplierB = id('sup')
    insertSupplier.run(supplierA, '宁波远航箱包', '王经理', '销售经理', '+86 13800001111', '0574-88886666', 'sales@yuanhang.example', '浙江宁波', '可做定制包装', isoDate())
    insertSupplier.run(supplierB, '东莞优品硅胶', '陈先生', '业务主管', '+86 13900002222', '0769-22223333', 'hello@up-silicone.example', '广东东莞', '', isoDate())
    const productA = id('prod'); const productB = id('prod')
    insertProduct.run(productA, '高密度防水旅行袋', 'TRAVEL-BAG-01', 'TB-01', 18.5, '', '600D 牛津布 / 45×30×22cm / 黑色', '高密度防水旅行袋，适合户外出行', '防泼水涂层', 500, 50, '单个PE袋+外箱', '可按客户要求定制LOGO', isoDate(), isoDate())
    insertProduct.run(productB, '便携式硅胶折叠水杯', 'CUP-SILICONE-02', 'CUP-02', 6.8, '', '食品级硅胶 / 350ml / 多色可选', '便携折叠水杯，食品级硅胶材质', '食品级', 1000, 100, '单个OPP袋', '通过LFGB认证', isoDate(), isoDate())
    insertInquiry.run(id('inq'), productA, supplierA, 18.5, isoDate(), '含普通包装')
    insertInquiry.run(id('inq'), productB, supplierB, 6.8, isoDate(), '')
    insertCustomer.run(id('cus'), 'CUS-001', 'Nordic Home AB', '重潜在客户', '瑞典', 'UTC+1', '家居用品进口', 'https://nordic-home.example', 'Anna Andersson', '+46 8 555 1234', 'Stockholm, Sweden', 'anna@nordic-home.example', '张伟', '偏好CIF报价', isoDate(), isoDate(), 0, isoDate())
  })
  seed()
}

module.exports = { db, id, isoDate }
