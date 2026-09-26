# LumaFlow 本机 Work 桥接

`scripts/local-work-bridge.mjs`（网站下载地址为 `/downloads/local-work-bridge.mjs`）是浏览器 Work 面板与本机 CowAgent 之间的受限桥接服务。Windows 用户在 `/work-setup` 复制启动命令；命令下载连接器、核对 SHA-256 后，用官方 Node.js 启动。早期 `/downloads/LumaFlow-Work-Connector-Windows.zip` 中的未签名 `.cmd` 可能被 Windows 智能应用控制拦截，因此不作为网站主流程。它只监听 `127.0.0.1:9877`，不接受局域网或公网连接，也不应该通过 Tailscale Funnel、端口转发或反向代理公开。

每台电脑只保存一个 LumaFlow 账号的 `ownerUserId`。首次配对会把登录账号绑定到这台电脑；另一个账号必须在本机控制台解除绑定后才能重新配对。配对码和网页账号 ticket 缺一不可，因此公开网页不能只拿到终端上的配对码就使用这台电脑。

## 手动启动（高级用户）

先启动本机 CowAgent，再在 PowerShell 中运行桥接：

```powershell
Set-Location "$env:USERPROFILE\Downloads"

# 当前源码运行端口示例：
$env:COWAGENT_BASE_URL = 'http://127.0.0.1:9876'

# 常见一键安装的 CowAgent Web API 端口是 9899，使用它时改成：
# $env:COWAGENT_BASE_URL = 'http://127.0.0.1:9899'

# 只有本机 CowAgent 配置了 Bearer 认证时才需要设置；不要把它写进前端。
# $env:COWAGENT_TOKEN = '<本机 CowAgent 的 Bearer token>'

node .\local-work-bridge.mjs
```

桥接启动后，终端会打印一次性配对码。终端需要保持运行，网页只访问 `http://127.0.0.1:9877`。桥接自身不需要 Funnel。

若要换绑账号，在本机终端执行：

```powershell
node .\local-work-bridge.mjs --unbind
node .\local-work-bridge.mjs
```

`--unbind` 只清除本机保存的账号绑定；它不会删除 CowAgent 的 Agent、会话或工作区。绑定文件默认位于 Windows 用户的 `%LOCALAPPDATA%\LumaFlow\local-work-bridge.json`，也可以用 `LOCAL_WORK_BRIDGE_STATE` 指定路径。

## 网页配对流程

1. 用户先登录 Vercel 网页。网页调用 `POST /api/v1/work/ticket`，取得短期 `{ticket, expiresAt}`。
2. 网页把这个 ticket 和桥接终端显示的配对码发送到本机 `POST /pair`。
3. 桥接服务端只向固定的 Vercel 地址验证 ticket：
   `https://lumaflow-sales-hub.vercel.app/api/v1/work/ticket/verify`，使用 `Authorization: Bearer <ticket>`。ticket 不会写入本地状态文件，也不会返回给 CowAgent。
4. 验证通过后，网页得到短期随机 token。后续请求必须带 `Authorization: Bearer <token>`，并且只能由配对时的同一个网页 Origin 使用。
5. 已经绑定过同一网站账号的电脑，页面刷新后可以用短期 ticket 调用 `POST /resume` 自动恢复本次连接，不必再次输入配对码；不同账号仍被拒绝。

## API

所有请求都必须带允许的 `Origin`。响应均为 JSON；错误响应统一为 `{ "error": "..." }`。桥接不接受查询参数。

允许的 Origin 是：

- `https://lumaflow-sales-hub.vercel.app`
- `http://localhost:3000`、`http://127.0.0.1:3000`
- `http://localhost:5173`、`http://127.0.0.1:5173`
- `http://localhost:4173`、`http://127.0.0.1:4173`

### `GET /health`

只返回最小状态，不需要 token：

```json
{ "ok": true, "paired": false }
```

`paired` 表示本机是否已经保存账号绑定，不暴露 `userId`、配对码、token 或 CowAgent 信息。

### `POST /pair`

请求：

```json
{ "code": "ABCD-EFGH", "ticket": "<Vercel ticket>" }
```

