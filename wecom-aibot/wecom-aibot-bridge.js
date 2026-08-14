// wecom-aibot-bridge.js
// 企业微信智能机器人(AIBot) <-> DeepSeek Harness 桥接
// 依赖: @wecom/aibot-node-sdk (npm install)
// 用法: node wecom-aibot-bridge.js [config.json]
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

const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'wecom-aibot.config.json')
const ASK_URL = process.env.WECOM_ASK_URL || 'http://127.0.0.1:3080/wecom/ask'
const CONTACTS_FILE = path.join(__dirname, 'contacts.json')
const OUTBOX_DIR = path.join(__dirname, 'outbox')
const PID_FILE = path.join(__dirname, 'wecom-aibot.pid')

try {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true })
  fs.writeFileSync(PID_FILE, String(process.pid))
} catch (e) {}
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch (e) {} })

let contacts = {}
function loadContacts() {
  try { contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')) } catch (e) { contacts = {} }
}
function saveContacts() {
  try { fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts)) } catch (e) {}
}
loadContacts()

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    console.error('[aibot] cannot read config', CONFIG_PATH, '-', e.message)
    process.exit(1)
  }
}

const config = loadConfig()
if (!config.botId || !config.secret) {
  console.error('[aibot] config missing botId/secret in', CONFIG_PATH)
  process.exit(1)
}

let AiBot
let sdkMod = null
try {
  sdkMod = require('@wecom/aibot-node-sdk')
  AiBot = sdkMod.default || sdkMod
} catch (e) {
  console.error('[aibot] @wecom/aibot-node-sdk not installed - run: npm install @wecom/aibot-node-sdk')
  process.exit(1)
}

const generateReqId = (sdkMod && sdkMod.generateReqId) || AiBot.generateReqId || ((prefix) => prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))

console.log('[aibot] starting bridge; ask endpoint =', ASK_URL)

const wsClient = new AiBot.WSClient({ botId: config.botId, secret: config.secret })

wsClient.on('authenticated', () => console.log('[aibot] authenticated OK'))
wsClient.on('error', (e) => console.error('[aibot] error:', e && e.message ? e.message : String(e)))
wsClient.on('disconnect', () => console.log('[aibot] disconnected'))

async function askAgent(sender, content) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 200000)
  try {
    const res = await fetch(ASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sender, content }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error('harness ask returned HTTP ' + res.status)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'harness ask failed')
    return data.reply || ''
  } finally {
    clearTimeout(timer)
  }
}

wsClient.on('message.text', async (frame) => {
  const content = (frame && frame.body && frame.body.text && frame.body.text.content) || ''
  const from = (frame && frame.body && frame.body.from) || {}
  const sender = from.userid || from.chatid || 'unknown'
  console.log('[aibot] text from', sender, ':', String(content).slice(0, 80))
  if (!content) return

  // 记录联系人（主动推送用）：单聊 chatid 缺失时回退用 userid
  const chatid = from.chatid || from.userid || sender
  const chattype = from.chattype || frame.body.chattype || 'single'
  contacts[sender] = { chatid, chattype, lastAt: Date.now() }
  saveContacts()

  const streamId = generateReqId('stream')
  try {
    await wsClient.replyStream(frame, streamId, '正在思考…', false)
    const reply = await askAgent(sender, content)
    if (!reply) throw new Error('empty reply from harness')
    await wsClient.replyStream(frame, streamId, reply, true)
    console.log('[aibot] replied', reply.length, 'chars')
  } catch (e) {
    console.error('[aibot] reply error:', e && e.message ? e.message : String(e))
    try {
      await wsClient.replyStream(frame, streamId, '抱歉，处理出错：' + (e && e.message ? e.message : String(e)), true)
    } catch (_) {}
  }
})

wsClient.on('event.enter_chat', (frame) => {
  console.log('[aibot] user entered chat')
  wsClient
    .replyWelcome(frame, { msgtype: 'text', text: { content: '您好！我是 DeepSeek Harness AI 助手，可以直接向我提问 😊' } })
    .catch((e) => console.error('[aibot] welcome failed:', e && e.message ? e.message : String(e)))
})

// outbox 主动推送队列：调度器写入 outbox/*.json ({to, text})，此处通过 WS 发送
async function pollOutbox() {
  loadContacts() // 每轮重新读取，支持外部更新
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
      if (to === 'last') {
        let best = null
        for (const [uid, c] of Object.entries(contacts)) {
          if (!best || c.lastAt > best.c.lastAt) best = { uid, c }
        }
        if (!best) throw new Error('no contacts yet')
        to = best.uid
      }
      const c = contacts[to]
      const target = c ? c.chatid || to : to
      // 主动推送通道仅支持 markdown / 模板卡片（text 会被服务器拒收）
      await wsClient.sendMessage(target, { msgtype: 'markdown', markdown: { content: String(item.text || '') } })
      try { fs.unlinkSync(fp) } catch (e) {}
      console.log('[aibot] outbox sent to', to, '(target ' + target + ')')
    } catch (e) {
      const detail = e && (e.message || e.code || e.errCode || e.errMsg)
        ? (e.message || e.code || e.errCode || e.errMsg)
        : (typeof e === 'object' ? JSON.stringify(e) : String(e))
      console.error('[aibot] outbox failed:', f, '-', detail)
      try { fs.renameSync(fp, path.join(OUTBOX_DIR, 'failed-' + f)) } catch (e2) {}
    }
  }
}

wsClient.connect()
setInterval(() => pollOutbox().catch((e) => console.error('[aibot] outbox error:', e.message)), 3000)

process.on('SIGINT', () => {
  console.log('[aibot] shutting down')
  wsClient.disconnect()
  process.exit(0)
})
