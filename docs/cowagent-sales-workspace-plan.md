# LumaFlow × CowAgent Sales Workspace 实施基线

状态：架构与权限预检
核对日期：2026-09-08
CowAgent 上游基线：`37c0db204c348f4a74f7cd0ed40e162a72d83460` (`master`)
当前 LumaFlow 仓库：`williamtomallory-lgtm/lumaflow-sales-hub`

## 1. 已核对的事实

当前 LumaFlow 是 Next.js 16、React 19、TypeScript 和 Vercel AI SDK 项目。它不是 CowAgent 的一个 fork，也不存在 CowAgent 的 `bridge/`、`channel/`、`ConversationStore`、`AgentStreamExecutor` 或 Desktop Electron 目录。因此，不能把目标方案当作当前仓库上的小型增量补丁。

CowAgent 当前 `master` 已具备以下可复用基础：

- `ConversationStore` 的 `sessions`、`messages`、`runs` SQLite 表和启动迁移；
- Agent run 的 `task_id`、`task_source`、`parent_run_id` 关联；
- `BaseTool`、`ToolManager`、进度回调、事件回调与 artifact 事件；
- Web `/message`、`/stream`、`/poll`、`/api/sessions` 等接口；
- 基于 ilink bot API 的 Weixin 通道、二维码登录、消息收发、媒体缓存；
- React/Electron Desktop Chat、Session、Knowledge、Tasks、Workspace 页面。

隔离环境使用 Python 3.11 安装上游依赖后，ConversationStore、Run 生命周期、Weixin 凭证、Session 与 SSE 相关的 71 个测试全部通过。Desktop 端也已按锁文件安装 566 个 npm packages，并完成 Vite renderer 与 Electron main TypeScript 的生产构建。构建目前只有上游既有的字体资源、chunk size 和动态/静态 import 警告，没有编译失败。

## 2. 对原方案的必要修正

### Web 执行路径

CowAgent 当前 Desktop Web 主入口是：

```text
POST /message
  -> WebChannel.post_message()
  -> ChatChannel.produce() / _handle()
  -> Bridge.fetch_agent_reply()
  -> AgentBridge.agent_reply()
```

`ChatService.run()` 当前主要由 OpenAI-compatible streaming 路径调用。因此公共 `ExecutionService` 仍需同时接入 `AgentBridge.agent_reply()` 和 `ChatService.run()`，但不能假设 Desktop `/message` 绕过 `AgentBridge`。

### Session 列表

`SessionsHandler.GET()` 当前显式调用 `list_sessions(channel_type="web")`。要在 Web UI 看到 ClawBot 会话，必须新增受 agent scope 限制的 `web + weixin` 查询，而不是只改前端。

### 微信附件

当前 Weixin 通道把图片和文件放入 `file_cache`，之后以 `[图片: path]` / `[文件: path]` 文本标记加入 prompt。目标实现还必须持久化结构化附件、验证受管路径、限制大小、检查 MIME，并建立消息幂等键。

### 日志

当前 Weixin 收件日志会写入内容预览。产品化版本必须移除消息正文，只记录 request/session/channel/message id、类型、耗时和状态。

## 3. 推荐仓库策略

推荐保留现有 `lumaflow-sales-hub`，另外从 CowAgent 建立 `lumaflow-cowagent` 派生仓库：

```text
lumaflow-sales-hub       现有产品原型、视觉与业务资料参考
lumaflow-cowagent        正式 Agent Core、ClawBot、Chat/Work、Desktop
```

正式开发分支使用 `codex/weixin-sales-workspace`。完成后提供统一 Windows 启动器；用户不需要手动启动两个互相重复的 UI。现有仓库和未提交工作不会被删除或覆盖。

## 4. 目标运行结构

```text
Weixin ClawBot / CowAgent Web
             |
      ExecutionService
      auto -> chat/work/hybrid
             |
       CowAgent Agent Core
             |
       Sales Skills + Tools
        /        |        \
 Products    CRM/Quote    Files
 PostgreSQL  PostgreSQL   managed workspace
             |
 ConversationStore + WorkStore + ActivityFeed
             |
       Chat view / Work view
```

Chat 与 Work 是执行模式和视图，不是两个大模型，也不建立两套 Memory。

## 5. 分阶段实施

### Phase 0：派生仓库与基线

- 建立 CowAgent 派生仓库和开发分支；
- 保留 MIT LICENSE 和上游归属；
- 固定上游 commit、Python/Node 版本与锁定依赖；
- 跑 Python、Desktop build 和现有回归测试；
- 增加 Windows 一键启动入口。

### Phase 1：Execution Routing

- 新增 `agent/execution/types.py`、`router.py`、`service.py`、`prompts.py`；
- `execution_mode` 独立于模型 reasoning/size 参数；
- deterministic heuristic 优先，歧义请求再调用 structured model；
- suggested tools 必须经过 ToolManager allowlist；
- scheduler、subagent、delegated/internal task 不重复分类；
- 接入 `AgentBridge.agent_reply()` 和 `ChatService.run()`。

### Phase 2：Work 持久化和审批

