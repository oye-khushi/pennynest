import { Hono } from 'hono'
import type { AppEnv, SessionUser } from './types'
import {
  hashPin,
  isValidEmail,
  isValidPin,
  newSessionToken,
  normalizeEmail,
  randomHex,
  safeEqual,
  sha256Hex
} from './auth'
import { DEFAULT_BUDGETS, ADMIN_EMAIL, isProtectedEmail } from './db'
import { csvResponse, stamp } from './csv'

export const api = new Hono<AppEnv>()

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const fail = (status: number, message: string) => {
  throw new HttpError(status, message)
}

type UserRow = {
  id: number
  email: string
  name: string
  role: string
  avatar: string
  theme: string
  pin_hash: string
  pin_salt: string
  created_at: string
  last_login_at: string | null
}

/** Never leak pin_hash / pin_salt to clients. */
function publicUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    avatar: row.avatar || '🐼',
    theme: row.theme || 'matcha',
    created_at: row.created_at
  }
}

const USER_PUBLIC_COLS = 'id, email, name, role, avatar, theme, created_at, last_login_at'

async function readJson<T = Record<string, unknown>>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    const body = await c.req.json()
    if (!body || typeof body !== 'object') fail(400, 'Request body must be a JSON object.')
    return body as T
  } catch (e) {
    if (e instanceof HttpError) throw e
    fail(400, 'Invalid JSON body.')
  }
}

function toNumber(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) fail(400, `${field} must be a number.`)
  return n
}

function toPositive(value: unknown, field: string): number {
  const n = toNumber(value, field)
  if (n <= 0) fail(400, `${field} must be greater than zero.`)
  return n
}

const clampStr = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max)

function isoDay(value: unknown): string {
  const s = String(value ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10)
}

/* ------------------------------------------------------------------ */
/* auth middleware                                                     */
/* ------------------------------------------------------------------ */

const MAX_AVATAR_CHARS = 400_000 // base64 data URLs for uploaded photos

api.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  const isPublic =
    path === '/api/health' ||
    path === '/api/auth/register' ||
    path === '/api/auth/login' ||
    path === '/api/auth/logout'

  if (isPublic) return next()

  const header = c.req.header('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) fail(401, 'Please sign in to continue.')

  const tokenHash = await sha256Hex(token)
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.avatar, u.theme, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first<SessionUser & { created_at: string }>()

  if (!row) fail(401, 'Your session has expired. Please sign in again.')

  const user: SessionUser = {
    id: row.id,
    email: row.email,
    name: row.name || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    avatar: row.avatar || '🐼',
    theme: row.theme || 'matcha',
    created_at: row.created_at
  }

  c.set('user', user)
  c.env.DB.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ?")
    .bind(tokenHash)
    .run()
    .catch(() => {})

  await next()
})

function requireAdmin(c: { get: (k: 'user') => SessionUser }) {
  const user = c.get('user')
  if (user.role !== 'admin') fail(403, 'Admin access required.')
  return user
}

/* ------------------------------------------------------------------ */
/* health + auth                                                       */
/* ------------------------------------------------------------------ */

api.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  return c.json({ ok: true, users: row?.n ?? 0, time: new Date().toISOString() })
})

async function issueSession(db: D1Database, userId: number) {
  const { token, tokenHash } = await newSessionToken()
  await db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)').bind(tokenHash, userId).run()
  await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(userId).run()
  return token
}

api.post('/api/auth/register', async (c) => {
  const body = await readJson<{ name?: string; email?: string; pin?: string }>(c)
  const name = clampStr(body.name, 80)
  const email = normalizeEmail(body.email)
  const pin = String(body.pin ?? '').trim()

  if (!name) fail(400, 'Please enter your name.')
  if (!isValidEmail(email)) fail(400, 'Please enter a valid email address.')
  if (!isValidPin(pin)) fail(400, 'Your passcode must be exactly 4 digits.')
  if (email === ADMIN_EMAIL) {
    fail(409, 'This email address is reserved. Please sign in instead of registering.')
  }

  const already = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (already) fail(409, 'An account with this email already exists. Please log in.')

  const salt = randomHex(16)
  const pinHash = await hashPin(pin, salt)

  // Public registration can only ever create role 'user'. Admin is server-decided only.
  const inserted = await c.env.DB.prepare(
    `INSERT INTO users (email, name, role, avatar, theme, pin_hash, pin_salt)
     VALUES (?, ?, 'user', '🐼', 'matcha', ?, ?)
     RETURNING ${USER_PUBLIC_COLS}`
  )
    .bind(email, name, pinHash, salt)
    .first<UserRow>()

  if (!inserted) fail(500, 'Could not create your account. Please try again.')

  // Seed default budgets so a new account starts with the same experience as before.
  const stmts = Object.entries(DEFAULT_BUDGETS).map(([cat, limit]) =>
    c.env.DB.prepare('INSERT OR IGNORE INTO budgets (user_id, category, monthly_limit) VALUES (?, ?, ?)').bind(
      inserted.id,
      cat,
      limit
    )
  )
  if (stmts.length) await c.env.DB.batch(stmts)

  const token = await issueSession(c.env.DB, inserted.id)
  return c.json({ token, user: publicUser(inserted) }, 201)
})

