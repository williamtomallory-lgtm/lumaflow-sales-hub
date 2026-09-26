#!/usr/bin/env node

/**
 * Local-only Work bridge for the LumaFlow web client.
 *
 * The bridge is intentionally a small allow-list proxy.  It is not a second
 * CowAgent web console and it must never be put behind Funnel or another
 * public listener.  The browser talks to 127.0.0.1:9877; this process talks
 * to the user's CowAgent backend on loopback.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOST = '127.0.0.1'
const PORT = 9877
const COWAGENT_DEFAULT_BASE = 'http://127.0.0.1:9876'
const TICKET_VERIFY_URL = 'https://lumaflow-sales-hub.vercel.app/api/v1/work/ticket/verify'

// Exact origins only.  Preview deployments are deliberately excluded until
// they are added here after review.
const ALLOWED_ORIGINS = new Set([
  'https://lumaflow-sales-hub.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
])

const PAIR_CODE_TTL_MS = 10 * 60 * 1000
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000
const REQUEST_TTL_MS = 15 * 60 * 1000
const MAX_JSON_BYTES = 64 * 1024
const MAX_TICKET_CHARS = 16 * 1024
const MAX_MESSAGE_CHARS = 8_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_AGENT_TEXT_CHARS = 512

const RATE_LIMITS = Object.freeze({
  pair: { limit: 5, windowMs: 60_000 },
  agents: { limit: 30, windowMs: 60_000 },
  message: { limit: 12, windowMs: 60_000 },
  poll: { limit: 240, windowMs: 60_000 },
})

function defaultStatePath() {
  const root = process.env.LOCALAPPDATA || process.env.APPDATA
  if (root) return path.join(root, 'LumaFlow', 'local-work-bridge.json')
  const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(stateRoot, 'lumaflow', 'local-work-bridge.json')
}

const STATE_PATH = process.env.LOCAL_WORK_BRIDGE_STATE || defaultStatePath()
const COWAGENT_TOKEN = String(process.env.COWAGENT_TOKEN || '').trim()

function normalizeLoopbackBase(raw) {
  let parsed
  try {
    parsed = new URL(raw || COWAGENT_DEFAULT_BASE)
  } catch {
    throw new Error('COWAGENT_BASE_URL must be a valid loopback URL')
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (!loopback || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('COWAGENT_BASE_URL must point to localhost, 127.0.0.1, or ::1')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('COWAGENT_BASE_URL must not contain credentials or query data')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('COWAGENT_BASE_URL must not contain a path')
  }
  return parsed.origin.replace(/\/$/, '')
}

let COWAGENT_BASE = normalizeLoopbackBase(process.env.COWAGENT_BASE_URL)

async function discoverCowAgentBase() {
  if (process.env.COWAGENT_BASE_URL) return
  for (const candidate of ['http://127.0.0.1:9876', 'http://127.0.0.1:9899']) {
    try {
      const response = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) continue
      const health = await response.json()
      if (health?.status === 'ok' || health?.ok === true) {
        COWAGENT_BASE = candidate
        return
      }
    } catch {
      // Try the other common local port.
    }
  }
  throw new Error('CowAgent is not running on 127.0.0.1:9876 or 127.0.0.1:9899')
}

function loadState() {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT') return { ownerUserId: null }
    throw new Error('local Work owner binding is unreadable; repair it locally before pairing')
  }
  if (parsed?.version !== 1 || (parsed.ownerUserId !== null && (typeof parsed.ownerUserId !== 'string' || !parsed.ownerUserId.trim()))) {
    throw new Error('local Work owner binding is invalid; repair it locally before pairing')
  }
  return { ownerUserId: parsed.ownerUserId?.trim() || null }
}

function saveState(state) {
  const directory = path.dirname(STATE_PATH)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = `${STATE_PATH}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const payload = `${JSON.stringify({ version: 1, ownerUserId: state.ownerUserId || null })}\n`
  fs.writeFileSync(temporary, payload, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    fs.renameSync(temporary, STATE_PATH)
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err
    // Some Windows user folders are virtualized and reject even same-folder rename.
    // A completed copy is verified; malformed state fails closed at next startup.
    fs.copyFileSync(temporary, STATE_PATH)
    if (fs.readFileSync(STATE_PATH, 'utf8') !== payload) throw new Error('local owner binding copy verification failed')
    fs.unlinkSync(temporary)
  }
  try {
    fs.chmodSync(STATE_PATH, 0o600)
  } catch {
    // Windows ACLs are managed by the user profile; chmod is best effort.
  }
}

function clearOwnerBinding() {
  const state = loadState()
  if (!state.ownerUserId) {
    console.log(`No local Work owner binding found (${STATE_PATH}).`)
    return
  }
  saveState({ ownerUserId: null })
  console.log(`Local Work owner binding cleared (${STATE_PATH}). Restart the bridge to create a new pairing code.`)
}

function randomPairCode() {
  // Avoid characters that are easy to confuse when copied from a terminal.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(8)
  let raw = ''
  for (const byte of bytes) raw += alphabet[byte % alphabet.length]
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

function normalizePairCode(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase()
}

function safeText(value, max = MAX_AGENT_TEXT_CHARS) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function isSafeAgentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

function json(res, statusCode, body, origin) {
  const payload = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'false')
    res.setHeader('Vary', 'Origin')
  }
  res.end(payload)
}

function error(res, statusCode, message, origin) {
  json(res, statusCode, { error: message }, origin)
}

function readOrigin(req) {
  const origin = req.headers.origin
  return typeof origin === 'string' ? origin : ''
}

function applyCors(res, origin, req) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'false')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
  res.setHeader('Vary', 'Origin')
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  return true
}

function parseBearer(req) {
  const value = req.headers.authorization
  if (typeof value !== 'string') return ''
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(value.trim())
  return match ? match[1] : ''
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function requestKey(req) {
  // The service is loopback-only, so this is a defense-in-depth key rather
  // than an internet client identity.
  return `${req.socket.remoteAddress || 'local'}:${readOrigin(req)}`
}

function createRateLimiter() {
  const buckets = new Map()
  return function allow(key, kind) {
    const policy = RATE_LIMITS[kind]
    if (!policy) return true
    const now = Date.now()
    const bucketKey = `${kind}:${key}`
    const current = buckets.get(bucketKey)
    if (!current || now - current.startedAt >= policy.windowMs) {
      buckets.set(bucketKey, { startedAt: now, count: 1 })
      return true
    }
    if (current.count >= policy.limit) return false
    current.count += 1
    return true
  }
}

const allowRate = createRateLimiter()

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLarge) return
      total += Buffer.byteLength(chunk, 'utf8')
      if (total > MAX_JSON_BYTES) {
        tooLarge = true
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        const parsed = JSON.parse(chunks.join('') || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('request body must be a JSON object')
        }
        resolve(parsed)
      } catch {
        reject(new Error('request body must be valid JSON'))
      }
    })
    req.on('error', (err) => reject(err))
  })
}

async function readResponseLimited(response) {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('upstream response too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await readResponseLimited(response)
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { response, body }
  } finally {
    clearTimeout(timer)
  }
}

function cowHeaders() {
  const headers = { Accept: 'application/json' }
  if (COWAGENT_TOKEN) headers.Authorization = `Bearer ${COWAGENT_TOKEN}`
  return headers
}

async function cowRequest(route, options = {}) {
  const headers = { ...cowHeaders(), ...(options.headers || {}) }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const result = await fetchJson(`${COWAGENT_BASE}${route}`, { ...options, headers })
  if (!result.response.ok || !result.body || typeof result.body !== 'object') {
    throw new Error('CowAgent request failed')
  }
  return result.body
}

function extractUserId(body) {
  const candidates = [
    body?.userId,
    body?.user_id,
    body?.data?.userId,
    body?.data?.user_id,
    body?.user?.id,
    body?.data?.user?.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && candidate.length <= 256) {
      return candidate.trim()
    }
  }
  return ''
}

async function verifyTicket(ticket) {
  const result = await fetchJson(TICKET_VERIFY_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${ticket}` },
  })
  if (!result.response.ok || !result.body || typeof result.body !== 'object' || result.body.valid !== true) {
    throw new HttpError(401, 'ticket rejected')
  }
  const body = result.body
  if (body.valid === false || body.verified === false || body.ok === false || body.status === 'error') {
    throw new HttpError(401, 'ticket rejected')
  }
  const userId = extractUserId(body)
  if (!userId) throw new HttpError(401, 'ticket rejected')
  return userId
}

function sanitizeAgents(body) {
  const rawAgents = Array.isArray(body?.agents) ? body.agents : []
  const agents = []
  for (const raw of rawAgents) {
    if (!raw || typeof raw !== 'object' || !isSafeAgentId(raw.id)) continue
    if (raw.type === 'wechat' || raw.agent_type === 'weixin_personal' || raw.agent_type === 'wecom_group') continue
    agents.push({
      id: raw.id,
      name: safeText(raw.name) || raw.id,
      description: safeText(raw.description, 1_000),
      enabled: raw.enabled !== false,
      type: 'local',
      botType: safeText(raw.botType ?? raw.bot_type ?? raw.agent_type),
    })
  }
  const requestedDefault = body?.defaultAgentId ?? body?.default_agent_id
  const defaultAgentId = isSafeAgentId(requestedDefault) && agents.some((agent) => agent.id === requestedDefault)
    ? requestedDefault
    : (agents.find((agent) => agent.enabled)?.id || agents[0]?.id || '')
  return { agents, defaultAgentId }
}

function makeSessionId() {
  return `local-work:${crypto.randomBytes(24).toString('base64url')}`
}

function makeToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function validString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function createRuntime() {
  const state = loadState()
  const pairCode = randomPairCode()
  const pairCodeNormalized = normalizePairCode(pairCode)
  const pairCodeExpiresAt = Date.now() + PAIR_CODE_TTL_MS
  const sessions = new Map()
  let pairCodeUsed = false
  let pairLock = Promise.resolve()

  function withPairLock(task) {
    const current = pairLock.then(task, task)
    pairLock = current.catch(() => undefined)
    return current
  }

  function prune() {
    const now = Date.now()
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token)
      else if (session.active && now - session.active.createdAt > REQUEST_TTL_MS) session.active = null
    }
  }

  async function authenticate(req, origin) {
    const token = parseBearer(req)
    if (!token) throw new HttpError(401, 'authorization required')
    const session = sessions.get(token)
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(token)
      throw new HttpError(401, 'invalid or expired token')
    }
    if (session.origin !== origin) throw new HttpError(403, 'token origin mismatch')
    return { token, session }
  }

  async function pair(body, origin, req) {
    if (!allowRate(requestKey(req), 'pair')) throw new HttpError(429, 'too many pairing attempts')
    return withPairLock(async () => {
      if (pairCodeUsed || Date.now() >= pairCodeExpiresAt) {
        throw new HttpError(410, 'pairing code expired or already used; restart the bridge')
      }
      const code = normalizePairCode(body.code)
      const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : ''
      if (!code || code !== pairCodeNormalized) throw new HttpError(401, 'invalid pairing code')
      if (!ticket || ticket.length > MAX_TICKET_CHARS) throw new HttpError(400, 'ticket is required')
      if (/[^\x21-\x7E]/.test(ticket)) throw new HttpError(400, 'ticket is invalid')

      const userId = await verifyTicket(ticket)
      if (state.ownerUserId && state.ownerUserId !== userId) {
        throw new HttpError(403, 'this computer is already paired to another account; unbind it locally first')
      }
      if (!state.ownerUserId) {
        state.ownerUserId = userId
        try {
          saveState(state)
        } catch (err) {
          state.ownerUserId = null
          console.error('[local-work-bridge] could not save owner binding:', err?.code || err?.message || 'unknown error')
          throw new HttpError(500, 'could not persist local owner binding')
        }
      }
      pairCodeUsed = true
      return createSession(origin)
    })
  }

  function createSession(origin) {
    const token = makeToken()
    const expiresAt = Date.now() + TOKEN_TTL_MS
    sessions.set(token, {
      origin,
      sessionId: makeSessionId(),
      expiresAt,
      active: null,
    })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  async function resume(body, origin, req) {
    if (!allowRate(requestKey(req), 'pair')) throw new HttpError(429, 'too many pairing attempts')
    if (!state.ownerUserId) throw new HttpError(409, 'this computer has not been paired yet')
    const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : ''
    if (!ticket || ticket.length > MAX_TICKET_CHARS || /[^\x21-\x7E]/.test(ticket)) {
      throw new HttpError(400, 'ticket is invalid')
    }
    const userId = await verifyTicket(ticket)
    if (state.ownerUserId !== userId) throw new HttpError(403, 'this computer is paired to another account')
    return createSession(origin)
  }

  async function agents(req, origin) {
    const { token } = await authenticate(req, origin)
    if (!allowRate(tokenHash(token), 'agents')) throw new HttpError(429, 'too many requests')
    const body = await cowRequest('/api/agents', { method: 'GET' })
    if (body.status && body.status !== 'success') throw new HttpError(502, 'CowAgent agent list failed')
    return sanitizeAgents(body)
  }

  async function wechatPair(req, origin, start) {
    const { token } = await authenticate(req, origin)
    if (!allowRate(tokenHash(token), 'agents')) throw new HttpError(429, 'too many pairing requests')
    const body = await cowRequest('/api/weixin/owner-pair', { method: start ? 'POST' : 'GET' })
    if (body.status !== 'success') throw new HttpError(502, body.message || 'Weixin pairing is unavailable in CowAgent')
    return {
      paired: body.paired === true,
      code: start && typeof body.code === 'string' ? body.code : '',
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
    }
  }

  async function message(req, origin, body) {
    const { token, session } = await authenticate(req, origin)
    if (!allowRate(tokenHash(token), 'message')) throw new HttpError(429, 'too many messages')
    if (session.active) throw new HttpError(409, 'a task is already running for this session')
    if (!validString(body.agentId, 64) || !isSafeAgentId(body.agentId)) {
      throw new HttpError(400, 'agentId is required')
    }
    const roster = await cowRequest('/api/agents', { method: 'GET' })
    if (roster.status && roster.status !== 'success') throw new HttpError(502, 'CowAgent agent list failed')
    if (!sanitizeAgents(roster).agents.some((agent) => agent.id === body.agentId && agent.enabled)) {
      throw new HttpError(403, 'Work only accepts enabled Local Agents')
    }
    if (!validString(body.message, MAX_MESSAGE_CHARS)) throw new HttpError(400, 'message is required')
    const messageText = body.message.trim()
    if (messageText.startsWith('/')) throw new HttpError(400, 'slash commands are not available through Work')

    const upstream = await cowRequest('/message', {
      method: 'POST',
      body: JSON.stringify({
        session_id: session.sessionId,
        agent_id: body.agentId,
        message: messageText,
        stream: false,
        lang: 'zh',
      }),
    })
    const requestId = typeof upstream.request_id === 'string' ? upstream.request_id : ''
    if (!requestId || upstream.status !== 'success') throw new HttpError(502, 'CowAgent did not accept the task')
    session.active = { requestId, agentId: body.agentId, createdAt: Date.now() }
    return { requestId }
  }

  async function poll(req, origin, body) {
    const { token, session } = await authenticate(req, origin)
    if (!allowRate(tokenHash(token), 'poll')) throw new HttpError(429, 'too many polls')
    if (!validString(body.requestId, 128)) throw new HttpError(400, 'requestId is required')
    if (!session.active || session.active.requestId !== body.requestId) {
      throw new HttpError(404, 'request not found for this session')
    }

    const upstream = await cowRequest('/poll', {
      method: 'POST',
      body: JSON.stringify({
        session_id: session.sessionId,
        agent_id: session.active.agentId,
      }),
    })
    if (upstream.status !== 'success') {
      session.active = null
      throw new HttpError(502, 'CowAgent polling failed')
    }
    if (!upstream.has_content) {
      return { hasContent: false, content: '', status: 'pending' }
    }
    session.active = null
    return {
      hasContent: true,
      content: typeof upstream.content === 'string' ? upstream.content.slice(0, 32_000) : '',
      status: 'complete',
    }
  }

  return {
    state,
    pairCode,
    pairCodeExpiresAt,
    pair,
    resume,
    agents,
    wechatPair,
    message,
    poll,
    prune,
    get paired() {
      return Boolean(state.ownerUserId)
    },
    close() {
      sessions.clear()
    },
  }
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

async function main() {
  if (process.argv.includes('--unbind')) {
    clearOwnerBinding()
    return
  }

  await discoverCowAgentBase()

  const runtime = createRuntime()
  const server = http.createServer(async (req, res) => {
    const origin = readOrigin(req)
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      error(res, 403, 'origin is not allowed', '')
      return
    }
    applyCors(res, origin, req)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return
    }

    runtime.prune?.()
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    if (url.search) {
      error(res, 400, 'query parameters are not supported', origin)
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, paired: runtime.paired }, origin)
        return
      }

      if (req.method === 'POST' && url.pathname === '/pair') {
        const body = await parseJsonBody(req)
        json(res, 200, await runtime.pair(body, origin, req), origin)
        return
      }

      if (req.method === 'POST' && url.pathname === '/resume') {
        const body = await parseJsonBody(req)
        json(res, 200, await runtime.resume(body, origin, req), origin)
        return
      }

      if (req.method === 'GET' && url.pathname === '/agents') {
        json(res, 200, await runtime.agents(req, origin), origin)
        return
      }

      if (url.pathname === '/wechat/pair' && (req.method === 'GET' || req.method === 'POST')) {
        json(res, 200, await runtime.wechatPair(req, origin, req.method === 'POST'), origin)
        return
      }

      if (req.method === 'POST' && (url.pathname === '/message' || url.pathname === '/poll')) {
        const body = await parseJsonBody(req)
        const result = url.pathname === '/message'
          ? await runtime.message(req, origin, body)
          : await runtime.poll(req, origin, body)
        json(res, 200, result, origin)
        return
      }

      error(res, 404, 'not found', origin)
    } catch (err) {
      if (err instanceof HttpError) {
        error(res, err.statusCode, err.message, origin)
        return
      }
      const message = err instanceof Error ? err.message : ''
      if (message === 'request body too large' || message === 'request body must be valid JSON' || message === 'request body must be a JSON object') {
        error(res, 400, message, origin)
        return
      }
      console.error('[local-work-bridge]', message || 'request failed')
      error(res, 502, 'local Work backend unavailable', origin)
    }
  })

  const cleanupTimer = setInterval(() => {
    // Expired tokens and active request state stay private to the runtime.
    runtime.prune?.()
  }, 60_000)
  cleanupTimer.unref?.()

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error('连接器已经运行。请使用原窗口；若配对码过期，先关闭原窗口再重试。')
    } else {
      console.error('[local-work-bridge] listener failed:', err?.message || err)
    }
    clearInterval(cleanupTimer)
    runtime.close()
    process.exitCode = 1
  })

  server.listen(PORT, HOST, () => {
    if (process.env.LUMAFLOW_SIMPLE_START === '1') {
      console.log('────────────────────────────────────────')
      console.log(`        配对码：${runtime.pairCode}`)
      console.log('────────────────────────────────────────')
      console.log('回到 LumaFlow 的 Work 页面输入配对码。')
      console.log('请保持此窗口打开；关闭窗口即断开连接。')
      return
    }
    console.log(`Local Work bridge listening on http://${HOST}:${PORT}`)
    console.log(`CowAgent upstream: ${COWAGENT_BASE}`)
    console.log(`Pairing code (one use, expires in 10 minutes): ${runtime.pairCode}`)
    console.log('Allowed browser origins:')
    for (const origin of ALLOWED_ORIGINS) console.log(`  - ${origin}`)
    console.log(`Owner binding state: ${STATE_PATH}`)
  })

  const shutdown = () => {
    clearInterval(cleanupTimer)
    runtime.close()
    server.close(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(`[local-work-bridge] ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