- 新增 `work_items`、`work_steps`、`work_artifacts`、`activity_events`；
- 沿用 ConversationStore 的启动迁移方式，不要求用户手工删库；
- Work 通过 `task_id=work_id`、`task_source=sales_workspace` 关联 CowAgent run；
- Observer 消费 tool start/progress/end、artifact、final/error/cancel 事件；
- 报价、特殊价、交付/付款承诺使用审批状态机。

### Phase 3：非破坏式 Activity Feed

- 新增 `GET /api/activity?after=<id>&limit=<n>`；
- cursor 可重复读取、按 event id 排序、受 agent scope 限制；
- Desktop 每 2 秒轮询，刷新跨 session 消息和 Work；
- 保留现有 destructive `/poll` 的兼容用途，不拿它做全局同步。

### Phase 4：Weixin ClawBot 同步

- 保留 CowAgent 官方 Weixin/ilink 通道和二维码登录，不改协议；
- 使用 `from_user_id` 作为 V1 session identity；
- 持久化 `source_channel`、`external_message_id`、attachments、execution mode、work id；
- external message id 建立持久幂等保护；
- Web Session 列表显示微信/Web badge；
- 主动通知失败不改变已完成 Work 的状态；
- `origin_channel`、`mirrored`、`dedupe_key` 防止回环。

### Phase 5：销售数据库和 Tools

- PostgreSQL 正规化产品、variant、库存、资料、客户、需求、报价和报价项；
- Excel 通过 staging -> normalize -> validation -> confirm 导入；
- 库存、价格、产品事实只能来自 Tool/数据库；
- 实现产品搜索、详情、库存、价格、资料、客户历史、需求、报价、follow-up；
- 业务数据库不可用时明确失败，禁止模型猜测。

### Phase 6：四套业务能力

- `lighting-product-sales`
- `wechat-customer-service`
- `sales-review`
- `moments-operation`

它们是同一个 Sales Agent 的 Skill，不启动四个模型。朋友圈 V1 只生成草稿，不自动发布。

### Phase 7：Web Chat / Work

- Chat 展示 Web/微信会话、消息和结构化附件；
- Work 展示任务状态、步骤、进度、artifact 和审批；
- 普通输入默认 `auto`，不要求用户选择 Chat/Work；
- Hybrid 先返回即时事实，再创建可跟踪 Work；
- API Handler 只调用 Service，不直接写数据库。

### Phase 8：完整验证与交付

- Router、Work、Activity、审批、去重、附件、重启和回归测试；
- synthetic fixtures、mock channel、真实模型、真实 ClawBot 分层记录；
- 使用专门测试会话完成微信文字/文件/Work/Hybrid E2E；
- 输出文件清单、schema/API、运行说明、已知限制和回滚步骤。

## 6. 权限和凭据

### 现在需要用户确认

1. 是否允许在用户 GitHub 下建立公开 CowAgent 派生仓库；
2. 采用 DashScope Qwen 3.8 Flash，还是保持完全本地 Qwen3 8B/14B；
3. 是否接受测试消息在使用 DashScope 时传输到阿里云处理。

### 到真实联调时需要

- `DASHSCOPE_API_KEY`：只在 CowAgent Web 模型管理或本机 secret/env 中配置；
- `DATABASE_URL`：只在本机/部署环境配置；
- 用户本人扫描 Weixin ClawBot 二维码并确认授权；
- 一个专门的测试 ClawBot 会话和脱敏的测试 Excel/图片/文件；
- 对测试回复和测试文件回传的明确授权。

任何 secret 均不应粘贴到聊天、写入源码、写入日志或提交 Git。

### 不需要

- 微信密码；
- 微信聊天数据库或解密密钥；
- 读取既有私人聊天；
- Windows 管理员权限；
- Docker（本地源码开发不依赖 Docker）；
- 公网开放端口（本地 V1 不需要）。

### 正式多人部署后才需要

- OIDC/session 身份认证；
- tenant/workspace/resource scope、RBAC/RLS；
- 正式 PostgreSQL 迁移账号与备份策略；
- 对象存储、病毒扫描、短时签名下载；
- 域名、TLS、反向代理和防火墙配置；
- 审批人、数据保留期和审计策略。

## 7. 微信能力边界

ClawBot 只能处理用户发给机器人的消息与文件。它不等于获得个人微信历史读取权限，也不能自动看到用户其他联系人或群里的既有聊天。需要分析旧聊天时，用户必须主动导出、转发或上传。

当前 LumaFlow 的 Windows UI Automation 只读桥接是另一种本地导入方式，不是官方 ClawBot，不具备后台 long-poll、消息发送、附件同步或持久会话能力。它不得作为 ClawBot 完成证据。

## 8. 完成判据

只有以下证据同时成立才可宣布完成：

- 真实 ClawBot 使用所选 Qwen 模型回答；
- 产品和库存调用真实 Tool，不编造；
- 微信消息与结构化附件可在 Web Chat 查看；
- 复杂微信任务自动出现在 Work，且重启后仍存在；
- Work 有步骤、进度、状态、artifact 和审批；
- Hybrid 同时完成即时回答和后台任务；
- Chat/Work 共用一个 Agent、Memory、Tools 与业务数据库；
- 原 CowAgent Channel、Scheduler、Skills、Memory、MCP、Teams 和 Sessions 回归测试通过；
- GitHub 远端 commit 与本地验证 commit 一致。