成功：

```json
{ "token": "<随机短期 token>", "expiresAt": "2026-09-23T20:00:00.000Z" }
```

配对码只能使用一次，十分钟后失效。每分钟最多五次配对尝试。ticket 必须由 Vercel 验证接口确认，并且其 `userId` 必须与本机已有绑定相同；不同账号会收到 `403`，需要先执行 `--unbind` 并重启桥接。

### `GET /agents`

需要 Bearer token：

```http
Authorization: Bearer <token>
```

成功响应只保留以下字段：

```json
{
  "agents": [
    {
      "id": "default",
      "name": "Agent",
      "description": "",
      "enabled": true,
      "botType": ""
    }
  ],
  "defaultAgentId": "default"
}
```

工作区路径、模型配置、channel 实例、credentials 等 CowAgent 字段不会传给浏览器。桥接只调用 CowAgent 的 `GET /api/agents`，不会转发其管理用的 `POST /api/agents`。

### `POST /resume`

已配对过的电脑使用 `{ "ticket": "<Vercel ticket>" }` 恢复会话。桥接再次向固定的 Vercel 地址验证 ticket，只有账号与本机保存的主人一致才签发新的短期 token；首次配对仍必须用本机配对码。

### `POST /message`

需要 Bearer token，并且一次会话只能有一个未完成任务：

```json
{ "agentId": "default", "message": "请总结今天的销售数据" }
```

成功响应：

```json
{ "requestId": "<CowAgent request id>" }
```

桥接会为每个配对 token 生成独立的随机 `session_id`，只把下面的受限请求转发给 CowAgent：

```json
{
  "session_id": "<bridge-generated session id>",
  "agent_id": "default",
  "message": "请总结今天的销售数据",
  "stream": false,
  "lang": "zh"
}
```

消息最多 8,000 个字符；以 `/` 开头的 CowAgent 命令不通过 Work 桥接执行。

### `POST /poll`

请求：

```json
{ "requestId": "<上一次 /message 返回的 requestId>" }
```

仍在处理时：

```json
{ "hasContent": false, "content": "", "status": "pending" }
```

收到最终文字时：

```json
{ "hasContent": true, "content": "最终回复", "status": "complete" }
```

`requestId` 只对创建它的 token/session 有效。桥接向 CowAgent 只转发 `POST /poll`，不会开放 CowAgent 的 `/stream`。

## 限制与故障排查

- 只允许 `GET /health`、`POST /pair`、`POST /resume`、`GET /agents`、`POST /message`、`POST /poll`；其他路径和方法返回 `404`。
- token 默认四小时有效，只保存在桥接进程内；Origin 不匹配时拒绝使用。请求体最多 64 KiB，CowAgent 响应最多读取 1 MiB。
- `/message` 每个 token 每分钟最多 12 次；`/agents` 30 次；`/poll` 240 次。CowAgent 请求超时为 15 秒。
- 当前桥接是文字任务桥接，不转发照片、文件上传、语音、工作区读写、会话管理或模型管理接口。网页的附件按钮不能通过这组 API 发送本机文件。
- 浏览器报 CORS 或 Private Network 错误时，确认页面使用上面列出的 Origin，并重新启动本机桥接。`/health` 也必须带 `Origin`。
- `CowAgent request failed` 时，确认 CowAgent 正在运行，并把 `COWAGENT_BASE_URL` 改成实际的本机端口；常见端口是 `9899`，当前源码运行示例是 `9876`。
- 配对返回 `401` 时，检查终端配对码、网页登录状态和 ticket 是否过期。配对码失效后必须重启桥接取得新码。
- Windows 的某些应用数据目录会把同目录文件重命名报告为 `EXDEV`。连接器对此使用复制并核对结果；绑定文件损坏时启动会停止，避免误把电脑绑定给其他账号。
- 本机状态被绑定到其他账号时，按上面的 `--unbind` 步骤操作。不要通过 Funnel 暴露 `9877`，也不要把 `COWAGENT_TOKEN` 放进网页代码或 Vercel 环境变量。