api.post('/api/auth/login', async (c) => {
  const body = await readJson<{ email?: string; pin?: string }>(c)
  const email = normalizeEmail(body.email)
  const pin = String(body.pin ?? '').trim()

  if (!isValidEmail(email)) fail(400, 'Please enter a valid email address.')
  if (!isValidPin(pin)) fail(400, 'Your passcode must be exactly 4 digits.')

  const row = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>()
  if (!row) fail(401, 'No account found with that email address.')

  const candidate = await hashPin(pin, row!.pin_salt)
  if (!safeEqual(candidate, row!.pin_hash)) fail(401, "That 4-digit passcode doesn't match.")

  // Permissions are decided by the server on every login.
  if (email === ADMIN_EMAIL && row!.role !== 'admin') {
    await c.env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(row!.id).run()
    row!.role = 'admin'
  }

  const token = await issueSession(c.env.DB, row!.id)
  return c.json({ token, user: publicUser(row!) })
})

api.post('/api/auth/logout', async (c) => {
  const header = c.req.header('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (token) {
    const tokenHash = await sha256Hex(token)
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
  }
  return c.json({ ok: true })
})

api.get('/api/auth/me', (c) => c.json({ user: c.get('user') }))

/* ------------------------------------------------------------------ */
/* user profile                                                        */
/* ------------------------------------------------------------------ */

api.post('/api/me/avatar', async (c) => {
  const user = c.get('user')
  const body = await readJson<{ avatar?: string }>(c)
  const avatar = String(body.avatar ?? '').trim()
  if (!avatar || avatar.length > MAX_AVATAR_CHARS) fail(400, 'That image is too large or empty.')
  await c.env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(avatar, user.id).run()
  return c.json({ ok: true, avatar })
})

