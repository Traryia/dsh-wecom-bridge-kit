# 企业微信智能机器人（AIBot）通道

基于 `@wecom/aibot-node-sdk`，通过 WebSocket 长连接（`wss://openws.work.weixin.qq.com`）
接入企业微信**智能机器人**。无需公网 URL、无需回调配置。

## 前置条件

- 企业微信管理后台存在「智能机器人」（灰度功能，无入口则不可用）
- 拿到机器人的 `botId` 与 `secret`（管理后台 → 应用管理 → 智能机器人）

## 安装

```bash
npm install @wecom/aibot-node-sdk
```

## 配置

复制 `wecom-aibot.config.example.json` 为 `wecom-aibot.config.json` 并填写：

```json
{
  "botId": "aib...",
  "secret": "..."
}
```

## 运行

```bash
node wecom-aibot-bridge.js [config.json]
```

看到 `[aibot] authenticated OK` 即连接成功。之后在企微客户端里与该机器人对话：
机器人会先回「正在思考…」，再返回 AI 完整回复（支持 Markdown）。

## 环境变量

- `WECOM_ASK_URL`：大脑地址，默认 `http://127.0.0.1:3080/wecom/ask`

## 说明

- 断线自动重连（指数退避）
- 首次进入会话自动发送欢迎语
- 若同时接入微信 ClawBot，两台桥共用同一个 `/wecom/ask`，无需改动
