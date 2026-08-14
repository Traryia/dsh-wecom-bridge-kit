#!/usr/bin/env node
// dsh-wecom-bridge-kit 一键安装脚本（跨平台）
// 用法: node install.mjs
// 作用: 为两个通道安装所需 npm 依赖，生成配置模板
import { execSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const aibotDir = path.join(root, 'wecom-aibot')
const clawbotDir = path.join(root, 'wechat-clawbot')

function run(cmd, cwd) {
  console.log(`>>> ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

console.log('=== [1/2] 企业微信智能机器人 (AIBot) 依赖 ===')
run('npm install @wecom/aibot-node-sdk', aibotDir)
const aibotCfg = path.join(aibotDir, 'wecom-aibot.config.json')
if (!existsSync(aibotCfg)) {
  writeFileSync(aibotCfg, JSON.stringify({ botId: '', secret: '' }, null, 2))
  console.log('已生成 wecom-aibot/wecom-aibot.config.json（请填入 botId / secret）')
}

console.log('\n=== [2/2] 微信 ClawBot 依赖 ===')
run('npm install qrcode', clawbotDir)

console.log(`
============================================================
安装完成 ✅  接下来三步即可接入：
============================================================
1. 大脑插件（每台机器做一次）
   在 harness 会话中打开 cordis_define，把 brain-plugin.js 的
   内容粘贴到 code.host，运行激活。验证:
     curl http://127.0.0.1:3080/wecom/status
   （若 harness 端口不是 3080，用环境变量 WECOM_ASK_URL 覆盖）

2. 企业微信智能机器人（可选）
   编辑 wecom-aibot/wecom-aibot.config.json 填入 botId/secret
   运行: node wecom-aibot/wecom-aibot-bridge.js

3. 微信 ClawBot（可选）
   运行: node wechat-clawbot/wechat-clawbot-bridge.js
   用手机微信扫描生成的 wechat-qrcode.png 完成连接
   （token 约 24h 有效，到期自动生成新二维码）

详细说明见 README.md 和各通道目录内 README.md
============================================================`)
