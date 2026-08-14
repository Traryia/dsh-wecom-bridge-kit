# dsh-wecom-bridge-kit

> 融合企业微信和微信的 bot 通道

把 DeepSeek Harness 接入 **个人微信（微信 ClawBot）** 和 **企业微信（智能机器人）** 的可移植插件套件。
任何一台装有 DeepSeek Harness 的机器，复制本目录过去即可使用。

## 组件

| 组件 | 作用 | 平台 |
| --- | --- | --- |
| `brain-plugin.js` | 大脑插件：注册 `/wecom/ask`（消息→AI 回复）与 `/wecom/status`（诊断），粘贴进 `cordis_define` 即可 | Harness 会话内 |
| `wecom-aibot/` | 企业微信**智能机器人**通道（官方 WebSocket 长连接，无需公网 URL） | Node 进程 |
| `wechat-clawbot/` | **个人微信 ClawBot** 通道（腾讯官方 iLink Bot API，扫码登录） | Node 进程 |
| `scheduler/` | **定时任务**：定时推送、定时执行脚本、桥接进程自愈（watchdog） | Node 进程 |
| `install.mjs` | 一键安装两个通道的 npm 依赖并生成配置模板 | Node |

两个通道共用同一个大脑（`/wecom/ask`），所以**每台机器只需定义一次大脑插件**，再按需启动一个或两个桥。

## 快速开始（新机器三步）

```bash
# 1. 安装依赖
node install.mjs

# 2. 在 harness 会话中激活大脑插件
#    - 打开 cordis_define
#    - 把 brain-plugin.js 的内容粘贴到 code.host，运行
#    - 验证：curl http://127.0.0.1:3080/wecom/status

# 3. 启动你要用的通道（见下）
```

## 通道 A：企业微信智能机器人（AIBot）

```bash
# 配置（从企微管理后台 → 应用管理 → 智能机器人 获取）
# 编辑 wecom-aibot/wecom-aibot.config.json：{ "botId": "...", "secret": "..." }

node wecom-aibot/wecom-aibot-bridge.js
```
看到 `authenticated OK` 即连接成功，在企微里与该机器人对话即可。
详见 `wecom-aibot/README.md`。

## 通道 B：微信 ClawBot（个人微信）

```bash
node wechat-clawbot/wechat-clawbot-bridge.js
```
首次运行会输出二维码（URL 或 `wechat-qrcode.png`），用手机微信扫码并在页面里**点「连接」确认**。
看到 `login OK` + `listening for messages...` 后，在微信里与 ClawBot 会话对话即可。
Token 约 24 小时有效，到期自动重新生成二维码（再次扫码即可）。
详见 `wechat-clawbot/README.md`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECOM_ASK_URL` | `http://127.0.0.1:3080/wecom/ask` | 大脑插件地址；harness 端口不同时覆盖 |

## 常见问题

- **桥连不上大脑**：确认大脑插件已激活（`curl http://127.0.0.1:3080/wecom/status` 返回 ok），端口不同时设 `WECOM_ASK_URL`。
- **ClawBot 扫码后无反应**：确认在微信打开的页面里点了「连接」；`login OK` 才会启动消息监听。
- **AI 没回复**：看桥进程日志；再看 `/wecom/status` 的 `lastError`。
- **进程管理**：桥是前台进程，可用 `pm2` / `nssm` / systemd 托管为常驻服务。

## 文件结构

```
dsh-wecom-bridge-kit/
├── brain-plugin.js                  # 大脑插件（粘贴到 cordis_define）
├── install.mjs                      # 一键安装
├── README.md
├── wecom-aibot/
│   ├── wecom-aibot-bridge.js        # 企微智能机器人桥
│   ├── wecom-aibot.config.example.json
│   └── README.md
└── wechat-clawbot/
    ├── wechat-clawbot-bridge.js     # 微信 ClawBot 桥
    └── README.md
```
