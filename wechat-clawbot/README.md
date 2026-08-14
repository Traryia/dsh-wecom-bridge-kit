# 微信 ClawBot（个人微信）通道

基于腾讯官方 **iLink Bot API**（`https://ilinkai.weixin.qq.com`），扫码登录后
通过长轮询收发个人微信消息。官方产品（有《微信ClawBot功能使用条款》），非逆向、无封号风险。

## 安装

```bash
npm install qrcode   # 可选：把登录链接渲染成可扫描的二维码 PNG
```

## 运行

```bash
node wechat-clawbot-bridge.js
```

首次运行流程：
1. 桥从官方接口获取登录二维码
2. 二维码保存为 `wechat-qrcode.png`（或打印 URL），**用手机微信扫一扫，并在打开的页面里点「连接」确认**
3. 看到 `[clawbot] login OK, token saved` 与 `listening for messages...` 即接通
4. 在微信里找到 ClawBot 会话，发消息即可对话

## 会话与重连

- 登录 token 约 **24 小时**有效，保存在 `wechat-clawbot.state.json`（重启免重扫，到期自动重扫）
- 到期前桥会自动获取新二维码并提示重扫
- 长轮询接口单次约 30 秒返回（45 秒超时已内置处理）

## 环境变量

- `WECOM_ASK_URL`：大脑地址，默认 `http://127.0.0.1:3080/wecom/ask`

## 说明

- 每条回复必须携带消息的 `context_token`（脚本已处理），否则消息无法关联会话
- 媒体消息（图片/语音/文件）暂未处理，只响应文本
- 官方条款提示：腾讯可按风险限速/终止连接，勿将此作为核心业务唯一依赖
