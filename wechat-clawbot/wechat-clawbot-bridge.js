// wechat-clawbot-bridge.js
// 微信 ClawBot (官方 iLink Bot API) <-> DeepSeek Harness 桥
// 协议: https://ilinkai.weixin.qq.com (腾讯官方, 需微信扫码登录, token 约24h有效)
// 用法: node wechat-clawbot-bridge.js
// 环境变量: WECOM_ASK_URL (默认 http://127.0.0.1:3080/wecom/ask)
'use strict'

const fs = require('fs')
const path = require('path')

// 文件日志：detached 运行（watchdog 托管）时 stdout 不可见，全部写入 bridge.log
const LOG_FILE = path.join(__dirname, 'bridge.log')
function tee(orig, tag) {
  return (...args) => {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${tag} ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n')
    } catch (e) {}
    orig(...args)
  }
}
console.log = tee(console.log, 'log')
console.error = tee(console.error, 'err')

const BASE_URL = 'https://ilinkai.weixin.qq.com'
const ASK_URL = process.env.WECOM_ASK_URL || 'http://127.0.0.1:3080/wecom/ask'
const STATE_FILE = path.join(__dirname, 'wechat-clawbot.state.json')
const CONTACTS_FILE = path.join(__dirname, 'contacts.json')
const OUTBOX_DIR = path.join(__dirname, 'outbox')
const PID_FILE = path.join(__dirname, 'wechat-clawbot.pid')
const SESSION_DURATION_MS = 24 * 3600 * 1000
const SCAN_TIMEOUT_MS = 10 * 60 * 1000
const REQ_TIMEOUT_MS = 45000

// 写 PID 文件（供 watchdog 使用）
try {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true })
  fs.writeFileSync(PID_FILE, String(process.pid))
} catch (e) {}
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch (e) {} })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 联系人持久化：记录每个用户最近的 context_token（主动推送必需）
let contacts = {}
function loadContacts() {
  try { contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')) } catch (e) { contacts = {} }
}
function saveContacts() {
  try { fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts)) } catch (e) {}
}
loadContacts()

let botToken = null
let botBaseUrl = BASE_URL
let getUpdatesBuf = ''
let loginTime = Date.now()
const typingCache = new Map()
const welcomed = new Set()

function makeHeaders(token) {
  const uin = String(Math.floor(Math.random() * 0xFFFFFFFF))
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(uin, 'utf8').toString('base64'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchJson(url, options, token) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...options,
      headers: makeHeaders(token),
      signal: ctrl.signal,
    })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function apiPost(base, pathName, body, token) {
  return fetchJson(`${base}/${pathName}`, { method: 'POST', body: JSON.stringify(body) }, token ?? botToken)
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ botToken, botBaseUrl, loginTime }, null, 2), 'utf8')
    console.log('[clawbot] state saved to', STATE_FILE)
  } catch (e) {
    console.error('[clawbot] saveState failed:', e.message)
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (s && s.botToken) {
      botToken = s.botToken
      botBaseUrl = s.botBaseUrl || BASE_URL
      loginTime = s.loginTime || Date.now()
      return true
    }
  } catch (e) {}
  return false
}

async function saveQr(content) {
  const str = String(content)
  try {
    if (str.startsWith('data:image/')) {
      const [header, b64] = str.split(',')
      const ext = (header.match(/data:image\/(\w+)/) || [])[1] || 'png'
      const file = path.join(__dirname, `wechat-qrcode.${ext}`)
      fs.writeFileSync(file, Buffer.from(b64, 'base64'))
      return file
    }
    if (str.startsWith('http')) return str
    if (str.startsWith('<svg')) {
      const file = path.join(__dirname, 'wechat-qrcode.svg')
      fs.writeFileSync(file, str)
      return file
    }
    const file = path.join(__dirname, 'wechat-qrcode.png')
    fs.writeFileSync(file, Buffer.from(str, 'base64'))
    return file
  } catch (e) {
    return null
  }
}

