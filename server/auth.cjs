'use strict'
// 单账号认证：scrypt 加盐哈希 + 随机会话 token。
// 只存 token 的 SHA-256，数据库泄漏也拿不到能直接用的凭证。
const crypto = require('node:crypto')
const { db, id, isoDate } = require('./db.cjs')

const SESSION_COOKIE = 'trade_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天；本地单用户，够用且不至于天天重登

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// 用 timingSafeEqual 比较，避免按字节提前返回暴露长度/前缀信息
function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function createUser(username, password, displayName = '') {
  const salt = crypto.randomBytes(32).toString('hex')
  const now = isoDate()
  const row = { id: id('user'), username, password_hash: hashPassword(password, salt), password_salt: salt, display_name: displayName, created_at: now, updated_at: now }
  db.prepare('INSERT INTO users (id,username,password_hash,password_salt,display_name,created_at,updated_at) VALUES (@id,@username,@password_hash,@password_salt,@display_name,@created_at,@updated_at)').run(row)
  return row
}

function verifyPassword(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username)
  if (!user) {
    // 用户不存在也跑一次 scrypt，避免靠响应时间判断账号是否存在
    hashPassword(password, 'dummy-salt-for-timing')
    return null
  }
  const candidate = hashPassword(password, user.password_salt)
  return safeEqual(candidate, user.password_hash) ? user : null
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run(id('sess'), userId, hashToken(token), now + SESSION_TTL_MS, isoDate())
  // 顺手清掉过期会话，免得表无限增长
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
  return token
}

function findSession(token) {
  if (!token) return null
  const row = db.prepare('SELECT s.*, u.username, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(hashToken(token))
  if (!row) return null
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(row.id)
    return null
  }
  return row
}

function destroySession(token) {
  if (!token) return
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token))
}

function setSessionCookie(res, token) {
  // httpOnly 挡 XSS 读取；sameSite=lax 挡大多数 CSRF；secure 只在 HTTPS 下加，
  // 否则本地 http 开发环境浏览器会直接丢弃 cookie
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`]
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function parseCookies(header = '') {
  const out = {}
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}
function tokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || ''
}

// 登录失败节流：同一 IP 连续失败会短暂锁住，挡住暴力猜测
const attempts = new Map()
const MAX_ATTEMPTS = 5
const LOCK_MS = 5 * 60 * 1000
function tooManyAttempts(key) {
  const entry = attempts.get(key)
  if (!entry) return false
  if (Date.now() - entry.first > LOCK_MS) { attempts.delete(key); return false }
  return entry.count >= MAX_ATTEMPTS
}
function recordFailure(key) {
  const entry = attempts.get(key)
  if (!entry || Date.now() - entry.first > LOCK_MS) attempts.set(key, { count: 1, first: Date.now() })
  else entry.count += 1
}
function clearAttempts(key) { attempts.delete(key) }

function userCount() { return db.prepare('SELECT COUNT(*) AS count FROM users').get().count }
function publicUser(row) { return { id: row.id, username: row.username, displayName: row.display_name } }

module.exports = {
  SESSION_COOKIE, userCount, createUser, verifyPassword, createSession, findSession,
  destroySession, setSessionCookie, clearSessionCookie, tokenFromRequest,
  tooManyAttempts, recordFailure, clearAttempts, publicUser, hashPassword,
}