api.post('/api/me/pin', async (c) => {
  const user = c.get('user')
  const body = await readJson<{ currentPin?: string; newPin?: string }>(c)
  const currentPin = String(body.currentPin ?? '').trim()
  const newPin = String(body.newPin ?? '').trim()
  if (!isValidPin(currentPin)) fail(400, 'Please enter your current 4-digit passcode.')
  if (!isValidPin(newPin)) fail(400, 'Your new passcode must be exactly 4 digits.')
  if (newPin === '0000') fail(400, 'Please choose a less predictable passcode.')

  const row = await c.env.DB.prepare('SELECT pin_hash, pin_salt FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ pin_hash: string; pin_salt: string }>()
  if (!row) fail(404, 'Profile not found.')

  const candidate = await hashPin(currentPin, row!.pin_salt)
  if (!safeEqual(candidate, row!.pin_hash)) fail(401, 'Your current passcode is incorrect.')

  const salt = randomHex(16)
  const pinHash = await hashPin(newPin, salt)
  await c.env.DB.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').bind(pinHash, salt, user.id).run()
  return c.json({ ok: true })
})

api.post('/api/me/theme', async (c) => {
  const user = c.get('user')
  const body = await readJson<{ theme?: string }>(c)
  const theme = ['matcha', 'sakura', 'sky'].includes(String(body.theme)) ? String(body.theme) : 'matcha'
  await c.env.DB.prepare('UPDATE users SET theme = ? WHERE id = ?').bind(theme, user.id).run()
  return c.json({ ok: true, theme })
})

/** Privacy-safe directory search used by the Cozy Nest member picker. */
api.get('/api/users/search', async (c) => {
  const user = c.get('user')
  const q = normalizeEmail(c.req.query('q') || '').slice(0, 80)
  if (!q) return c.json({ users: [] })
  const like = `%${q}%`
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, avatar FROM users
      WHERE (email LIKE ? OR lower(name) LIKE ?) AND id != ?
      ORDER BY email LIMIT 12`
  )
    .bind(like, like, user.id)
    .all<{ id: number; email: string; avatar: string }>()
  return c.json({ users: results ?? [] })
})

/* ------------------------------------------------------------------ */
/* transactions                                                        */
/* ------------------------------------------------------------------ */

const mapTx = (r: Record<string, unknown>) => ({
  id: Number(r.id),
  title: String(r.title),
  amount: Number(r.amount),
  type: String(r.type),
  category: String(r.category),
  date: String(r.date),
  isSample: Number(r.is_sample) === 1,
  sampleDay: r.sample_day ? String(r.sample_day) : undefined
})

api.get('/api/transactions', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC'
  )
    .bind(user.id)
    .all()
  return c.json({ transactions: (results ?? []).map(mapTx) })
})

api.post('/api/transactions', async (c) => {
  const user = c.get('user')
  const body = await readJson<Record<string, unknown>>(c)
  const title = clampStr(body.title, 140)
  const amount = toPositive(body.amount, 'amount')
  const type = body.type === 'income' ? 'income' : 'expense'
  const category = clampStr(body.category, 40) || 'Food'
  const date = isoDay(body.date)
  const isSample = body.isSample ? 1 : 0
  const sampleDay = body.sampleDay ? String(body.sampleDay).slice(0, 2) : null

  if (!title) fail(400, 'Please enter a description.')

  const row = await c.env.DB.prepare(
    `INSERT INTO transactions (user_id, title, amount, type, category, date, is_sample, sample_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(user.id, title, amount, type, category, date, isSample, sampleDay)
    .first()
  return c.json({ transaction: mapTx(row as Record<string, unknown>) }, 201)
})

api.post('/api/transactions/bulk', async (c) => {
  const user = c.get('user')
  const body = await readJson<{ transactions?: unknown }>(c)
  const list = Array.isArray(body.transactions) ? body.transactions.slice(0, 200) : []
  const stmts = list.map((raw) => {
    const t = raw as Record<string, unknown>
    return c.env.DB.prepare(
      `INSERT INTO transactions (user_id, title, amount, type, category, date, is_sample, sample_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.id,
      clampStr(t.title, 140) || 'Sample entry',
      Number(t.amount) || 0,
      t.type === 'income' ? 'income' : 'expense',
      clampStr(t.category, 40) || 'Food',
      isoDay(t.date),
      t.isSample ? 1 : 0,
      t.sampleDay ? String(t.sampleDay).slice(0, 2) : null
    )
  })
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({ ok: true, inserted: stmts.length }, 201)
})

api.delete('/api/transactions/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const res = await c.env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').bind(id, user.id).run()
  if (!res.meta.changes) fail(404, 'Transaction not found.')
  return c.json({ ok: true })
})

api.delete('/api/transactions', async (c) => {
  const user = c.get('user')
  await c.env.DB.prepare('DELETE FROM transactions WHERE user_id = ?').bind(user.id).run()
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* budgets                                                             */
/* ------------------------------------------------------------------ */

api.get('/api/budgets', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare('SELECT category, monthly_limit FROM budgets WHERE user_id = ?')
    .bind(user.id)
    .all<{ category: string; monthly_limit: number }>()
  const budgets: Record<string, number> = {}
  for (const r of results ?? []) budgets[r.category] = Number(r.monthly_limit)
  return c.json({ budgets })
})

api.put('/api/budgets', async (c) => {
  const user = c.get('user')
  const body = await readJson<{ category?: string; limit?: unknown }>(c)
  const category = clampStr(body.category, 40)
  if (!category) fail(400, 'Please choose a category.')
  const limit = toPositive(body.limit, 'limit')
  await c.env.DB.prepare(
    `INSERT INTO budgets (user_id, category, monthly_limit) VALUES (?, ?, ?)
     ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
  )
    .bind(user.id, category, limit)
    .run()
  return c.json({ ok: true })
})

api.delete('/api/budgets/:category', async (c) => {
  const user = c.get('user')
  const category = decodeURIComponent(c.req.param('category'))
  await c.env.DB.prepare('DELETE FROM budgets WHERE user_id = ? AND category = ?').bind(user.id, category).run()
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* goals                                                               */
/* ------------------------------------------------------------------ */

const mapGoal = (r: Record<string, unknown>) => ({
  id: Number(r.id),
  title: String(r.title),
  target: Number(r.target),
  saved: Number(r.saved),
  createdAt: r.created_at ? String(r.created_at) : undefined,
  completedAt: r.completed_at ? String(r.completed_at) : undefined
})

api.get('/api/goals', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id ASC')
    .bind(user.id)
    .all()
  return c.json({ goals: (results ?? []).map(mapGoal) })
})

api.post('/api/goals', async (c) => {
  const user = c.get('user')
  const body = await readJson<Record<string, unknown>>(c)
  const title = clampStr(body.title, 140)
  const target = toPositive(body.target, 'target')
  const saved = Math.max(0, toNumber(body.saved ?? 0, 'saved'))
  if (!title) fail(400, 'Please enter a goal title.')
  const completedAt = saved >= target ? new Date().toISOString() : null

  const row = await c.env.DB.prepare(
    `INSERT INTO goals (user_id, title, target, saved, completed_at) VALUES (?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(user.id, title, target, Math.min(saved, target), completedAt)
    .first()
  return c.json({ goal: mapGoal(row as Record<string, unknown>) }, 201)
})

api.post('/api/goals/:id/deposit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await readJson<{ amount?: unknown }>(c)
  const amount = toPositive(body.amount, 'amount')

  const goal = await c.env.DB.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<Record<string, unknown>>()
  if (!goal) fail(404, 'Goal not found.')

  const target = Number(goal!.target)
  const before = Number(goal!.saved)
  const after = Math.min(target, before + amount)
  const completedAt =
    goal!.completed_at ?? (before < target && after >= target ? new Date().toISOString() : null)

  await c.env.DB.prepare('UPDATE goals SET saved = ?, completed_at = ? WHERE id = ? AND user_id = ?')
    .bind(after, completedAt, id, user.id)
    .run()

  return c.json({ ok: true, goal: { ...mapGoal(goal!), saved: after, completedAt: completedAt ?? undefined } })
})

api.delete('/api/goals/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const res = await c.env.DB.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').bind(id, user.id).run()
  if (!res.meta.changes) fail(404, 'Goal not found.')
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* cozy nests                                                          */
/* ------------------------------------------------------------------ */

type NestRow = {
  id: number
  owner_id: number
  title: string
  target: number
  saved: number
  created_at: string
  completed_at: string | null
}

/** Full nest payload in the shape the frontend already renders. */
async function loadNests(db: D1Database, nestIds: number[]) {
  if (!nestIds.length) return []
  const placeholders = nestIds.map(() => '?').join(',')

  const [nestsRes, membersRes, contribsRes, messagesRes] = await Promise.all([
    db.prepare(`SELECT * FROM cozy_nests WHERE id IN (${placeholders}) ORDER BY id DESC`).bind(...nestIds).all<NestRow>(),
    db
      .prepare(
        `SELECT nm.nest_id, u.email, u.avatar FROM nest_members nm JOIN users u ON u.id = nm.user_id
          WHERE nm.nest_id IN (${placeholders}) ORDER BY nm.joined_at ASC`
      )
      .bind(...nestIds)
      .all<{ nest_id: number; email: string; avatar: string }>(),
    db
      .prepare(
        `SELECT nc.nest_id, nc.amount, nc.created_at, u.email FROM nest_contributions nc
           JOIN users u ON u.id = nc.user_id WHERE nc.nest_id IN (${placeholders}) ORDER BY nc.id ASC`
      )
      .bind(...nestIds)
      .all<{ nest_id: number; amount: number; created_at: string; email: string }>(),
    db
      .prepare(
        `SELECT m.nest_id, m.body, m.sender_label, m.created_at, u.email FROM nest_messages m
           LEFT JOIN users u ON u.id = m.user_id WHERE m.nest_id IN (${placeholders}) ORDER BY m.id ASC`
      )
      .bind(...nestIds)
      .all<{ nest_id: number; body: string; sender_label: string; created_at: string; email: string | null }>()
  ])

  const byId = new Map<number, any>()
  for (const n of nestsRes.results ?? []) {
    byId.set(n.id, {
      id: n.id,
      title: n.title,
      target: Number(n.target),
      saved: Number(n.saved),
      createdAt: n.created_at,
      completedAt: n.completed_at,
      ownerId: n.owner_id,
      members: [] as string[],
      memberAvatars: {} as Record<string, string>,
      contributions: [] as { email: string; amount: number; at: string }[],
      messages: [] as { senderEmail: string; senderName: string; text: string }[]
    })
  }
  for (const m of membersRes.results ?? []) {
    const nest = byId.get(m.nest_id)
    if (!nest) continue
    nest.members.push(m.email)
    nest.memberAvatars[m.email] = m.avatar || '🐼'
  }
  for (const c of contribsRes.results ?? [])
    byId.get(c.nest_id)?.contributions.push({ email: c.email, amount: Number(c.amount), at: c.created_at })
  for (const m of messagesRes.results ?? [])
    byId.get(m.nest_id)?.messages.push({
      senderEmail: m.email || 'system',
      senderName: m.sender_label || 'Member',
      text: m.body
    })

  return [...byId.values()]
}

async function nestIdsForUser(db: D1Database, userId: number): Promise<number[]> {
  const { results } = await db
    .prepare('SELECT nest_id FROM nest_members WHERE user_id = ?')
    .bind(userId)
    .all<{ nest_id: number }>()
  return (results ?? []).map((r) => r.nest_id)
}

async function requireMembership(db: D1Database, nestId: number, userId: number) {
  const row = await db
    .prepare('SELECT 1 AS ok FROM nest_members WHERE nest_id = ? AND user_id = ?')
    .bind(nestId, userId)
    .first()
  if (!row) fail(403, 'You are not a member of this Cozy Nest.')
}

api.get('/api/nests', async (c) => {
  const user = c.get('user')
  const ids = await nestIdsForUser(c.env.DB, user.id)
  return c.json({ nests: await loadNests(c.env.DB, ids) })
})

api.post('/api/nests', async (c) => {
  const user = c.get('user')
  const body = await readJson<{ title?: string; target?: unknown; members?: unknown }>(c)
  const title = clampStr(body.title, 120)
  const target = toPositive(body.target, 'target')
  if (!title) fail(400, 'Please name your Cozy Nest.')

  const emails = Array.isArray(body.members)
    ? [...new Set([user.email, ...body.members.map((e) => normalizeEmail(e))])].slice(0, 30)
    : [user.email]

  const nest = await c.env.DB.prepare(
    `INSERT INTO cozy_nests (owner_id, title, target, saved) VALUES (?, ?, ?, 0) RETURNING *`
  )
    .bind(user.id, title, target)
    .first<NestRow>()
  if (!nest) fail(500, 'Could not create the Cozy Nest.')

  const memberRows: { id: number; email: string }[] = []
  for (const email of emails) {
    const u = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first<{ id: number; email: string }>()
    if (u) memberRows.push(u)
  }
  if (!memberRows.some((m) => m.id === user.id)) memberRows.push({ id: user.id, email: user.email })

  await c.env.DB.batch([
    ...memberRows.map((m) =>
      c.env.DB.prepare('INSERT OR IGNORE INTO nest_members (nest_id, user_id) VALUES (?, ?)').bind(nest!.id, m.id)
    ),
    c.env.DB.prepare(
      "INSERT INTO nest_messages (nest_id, user_id, sender_label, body) VALUES (?, NULL, 'Penny Piggy 🐷', ?)"
    ).bind(
      nest!.id,
      `Welcome to "${title}"! Contribute any amount toward your ${target.toLocaleString()} BDT goal and chat with your nest mates! 🪺`
    )
  ])

  const [created] = await loadNests(c.env.DB, [nest.id])
  return c.json({ nest: created }, 201)
})

api.post('/api/nests/:id/contribute', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await readJson<{ amount?: unknown }>(c)
  const amount = toPositive(body.amount, 'amount')
  await requireMembership(c.env.DB, id, user.id)

  const nest = await c.env.DB.prepare('SELECT * FROM cozy_nests WHERE id = ?').bind(id).first<NestRow>()
  if (!nest) fail(404, 'Cozy Nest not found.')
  if (nest!.completed_at) fail(409, 'This Cozy Nest goal is already complete.')

  const target = Number(nest!.target)
  const before = Number(nest!.saved)
  const after = Math.min(target, before + amount)
  const contributed = after - before
  const completedAt = before < target && after >= target ? new Date().toISOString() : null

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE cozy_nests SET saved = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?').bind(
      after,
      completedAt,
      id
    ),
    c.env.DB.prepare('INSERT INTO nest_contributions (nest_id, user_id, amount) VALUES (?, ?, ?)').bind(
      id,
      user.id,
      contributed
    ),
    c.env.DB.prepare(
      "INSERT INTO nest_messages (nest_id, user_id, sender_label, body) VALUES (?, ?, 'Member', ?)"
    ).bind(id, user.id, `Contributed +${amount.toLocaleString()} BDT to our Cozy Nest! 💚`)
  ])

  const [updated] = await loadNests(c.env.DB, [id])
  return c.json({ nest: updated, completed: Boolean(completedAt) })
})

api.post('/api/nests/:id/members', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await readJson<{ email?: string }>(c)
  const email = normalizeEmail(body.email)
  await requireMembership(c.env.DB, id, user.id)

  const target = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first<{ id: number; email: string }>()
  if (!target) fail(404, 'No existing PennyNest user found with that Email/ID.')

  const exists = await c.env.DB.prepare('SELECT 1 FROM nest_members WHERE nest_id = ? AND user_id = ?')
    .bind(id, target!.id)
    .first()
  if (exists) fail(409, `${target!.email} is already a member of this Cozy Nest.`)

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO nest_members (nest_id, user_id) VALUES (?, ?)').bind(id, target!.id),
    c.env.DB.prepare(
      "INSERT INTO nest_messages (nest_id, user_id, sender_label, body) VALUES (?, NULL, 'Penny Piggy 🐷', ?)"
    ).bind(id, `${target!.email} joined the Cozy Nest! 🌷`)
  ])

  const [nest] = await loadNests(c.env.DB, [id])
  return c.json({ nest })
})

api.get('/api/nests/:id/messages', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  await requireMembership(c.env.DB, id, user.id)
  const [nest] = await loadNests(c.env.DB, [id])
  return c.json({ messages: nest?.messages ?? [] })
})

api.post('/api/nests/:id/messages', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await readJson<{ text?: string }>(c)
  const text = clampStr(body.text, 1000)
  if (!text) fail(400, 'Please type a message.')
  await requireMembership(c.env.DB, id, user.id)

  await c.env.DB.prepare("INSERT INTO nest_messages (nest_id, user_id, sender_label, body) VALUES (?, ?, 'Member', ?)")
    .bind(id, user.id, text)
    .run()

  const [nest] = await loadNests(c.env.DB, [id])
  return c.json({ messages: nest?.messages ?? [] }, 201)
})

api.delete('/api/nests/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const nest = await c.env.DB.prepare('SELECT owner_id FROM cozy_nests WHERE id = ?').bind(id).first<{ owner_id: number }>()
  if (!nest) fail(404, 'Cozy Nest not found.')
  if (nest!.owner_id !== user.id && user.role !== 'admin') fail(403, 'Only the nest creator can delete this Cozy Nest.')

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM nest_messages WHERE nest_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM nest_contributions WHERE nest_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM nest_members WHERE nest_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM cozy_nests WHERE id = ?').bind(id)
  ])
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* user inbox                                                          */
/* ------------------------------------------------------------------ */

api.get('/api/inbox', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    `SELECT id, body, created_at, read_at FROM admin_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100`
  )
    .bind(user.id)
    .all<{ id: number; body: string; created_at: string; read_at: string | null }>()

  const messages = (results ?? []).map((m) => ({
    id: m.id,
    body: m.body,
    createdAt: m.created_at,
    read: Boolean(m.read_at)
  }))
  return c.json({ messages, unread: messages.filter((m) => !m.read).length })
})

api.post('/api/inbox/:id/read', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare("UPDATE admin_messages SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .run()
  return c.json({ ok: true })
})

api.post('/api/inbox/read-all', async (c) => {
  const user = c.get('user')
  await c.env.DB.prepare("UPDATE admin_messages SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
    .bind(user.id)
    .run()
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* bootstrap: everything the client needs after login                  */
/* ------------------------------------------------------------------ */

api.get('/api/bootstrap', async (c) => {
  const user = c.get('user')

  const [txRes, budgetRes, goalRes, inboxRes] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC').bind(user.id).all(),
    c.env.DB.prepare('SELECT category, monthly_limit FROM budgets WHERE user_id = ?').bind(user.id).all<{
      category: string
      monthly_limit: number
    }>(),
    c.env.DB.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id ASC').bind(user.id).all(),
    c.env.DB.prepare('SELECT id, body, created_at, read_at FROM admin_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100')
      .bind(user.id)
      .all<{ id: number; body: string; created_at: string; read_at: string | null }>()
  ])

  const budgets: Record<string, number> = {}
  for (const b of budgetRes.results ?? []) budgets[b.category] = Number(b.monthly_limit)

  const nestIds = await nestIdsForUser(c.env.DB, user.id)
  const nests = await loadNests(c.env.DB, nestIds)

  const messages = (inboxRes.results ?? []).map((m) => ({
    id: m.id,
    body: m.body,
    createdAt: m.created_at,
    read: Boolean(m.read_at)
  }))

  return c.json({
    user,
    transactions: (txRes.results ?? []).map(mapTx),
    budgets,
    goals: (goalRes.results ?? []).map(mapGoal),
    nests,
    inbox: { messages, unread: messages.filter((m) => !m.read).length }
  })
})

/* ------------------------------------------------------------------ */
/* admin                                                               */
/* ------------------------------------------------------------------ */

type AdminUserRow = {
  id: number
  email: string
  name: string
  role: string
  avatar: string
  created_at: string
  last_login_at: string | null
  tx_count: number
  goal_count: number
  nest_count: number
  unread_count: number
}

api.get('/api/admin/users', async (c) => {
  requireAdmin(c)
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.avatar, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS tx_count,
            (SELECT COUNT(*) FROM goals g WHERE g.user_id = u.id) AS goal_count,
            (SELECT COUNT(*) FROM nest_members nm WHERE nm.user_id = u.id) AS nest_count,
            (SELECT COUNT(*) FROM admin_messages am WHERE am.user_id = u.id AND am.read_at IS NULL) AS unread_count
       FROM users u ORDER BY u.created_at ASC, u.id ASC`
  ).all<AdminUserRow>()

  return c.json({
    users: (results ?? []).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role === 'admin' ? 'admin' : 'user',
      avatar: u.avatar,
      joined: u.created_at,
      lastLogin: u.last_login_at,
      txCount: Number(u.tx_count),
      goalCount: Number(u.goal_count),
      nestCount: Number(u.nest_count),
      unreadMessages: Number(u.unread_count),
      protected: isProtectedEmail(u.email)
    }))
  })
})

api.get('/api/admin/goals', async (c) => {
  requireAdmin(c)
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.title, g.target, g.saved, g.created_at, g.completed_at, u.email, u.avatar
       FROM goals g JOIN users u ON u.id = g.user_id ORDER BY g.id ASC`
  ).all<Record<string, unknown>>()

  return c.json({
    goals: (results ?? []).map((g) => ({
      id: Number(g.id),
      email: String(g.email),
      avatar: String(g.avatar || '🐼'),
      title: String(g.title),
      target: Number(g.target),
      saved: Number(g.saved),
      createdAt: g.created_at ? String(g.created_at) : undefined,
      completedAt: g.completed_at ? String(g.completed_at) : undefined
    }))
  })
})

api.get('/api/admin/stats', async (c) => {
  requireAdmin(c)
  const { results } = await c.env.DB.prepare(
    'SELECT category, COUNT(*) AS n FROM transactions GROUP BY category'
  ).all<{ category: string; n: number }>()

  const counts: Record<string, number> = {
    Food: 0,
    Transport: 0,
    Education: 0,
    Utilities: 0,
    Entertainment: 0,
    Allowance: 0
  }
  for (const r of results ?? []) counts[r.category] = (counts[r.category] || 0) + Number(r.n)

  return c.json({ categoryCounts: counts })
})

api.get('/api/admin/nests', async (c) => {
  requireAdmin(c)
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.title, n.target, n.saved, n.created_at, n.completed_at,
            (SELECT COUNT(*) FROM nest_members nm WHERE nm.nest_id = n.id) AS member_count,
            (SELECT COUNT(*) FROM nest_messages m WHERE m.nest_id = n.id) AS message_count,
            (SELECT COUNT(*) FROM nest_contributions c2 WHERE c2.nest_id = n.id) AS contribution_count
       FROM cozy_nests n ORDER BY n.id DESC`
  ).all<Record<string, unknown>>()

  return c.json({
    nests: (results ?? []).map((n) => ({
      id: Number(n.id),
      title: String(n.title),
      target: Number(n.target),
      saved: Number(n.saved),
      createdAt: String(n.created_at),
      completedAt: n.completed_at ? String(n.completed_at) : null,
      memberCount: Number(n.member_count),
      messageCount: Number(n.message_count),
      contributionCount: Number(n.contribution_count)
    }))
  })
})

/** Everything about one user, for the admin download + full export. PINs are never selected. */
async function collectUserData(db: D1Database, userId: number) {
  const user = await db
    .prepare(`SELECT ${USER_PUBLIC_COLS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<Omit<UserRow, 'pin_hash' | 'pin_salt'>>()
  if (!user) fail(404, 'User not found.')

  const [txRes, goalRes, budgetRes] = await Promise.all([
    db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC').bind(userId).all(),
    db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id ASC').bind(userId).all(),
    db.prepare('SELECT category, monthly_limit FROM budgets WHERE user_id = ?').bind(userId).all<{
      category: string
      monthly_limit: number
    }>()
  ])

  const nestIds = await nestIdsForUser(db, userId)
  const nests = await loadNests(db, nestIds)

  return {
    user,
    transactions: (txRes.results ?? []).map(mapTx),
    goals: (goalRes.results ?? []).map(mapGoal),
    budgets: Object.fromEntries((budgetRes.results ?? []).map((b) => [b.category, Number(b.monthly_limit)])),
    nests: nests.map((n: any) => ({
      id: n.id,
      title: n.title,
      target: n.target,
      saved: n.saved,
      memberCount: n.members.length,
      messageCount: n.messages.length,
      createdAt: n.createdAt,
      completedAt: n.completedAt
    }))
  }
}

api.get('/api/admin/users/:id/download.csv', async (c) => {
  requireAdmin(c)
  const id = Number(c.req.param('id'))
  const data = await collectUserData(c.env.DB, id)
  const u = data.user!

  const rows: unknown[][] = [
    ['PennyNest user export'],
    ['Email / User ID', u.email],
    ['Role', u.role === 'admin' ? 'Admin' : 'Student'],
    ['Account Joined', u.created_at],
    ['Last Login', u.last_login_at || 'never'],
    ['Transactions', data.transactions.length],
    ['Savings Goals', data.goals.length],
    ['Cozy Nests', data.nests.length],
    ['Passcode', 'Never exported'],
    [],
    ['TRANSACTIONS'],
    ['Date', 'Description', 'Category', 'Type', 'Amount (BDT)'],
    ...data.transactions.map((t) => [t.date, t.title, t.category, String(t.type).toUpperCase(), t.amount]),
    [],
    ['SAVINGS GOALS'],
    ['Goal', 'Target (BDT)', 'Saved (BDT)', 'Progress %', 'Status', 'Created', 'Completed'],
    ...data.goals.map((g) => [
      g.title,
      g.target,
      g.saved,
      Math.min(100, Math.round((g.saved / g.target) * 100)),
      g.saved >= g.target ? 'Completed' : 'In progress',
      g.createdAt || '',
      g.completedAt || ''
    ]),
    [],
    ['BUDGETS'],
    ['Category', 'Monthly Limit (BDT)'],
    ...Object.entries(data.budgets).map(([cat, limit]) => [cat, limit]),
    [],
    ['COZY NESTS'],
    ['Nest', 'Saved (BDT)', 'Target (BDT)', 'Members', 'Messages', 'Created', 'Completed'],
    ...data.nests.map((n: any) => [n.title, n.saved, n.target, n.memberCount, n.messageCount, n.createdAt, n.completedAt || ''])
  ]

  return csvResponse(`PennyNest_${u.email.replace(/[^a-z0-9._@-]/gi, '_')}_${stamp()}.csv`, rows)
})

api.get('/api/admin/export/all.json', async (c) => {
  requireAdmin(c)
  const { results: users } = await c.env.DB.prepare(`SELECT id FROM users ORDER BY id ASC`).all<{ id: number }>()
  const payload = []
  for (const u of users ?? []) {
    const data = await collectUserData(c.env.DB, u.id)
    payload.push({
      email: data.user!.email,
      role: data.user!.role,
      createdAt: data.user!.created_at,
      lastLogin: data.user!.last_login_at,
      transactions: data.transactions,
      savingsGoals: data.goals,
      budgets: data.budgets,
      cozyNests: data.nests
    })
  }

  return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), users: payload }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="PennyNest_All_Data_${stamp()}.json"`,
      'Cache-Control': 'no-store'
    }
  })
})