async function login() {
  console.log('[clawbot] fetching QR code...')
  const data = await fetchJson(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, { method: 'GET' }, null)
  const qrcode = data.qrcode
  if (!qrcode) throw new Error('get_bot_qrcode failed: ' + JSON.stringify(data).slice(0, 200))
  const qrTarget = await saveQr(data.qrcode_img_content || qrcode)
  if (qrTarget && qrTarget.startsWith('http')) {
    console.log('[clawbot] QR url:', qrTarget)
  } else if (qrTarget) {
    console.log('[clawbot] QR image saved to:', qrTarget)
  }
  console.log('[clawbot] 请用手机微信扫描二维码并在页面里确认连接（10 分钟内）')

  const deadline = Date.now() + SCAN_TIMEOUT_MS
  let lastLog = 0
  while (Date.now() < deadline) {
    try {
      const status = await fetchJson(
        `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        { method: 'GET' },
        null
      )
      if (status.status === 'confirmed') {
        botToken = status.bot_token
        botBaseUrl = status.baseurl || BASE_URL
        loginTime = Date.now()
        saveState()
        console.log('[clawbot] login OK, token saved, baseurl =', botBaseUrl)
        return true
      }
      const now = Date.now()
      if (now - lastLog > 10000) {
        console.log('[clawbot] waiting for scan... status =', JSON.stringify(status).slice(0, 120))
        lastLog = now
      }
    } catch (e) {
      const now = Date.now()
      if (now - lastLog > 10000) {
        console.error('[clawbot] status poll error:', e.message)
        lastLog = now
      }
    }
    await sleep(1000)
  }
  console.error('[clawbot] QR scan timed out')
  return false
}

async function sendText(toId, contextToken, text) {
  if (!toId || !contextToken) {
    console.log('[clawbot] [send-degraded]', text)
    return
  }
  const clientId = `openclaw-weixin-${Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0')}`
  await apiPost(botBaseUrl, 'ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: '1.0.2' },
  })
}

// outbox 主动推送队列：调度器写入 outbox/*.json ({to, text})，此处消费发送
// to 支持具体用户 id 或 "last"（最近联系人）
async function pollOutbox() {
  loadContacts() // 每轮重新读取，支持外部更新
  try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch (e) {} // 心跳：更新 pid 文件 mtime 供 watchdog 存活探测
  let files = []
  try {
    files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('failed-'))
  } catch (e) {
    return
  }
  for (const f of files) {
    const fp = path.join(OUTBOX_DIR, f)
    try {
      const item = JSON.parse(fs.readFileSync(fp, 'utf8'))
      let to = item.to || 'last'
      let token = null
      if (to === 'last') {
        let best = null
        for (const [uid, c] of Object.entries(contacts)) {
          if (!best || c.lastAt > best.c.lastAt) best = { uid, c }
        }
        if (best) {
          to = best.uid
          token = best.c.contextToken
        }
      } else {
        const c = contacts[to]
        token = c ? c.contextToken : null
      }
      if (!token) throw new Error('no context token for target: ' + to)
      await sendText(to, token, String(item.text || ''))
      try { fs.unlinkSync(fp) } catch (e) {}
      console.log('[clawbot] outbox sent to', to)
    } catch (e) {
      console.error('[clawbot] outbox failed:', f, '-', e.message)
      try { fs.renameSync(fp, path.join(OUTBOX_DIR, 'failed-' + f)) } catch (e2) {}
    }
  }
}

async function askHarness(from, content) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 200000)
  try {
    const res = await fetch(ASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, content }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error('ask HTTP ' + res.status)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'ask failed')
    return data.reply || ''
  } finally {
    clearTimeout(timer)
  }
}

