// ============================================================
// DeepSeek Harness 微信 / 企业微信 桥 —— 大脑插件（跨平台版）
// ------------------------------------------------------------
// 用途：在任何一台装有 DeepSeek Harness 的机器上，打开一个会话，
//   把本文件内容整体粘贴到 cordis_define 工具的 code.host 字段
//   （plugin 选 new，name/purpose 随意），然后 cordis_run 激活。
//   插件注册两个路由（挂在 harness 的 webServer 上）：
//     POST /wecom/ask     — 入参 { from?, content } → 出参 { ok, reply }
//     GET  /wecom/status  — 诊断信息
//   桥接进程（wecom-aibot-bridge.js / wechat-clawbot-bridge.js）
//   收到微信/企微消息后 POST 到 /wecom/ask，再把回复发回原通道。
//
// 特性：纯 Node 内置能力（无第三方依赖、无 curl、无绝对路径），
//   按 from 保留每人最近 12 条对话记忆，180s 超时保护。
// 注意：同一台机器上两个通道共用这一个大脑（路由只注册一次）。
// ============================================================
return {
  inject: ['timer'],
  apply(ctx) {
    const userMemory = new Map()
    const diag = { lastError: null, lastReply: null, lastFrom: null, processed: 0 }

    const log = (...args) => console.log('[bridge-brain]', ...args)
    const err = (...args) => console.error('[bridge-brain]', ...args)

    function fakeSignal() {
      const listeners = new Set()
      return {
        aborted: false,
        reason: undefined,
        addEventListener(type, cb) { if (type === 'abort') listeners.add(cb) },
        removeEventListener(type, cb) { if (type === 'abort') listeners.delete(cb) },
        throwIfAborted() {},
      }
    }

    function extractText(blocks) {
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const b of blocks) {
        if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
      return parts.join('\n').trim()
    }

    async function askAgent(fromUser, content) {
      const agents = ctx.get('agents')
      const subagents = ctx.get('subagents')
      if (!agents || !subagents) throw new Error('agents/subagents service unavailable')
      const parent = agents.roots()[0] || agents.list()[0]
      if (!parent) throw new Error('no live agent to parent from')
      const list = subagents.list()
      const provider = list.indexOf('spawn') >= 0 ? 'spawn' : list[0]
      if (!provider) throw new Error('no subagent provider registered')

      const history = userMemory.get(fromUser) || []
      let promptText = '你是部署在 DeepSeek Harness 上的微信/企业微信 AI 助手。用户通过微信发来消息，请直接给出回复内容（简洁、友好，使用中文）。'
      if (history.length > 0) promptText += '\n\n最近对话：\n' + history.join('\n')
      promptText += '\n\n用户最新消息：' + content

      const run = await subagents.start(provider, {
        parent,
        label: 'bridge:' + fromUser,
        prompt: [{ type: 'text', text: promptText }],
        signal: fakeSignal(),
      })
      let timeoutDispose = null
      try {
        const result = await Promise.race([
          run.result,
          new Promise((resolve) => { timeoutDispose = ctx.timeout(() => resolve(null), 180000) }),
        ])
        if (timeoutDispose) timeoutDispose()
        if (!result) throw new Error('agent reply timed out after 180s')
        if (result.stopReason !== 'completed') throw new Error('agent stopped: ' + result.stopReason)
        const reply = extractText(result.output)
        if (reply) {
          const h = userMemory.get(fromUser) || []
          h.push('用户: ' + content, '助手: ' + reply)
          userMemory.set(fromUser, h.slice(-12))
        }
        return reply
      } finally {
        if (timeoutDispose) timeoutDispose()
        await run.dispose()
      }
    }

    const askHandler = async (req, res) => {
      const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        if ((req.method || 'GET') !== 'POST') {
          sendJson(405, { ok: false, error: 'method not allowed' })
          return
        }
        let body = ''
        for await (const chunk of req) body += chunk.toString('utf8')
        const input = body ? JSON.parse(body) : {}
        const from = typeof input.from === 'string' && input.from ? input.from : 'anonymous'
        const content = typeof input.content === 'string' && input.content ? input.content : ''
        if (!content) {
          sendJson(400, { ok: false, error: 'content required' })
          return
        }
        diag.lastFrom = from
        const reply = await askAgent(from, content)
        diag.lastReply = reply
        diag.lastError = null
        sendJson(200, { ok: true, reply })
      } catch (e) {
        const msg = e && e.message ? e.message : String(e)
        diag.lastError = msg
        err('ask failed:', msg)
        sendJson(500, { ok: false, error: msg })
      }
    }

    const statusHandler = async (req, res) => {
      const agents = ctx.get('agents')
      const subagents = ctx.get('subagents')
      const root = agents ? agents.roots()[0] : undefined
      const info = {
        ok: true,
        rootAgent: root ? root.id : null,
        providers: subagents ? subagents.list() : [],
        activeUsers: userMemory.size,
        processed: diag.processed,
        lastFrom: diag.lastFrom,
        lastError: diag.lastError,
        lastReply: diag.lastReply ? (diag.lastReply.length > 300 ? diag.lastReply.slice(0, 300) + '…' : diag.lastReply) : null,
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(info, null, 2))
    }

    ctx.effect(() => {
      const webServer = ctx.get('webServer')
      if (!webServer) {
        err('webServer service unavailable')
        return
      }
      const d1 = webServer.register({ kind: 'exact', path: '/wecom/ask', handler: askHandler })
      const d2 = webServer.register({ kind: 'exact', path: '/wecom/status', handler: statusHandler })
      log('routes registered: /wecom/ask, /wecom/status')
      return () => { d1(); d2() }
    })

    log('bridge brain plugin applied')
  },
}