api.get('/api/admin/export/csv/:kind', async (c) => {
  requireAdmin(c)
  const kind = c.req.param('kind')

  if (kind === 'users') {
    const { results } = await c.env.DB.prepare(
      `SELECT u.email, u.role, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS tx,
              (SELECT COUNT(*) FROM goals g WHERE g.user_id = u.id) AS goals,
              (SELECT COUNT(*) FROM nest_members nm WHERE nm.user_id = u.id) AS nests
         FROM users u ORDER BY u.id ASC`
    ).all<Record<string, unknown>>()
    const rows: unknown[][] = [['Email / User ID', 'Role', 'Account Joined', 'Last Login', 'Transactions', 'Savings Goals', 'Cozy Nests']]
    for (const r of results ?? [])
      rows.push([r.email, r.role === 'admin' ? 'Admin' : 'Student', r.created_at, r.last_login_at || 'never', r.tx, r.goals, r.nests])
    return csvResponse(`PennyNest_Users_${stamp()}.csv`, rows)
  }

  if (kind === 'transactions') {
    const { results } = await c.env.DB.prepare(
      `SELECT u.email, t.date, t.title, t.category, t.type, t.amount
         FROM transactions t JOIN users u ON u.id = t.user_id ORDER BY t.date DESC, t.id DESC`
    ).all<Record<string, unknown>>()
    const rows: unknown[][] = [['User', 'Date', 'Description', 'Category', 'Type', 'Amount (BDT)']]
    for (const r of results ?? [])
      rows.push([r.email, r.date, r.title, r.category, String(r.type).toUpperCase(), r.amount])
    return csvResponse(`PennyNest_Transactions_${stamp()}.csv`, rows)
  }

  if (kind === 'goals') {
    const { results } = await c.env.DB.prepare(
      `SELECT u.email, g.title, g.target, g.saved, g.created_at, g.completed_at
         FROM goals g JOIN users u ON u.id = g.user_id ORDER BY g.id ASC`
    ).all<Record<string, unknown>>()
    const rows: unknown[][] = [[ 'User', 'Goal', 'Target (BDT)', 'Saved (BDT)', 'Progress %', 'Status', 'Created On', 'Completed On']]
    for (const r of results ?? []) {
      const target = Number(r.target)
      const saved = Number(r.saved)
      rows.push([
        r.email,
        r.title,
        target,
        saved,
        Math.min(100, Math.round((saved / target) * 100)),
        saved >= target ? 'Completed' : 'In progress',
        r.created_at || '',
        r.completed_at || ''
      ])
    }
    return csvResponse(`PennyNest_Personal_Savings_${stamp()}.csv`, rows)
  }

  if (kind === 'nests') {
    const { results } = await c.env.DB.prepare(
      `SELECT n.id, n.title, n.target, n.saved, n.created_at, n.completed_at,
              (SELECT COUNT(*) FROM nest_members nm WHERE nm.nest_id = n.id) AS members,
              (SELECT COUNT(*) FROM nest_contributions c2 WHERE c2.nest_id = n.id) AS contribs
         FROM cozy_nests n ORDER BY n.id ASC`
    ).all<Record<string, unknown>>()
    const rows: unknown[][] = [
      ['Cozy Nest', 'Members', 'Target (BDT)', 'Saved (BDT)', 'Progress %', 'Status', 'Created On', 'Completed On', 'Contributions']
    ]
    for (const r of results ?? []) {
      const target = Number(r.target)
      const saved = Number(r.saved)
      rows.push([
        r.title,
        r.members,
        target,
        saved,
        Math.min(100, Math.round((saved / target) * 100)),
        r.completed_at ? 'Completed' : 'In progress',
        r.created_at || '',
        r.completed_at || '',
        r.contribs
      ])
    }
    return csvResponse(`PennyNest_CozyNests_Savings_${stamp()}.csv`, rows)
  }

  if (kind === 'contributions') {
    const { results } = await c.env.DB.prepare(
      `SELECT n.title, u.email, c.amount, c.created_at
         FROM nest_contributions c JOIN cozy_nests n ON n.id = c.nest_id JOIN users u ON u.id = c.user_id
        ORDER BY c.id ASC`
    ).all<Record<string, unknown>>()
    const rows: unknown[][] = [['Cozy Nest', 'Contributor', 'Amount (BDT)', 'Date']]
    for (const r of results ?? []) rows.push([r.title, r.email, r.amount, r.created_at])
    return csvResponse(`PennyNest_Nest_Contributions_${stamp()}.csv`, rows)
  }

  fail(404, 'Unknown export type.')
})

