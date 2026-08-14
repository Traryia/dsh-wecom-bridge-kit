#!/usr/bin/env node
// scheduler.mjs — DeepSeek Harness 微信/企微桥 定时任务调度器
// 用法:
//   node scheduler.mjs --daemon          # 常驻调度（循环 30s，按 cron 执行任务）
//   node scheduler.mjs --task <id>       # 立即执行单个任务
//   node scheduler.mjs --once            # 执行当前分钟到期的任务后退出
//   node scheduler.mjs --ensure-daemon   # 若 daemon 不在运行则拉起（供系统自愈调用）
// 配置: tasks.config.json（可用环境变量 SCHEDULER_CONFIG 覆盖路径）
import { spawn, execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = process.env.SCHEDULER_CONFIG || path.join(__dirname, 'tasks.config.json')
const LOG_FILE = path.join(__dirname, 'scheduler.log')
const DAEMON_PID = path.join(__dirname, 'scheduler.pid')
const TICK_MS = 30 * 1000

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }) } catch (e) {}
}

function loadConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (!Array.isArray(cfg.tasks)) throw new Error('tasks must be an array')
    return cfg
  } catch (e) {
    log(`cannot read config ${CONFIG_FILE}: ${e.message}`)
    process.exit(1)
  }
}

// 简单 cron 匹配："分 时 日 月 周"，支持 * 与 */n 与 a,b
function cronMatch(cron, d) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const vals = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()]
  for (let i = 0; i < 5; i++) {
    const p = parts[i]
    if (p === '*') continue
    if (p.startsWith('*/')) {
      const n = parseInt(p.slice(2), 10)
      if (!n || vals[i] % n !== 0) return false
      continue
    }
    if (!p.split(',').map((x) => parseInt(x, 10)).includes(vals[i])) return false
  }
  return true
}

function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return false }
}

function bridgeDir(cfg, name) {
  const b = cfg.bridges && cfg.bridges[name]
  if (!b || !b.dir) throw new Error(`bridge "${name}" not configured`)
  return { b, dir: path.isAbsolute(b.dir) ? b.dir : path.resolve(__dirname, b.dir) }
}

// ---------- 任务执行 ----------

async function pushTask(cfg, task) {
  const { b, dir } = bridgeDir(cfg, task.channel)
  const outbox = path.join(dir, 'outbox')
  mkdirSync(outbox, { recursive: true })
  let text = ''
  const c = task.content
  if (typeof c === 'string') text = c
  else if (c && c.text) text = c.text
  else if (c && c.mode === 'agent') {
    const url = cfg.askUrl || 'http://127.0.0.1:3080/wecom/ask'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'scheduler:' + task.id, content: c.prompt || task.id }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error('ask failed: ' + (data.error || res.status))
    text = data.reply || ''
  }
  if (!text) throw new Error('empty content')
  const file = path.join(outbox, `push-${task.id}-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify({ to: task.to || 'last', text, ts: Date.now() }))
  log(`[push] ${task.id} ${task.channel} <- ${text.length} chars -> ${path.basename(file)}`)
}

async function askTask(cfg, task) {
  const url = cfg.askUrl || 'http://127.0.0.1:3080/wecom/ask'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'scheduler:' + task.id, content: task.prompt || task.id }),
  })
  const data = await res.json()
  log(`[ask] ${task.id} -> ${data.ok ? 'ok(' + (data.reply || '').length + ' chars)' : 'error: ' + data.error}`)
}

function shellTask(cfg, task) {
  return new Promise((resolve) => {
    const cmd = task.command
    if (!cmd) return resolve('no command')
    const isWin = process.platform === 'win32'
    execFile(isWin ? 'cmd.exe' : '/bin/sh', [isWin ? '/c' : '-c', cmd], { timeout: 300000 }, (err, stdout, stderr) => {
      log(`[shell] ${task.id} exit=${err ? err.code : 0} out=${String(stdout || '').slice(0, 200).trim()} err=${String(stderr || '').slice(0, 200).trim()}`)
      resolve()
    })
  })
}

function watchdogTask(cfg, task) {
  for (const [name, b] of Object.entries(cfg.bridges || {})) {
    const dir = path.isAbsolute(b.dir) ? b.dir : path.resolve(__dirname, b.dir)
    let pid = null
    try { pid = parseInt(readFileSync(path.join(dir, b.pidFile), 'utf8'), 10) } catch (e) {}
    if (pid && isAlive(pid)) continue
    log(`[watchdog] ${name} DOWN (pid=${pid}), restarting...`)
    try {
      const child = spawn(process.execPath, [b.script], { cwd: dir, detached: true, stdio: 'ignore' })
      child.unref()
      log(`[watchdog] ${name} respawned (pid=${child.pid})`)
    } catch (e) {
      log(`[watchdog] ${name} restart FAILED: ${e.message}`)
    }
  }
}

async function runTask(cfg, task) {
  if (task.enabled === false) return
  try {
    if (task.type === 'push') await pushTask(cfg, task)
    else if (task.type === 'ask') await askTask(cfg, task)
    else if (task.type === 'shell') await shellTask(cfg, task)
    else if (task.type === 'watchdog') watchdogTask(cfg, task)
    else log(`[task] ${task.id}: unknown type ${task.type}`)
  } catch (e) {
    log(`[task] ${task.id} ERROR: ${e.message}`)
  }
}

// ---------- 模式 ----------

const args = process.argv.slice(2)

if (args.includes('--task')) {
  const id = args[args.indexOf('--task') + 1]
  const cfg = loadConfig()
  const t = cfg.tasks.find((x) => x.id === id)
  if (!t) { log(`task "${id}" not found`); process.exit(1) }
  await runTask(cfg, t)
  process.exit(0)
}

if (args.includes('--once')) {
  const cfg = loadConfig()
  const d = new Date()
  for (const t of cfg.tasks) {
    if (t.cron && cronMatch(t.cron, d)) await runTask(cfg, t)
  }
  process.exit(0)
}

if (args.includes('--ensure-daemon')) {
  let pid = null
  try { pid = parseInt(readFileSync(DAEMON_PID, 'utf8'), 10) } catch (e) {}
  if (pid && isAlive(pid)) {
    console.log('daemon alive (pid ' + pid + ')')
    process.exit(0)
  }
  log('daemon not running, starting...')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--daemon'], {
    cwd: __dirname, detached: true, stdio: 'ignore',
  })
  child.unref()
  process.exit(0)
}

// 默认：--daemon 常驻
try { writeFileSync(DAEMON_PID, String(process.pid)) } catch (e) {}
const cfg = loadConfig()
log(`scheduler daemon started (pid ${process.pid}), ${cfg.tasks.length} tasks, tick ${TICK_MS}ms`)
const lastRun = new Map()
const tick = async () => {
  const d = new Date()
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`
  for (const t of cfg.tasks) {
    if (!t.cron || t.enabled === false) continue
    if (!cronMatch(t.cron, d)) continue
    if (lastRun.get(t.id) === key) continue
    lastRun.set(t.id, key)
    await runTask(cfg, t)
  }
}
await tick()
setInterval(tick, TICK_MS)