async function handleMessage(msg) {
  if (msg.message_type !== 1) return
  const first = msg.item_list && msg.item_list[0]
  const text = first && first.text_item ? first.text_item.text : ''
  const fromId = msg.from_user_id
  const contextToken = msg.context_token
  if (!fromId || !text) return
  console.log('[clawbot] text from', fromId, ':', String(text).slice(0, 80))

  // 更新联系人 token（供定时主动推送使用）
  contacts[fromId] = { contextToken, lastAt: Date.now() }
  saveContacts()

  if (!welcomed.has(fromId)) {
    welcomed.add(fromId)
    await sendText(fromId, contextToken, '连接成功！我是 DeepSeek Harness AI 助手，直接发送消息即可对话 😊')
    return
  }

  let typingTicket = typingCache.get(fromId)
  if (!typingTicket) {
    try {
      const cfg = await apiPost(botBaseUrl, 'ilink/bot/getconfig', {
        ilink_user_id: fromId,
        context_token: contextToken,
        base_info: { channel_version: '1.0.2' },
      })
      typingTicket = cfg.typing_ticket || ''
      typingCache.set(fromId, typingTicket)
    } catch (e) {}
  }
  if (typingTicket) {
    try {
      await apiPost(botBaseUrl, 'ilink/bot/sendtyping', { ilink_user_id: fromId, typing_ticket: typingTicket, status: 1 })
    } catch (e) {}
  }

  let reply = ''
  try {
    reply = await askHarness(fromId, text)
  } catch (e) {
    console.error('[clawbot] ask error:', e.message)
    reply = '抱歉，处理出错：' + e.message
  }
  if (!reply) reply = '（无回复）'
  try {
    await sendText(fromId, contextToken, reply)
    console.log('[clawbot] replied', reply.length, 'chars')
  } catch (e) {
    console.error('[clawbot] send error:', e.message)
  }
  if (typingTicket) {
    try {
      await apiPost(botBaseUrl, 'ilink/bot/sendtyping', { ilink_user_id: fromId, typing_ticket: typingTicket, status: 2 })
    } catch (e) {}
  }
}

async function messageLoop() {
  console.log('[clawbot] listening for messages...')
  while (true) {
    try {
      const result = await apiPost(botBaseUrl, 'ilink/bot/getupdates', {
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: '1.0.2' },
      })
      getUpdatesBuf = result.get_updates_buf ?? getUpdatesBuf
      if (result.ret !== undefined && result.ret !== 0) {
        console.error('[clawbot] getupdates ret:', result.ret, JSON.stringify(result).slice(0, 200))
        await sleep(5000)
        continue
      }
      for (const msg of result.msgs ?? []) {
        try {
          await handleMessage(msg)
        } catch (e) {
          console.error('[clawbot] handle error:', e.message)
        }
      }
    } catch (e) {
      console.error('[clawbot] getupdates error:', e.message)
      await sleep(5000)
    }
  }
}

async function reconnectLoop() {
  while (true) {
    const elapsed = Date.now() - loginTime
    const wait = Math.max(0, SESSION_DURATION_MS - 10 * 60 * 1000 - elapsed)
    await sleep(wait + 1000)
    console.log('[clawbot] session expiring soon, starting re-login...')
    try {
      const ok = await login()
      if (!ok) console.error('[clawbot] re-login failed, retrying in 5min')
    } catch (e) {
      console.error('[clawbot] re-login error:', e.message)
    }
    await sleep(5 * 60 * 1000)
  }
}

;(async () => {
  console.log('============================================')
  console.log(' 微信 ClawBot (官方 iLink Bot API) <-> Harness')
  console.log(' ask endpoint:', ASK_URL)
  console.log('============================================')
  const loaded = loadState()
  if (!loaded || Date.now() - loginTime > SESSION_DURATION_MS - 10 * 60 * 1000) {
    console.log('[clawbot] need login: scan the QR with WeChat')
    const ok = await login()
    if (!ok) process.exit(1)
  } else {
    console.log('[clawbot] restored session from state file, expires', new Date(loginTime + SESSION_DURATION_MS).toISOString())
  }
  await Promise.all([messageLoop(), reconnectLoop(), (async () => { while (true) { await sleep(3000); await pollOutbox().catch((e) => console.error('[clawbot] outbox error:', e.message)) } })()])
})()
