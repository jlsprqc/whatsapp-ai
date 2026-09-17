# WhatsApp + Dify AI Bot

最小单实例 WhatsApp Business Cloud API → Dify Chatbot 中转服务。

## 启动

要求 Node.js 24.15+。

```bash
npm ci
cp .env.example .env
# 填写 .env 中的 Meta 和 Dify 配置
npm start
```

将公网 HTTPS 地址的 `/webhook` 配置到 Meta Webhook，并使用 `META_VERIFY_TOKEN` 完成验证。

`ALLOWED_NUMBERS` 为空时拒绝所有联系人；号码用国际区号格式，以英文逗号分隔。

生产环境请将 `DB_PATH` 指向持久化磁盘。消息会在 SQLite 中保留待处理任务，并在重启后自动恢复；失败请求使用退避重试。日志仅记录阶段、消息 ID 和尝试次数，不记录正文或密钥。

## 路由

- `GET /webhook`：Meta 验证
- `POST /webhook`：接收消息
- `GET /health`：健康检查

首版只处理白名单中的一对一文字消息。Dify/OpenAI 密钥只配置在 Dify 或服务端环境变量中，不要提交 `.env`。
