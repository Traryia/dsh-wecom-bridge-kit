# 定时任务调度器（scheduler）

为微信 ClawBot / 企微智能机器人桥提供定时能力：**定时推送**、**定时执行脚本**、**桥接进程自愈**。

## 能力

| 任务类型 | 说明 | 配置字段 |
| --- | --- | --- |
| `push` | 定时向微信/企微推送消息（`content.text` 静态文本，或 `content.mode=agent` 让 AI 生成） | `channel: wechat\|wecom`、`cron`、`content`、`to`（默认 `last` 最近联系人） |
| `watchdog` | 定时检查桥接进程，挂了自动拉起 | `cron`（建议 `*/5 * * * *`） |
| `shell` | 定时执行任意命令（清理、备份等） | `cron`、`command` |
| `ask` | 定时调用大脑 `/wecom/ask` 让 AI 干活（结果只记录日志） | `cron`、`prompt` |

## 用法

```bash
node scheduler.mjs --daemon           # 常驻调度（推荐，配系统计划任务）
node scheduler.mjs --task <id>        # 立即执行单个任务（测试用）
node scheduler.mjs --once             # 执行当前分钟到期任务后退出
node scheduler.mjs --ensure-daemon    # 拉起 daemon（供系统自愈调用）
```

## 配置 `tasks.config.json`

复制 `tasks.config.example.json` 并按需修改（实际配置已被 .gitignore 排除，不会入库）：

```json
{
  "askUrl": "http://127.0.0.1:3080/wecom/ask",
  "bridges": {
    "wechat": { "dir": "../wechat-clawbot", "pidFile": "wechat-clawbot.pid", "script": "wechat-clawbot-bridge.js" },
    "wecom":   { "dir": "../wecom-aibot",   "pidFile": "wecom-aibot.pid",   "script": "wecom-aibot-bridge.js" }
  },
  "tasks": [
    { "id": "bridge-watchdog", "type": "watchdog", "cron": "*/5 * * * *" },
    { "id": "morning-report", "type": "push", "channel": "wechat", "cron": "0 9 * * *",
      "content": { "mode": "agent", "prompt": "写一份简短的工作日报" } }
  ]
}
```

- `cron` 格式：`分 时 日 月 周`（支持 `*`、`*/n`、`a,b`）
- `bridges[].dir` 相对路径基于 scheduler 目录解析，也可用绝对路径
- 环境变量 `SCHEDULER_CONFIG` 可覆盖配置文件路径

## 定时推送原理（outbox 队列）

桥接进程维护一个 `outbox/` 目录。调度器把推送任务写成 `outbox/push-*.json`（`{to, text}`），
桥每 3 秒消费：按 `to`（用户 id 或 `last` 最近联系人）用存储的联系人信息发送，成功删除，失败改名 `failed-*`。

- **微信 ClawBot**：依赖该用户最近一次消息的 `context_token`（contacts.json 自动记录）——用户必须至少给 bot 发过一条消息
- **企微智能机器人**：主动推送用 markdown 类型（`text` 类型会被服务器拒收）

## Windows 开机自启

以管理员运行：

```powershell
powershell -ExecutionPolicy Bypass -File install-windows-tasks.ps1
```

注册两个计划任务：
- `dsh-scheduler-daemon`：登录时启动 daemon（隐藏窗口）
- `dsh-scheduler-heartbeat`：每 5 分钟检查 daemon，挂了自动拉起

日志：`scheduler.log`（任务执行）、各桥目录 `bridge.log`（桥运行日志）。