api.delete('/api/admin/users/:id', async (c) => {
  const admin = requireAdmin(c)
  const id = Number(c.req.param('id'))
  const target = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(id).first<{ id: number; email: string }>()
  if (!target) fail(404, 'User not found.')
  if (isProtectedEmail(target!.email)) fail(403, 'The permanent admin account cannot be deleted.')
  if (target!.id === admin.id) fail(403, 'You cannot delete your own account from the admin panel.')

  // Explicit cascade so behaviour does not depend on FK pragma settings.
  const nestsOwned = await c.env.DB.prepare('SELECT id FROM cozy_nests WHERE owner_id = ?').bind(id).all<{ id: number }>()
  const ownedIds = (nestsOwned.results ?? []).map((r) => r.id)
  const stmts = []
  for (const nestId of ownedIds) {
    stmts.push(c.env.DB.prepare('DELETE FROM nest_messages WHERE nest_id = ?').bind(nestId))
    stmts.push(c.env.DB.prepare('DELETE FROM nest_contributions WHERE nest_id = ?').bind(nestId))
    stmts.push(c.env.DB.prepare('DELETE FROM nest_members WHERE nest_id = ?').bind(nestId))
    stmts.push(c.env.DB.prepare('DELETE FROM cozy_nests WHERE id = ?').bind(nestId))
  }
  stmts.push(
    c.env.DB.prepare('DELETE FROM nest_contributions WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM nest_messages WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM nest_members WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM admin_messages WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM transactions WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM budgets WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM goals WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
  )
  await c.env.DB.batch(stmts)
  return c.json({ ok: true, deleted: target!.email })
})

api.post('/api/admin/messages', async (c) => {
  const admin = requireAdmin(c)
  const body = await readJson<{ userId?: unknown; email?: unknown; body?: string }>(c)
  const text = clampStr(body.body, 2000)
  if (!text) fail(400, 'Please type a message.')

  let target: { id: number; email: string } | null = null
  if (body.userId !== undefined) {
    target = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(Number(body.userId)).first()
  } else if (body.email) {
    target = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(normalizeEmail(body.email)).first()
  }
  if (!target) fail(404, 'User not found.')

  await c.env.DB.prepare('INSERT INTO admin_messages (user_id, admin_id, body) VALUES (?, ?, ?)')
    .bind(target.id, admin.id, text)
    .run()

  return c.json({ ok: true, to: target.email }, 201)
})

/** Self-service account deletion (regular users from their profile modal). */
api.delete('/api/me', async (c) => {
  const user = c.get('user')
  if (user.role === 'admin' || isProtectedEmail(user.email)) {
    fail(403, 'The permanent admin account cannot be deleted.')
  }
  const nestsOwned = await c.env.DB.prepare('SELECT id FROM cozy_nests WHERE owner_id = ?').bind(user.id).all<{ id: number }>()
  const stmts = []
  for (const n of nestsOwned.results ?? []) {
    stmts.push(c.env.DB.prepare('DELETE FROM nest_messages WHERE nest_id = ?').bind(n.id))
    stmts.push(c.env.DB.prepare('DELETE FROM nest_contributions WHERE nest_id = ?').bind(n.id))
    stmts.push(c.env.DB.prepare('DELETE FROM nest_members WHERE nest_id = ?').bind(n.id))
    stmts.push(c.env.DB.prepare('DELETE FROM cozy_nests WHERE id = ?').bind(n.id))
  }
  stmts.push(
    c.env.DB.prepare('DELETE FROM nest_contributions WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM nest_messages WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM nest_members WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM admin_messages WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM transactions WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM budgets WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM goals WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
  )
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

/** Reset only the caller's finance data (keeps the account). */
api.post('/api/me/reset', async (c) => {
  const user = c.get('user')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM transactions WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM budgets WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM goals WHERE user_id = ?').bind(user.id)
  ])
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* error handling                                                      */
/* ------------------------------------------------------------------ */

api.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as any)
  }
  console.error('API error:', err)
  return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500)
})

api.notFound((c) => c.json({ error: 'Endpoint not found.' }, 404))
