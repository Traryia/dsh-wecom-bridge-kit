// wecom-aibot-bridge.js
// 企业微信智能机器人(AIBot) <-> DeepSeek Harness 桥接
// 依赖: @wecom/aibot-node-sdk (npm install)
// 用法: node wecom-aibot-bridge.js [config.json]
// 环境变量: WECOM_ASK_URL (默认 http://127.0.0.1:3080/wecom/ask)
'use strict'

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'wecom-aibot.config.json')
const ASK_URL = process.env.WECOM_ASK_URL || 'http://127.0.0.1:3080/wecom/ask'

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

wsClient.connect()

process.on('SIGINT', () => {
  console.log('[aibot] shutting down')
  wsClient.disconnect()
  process.exit(0)
})
