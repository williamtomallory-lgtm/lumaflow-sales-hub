# LumaFlow Sales Hub

面向照明销售团队的本地知识库与销售 Agent 工作台。支持本机 Qwen3 8B / 14B 推理，不需要付费模型 API；产品、库存、CRM 与报价当前仍包含演示数据，不等于已接通公司的生产系统。

产品目标是可自行部署、可持续积累的本地销售 Agent。本轮知识归档、角色工作台与安全边界见 [`docs/knowledge-agent-workspace.md`](docs/knowledge-agent-workspace.md)。长期记忆、数据库和部署规划见 [`docs/local-agent-blueprint.md`](docs/local-agent-blueprint.md)。原文件和分类结果可以持久积累；自动客户记忆、工作簿到 CRM 的结构化导入、完整 CRM 写入仍待实现。

**电脑执行边界：**Chat 只回答或生成内容。线上 Work 需要网站登录、短期配对票据和每位访客自己电脑上的本机连接器；连接器仅监听 `127.0.0.1`，只把文字任务转给同一台电脑的 CowAgent，并把设备绑定到首次配对的账号。网站登录服务未配置时，线上 Work 保持不可用。不要把 CowAgent 或连接器通过 Funnel 公开。微信命令仍由本机 CowAgent 的独立微信会话授权控制。

## 已实现

- 产品中心：结构化管理产品、型号、SKU、参数、材质、尺寸、场景、供应商、成本、MOQ、库存、状态与关联产品，支持筛选和 PostgreSQL 新增 API
- 资料中心：统一管理图片、尺寸图、参数表、PDF、证书、案例、视频与说明书，支持搜索、上传、下载和版本历史
- 知识库：任意扩展名原文件本地保存，TXT/CSV/Markdown/JSON/PDF/DOCX/XLSX/PPTX 等可读正文自动分类；真实数量、分类分布、解析状态可视化；支持下载原件、分类重试和人工确认。图片、音视频及未知格式目前仅归档，不假装理解
- Chat-AI：智能搜索与销售助手合并为一个简洁页面，默认打开 Chat；Work 内嵌四种 Agent 角色。输入框内切换模型 / Size 和推理强度，支持真实流式回答、产品工具、停止、重试、引用与文件覆盖范围
- 销售资料包：组合图片、参数、PDF、证书、案例和推荐话术，支持复制、系统分享以及真实 ZIP 生成
- 销售 Agent（Chat-AI → Work）：产品销售顾问、微信客服、销售复盘、朋友圈运营；可选最多五个知识库文件。微信消息使用导出的短文本记录或已上传文件；朋友圈发布需二次明确确认，并仅通过已登录的本机 Windows 微信桌面桥提交，不读取微信数据库
- 客户与会话：客户档案、联系人、聊天记录、需求、历史报价和上下文记忆集中管理，并可跳转销售助手或 CPQ
- 报价系统（CPQ）：价格库、数量阶梯、手动折扣、多币种、超限审批、版本保存、实时预览和 PDF 下载
- 跟进系统：未回复/逾期/今日/即将到期筛选、任务创建与完成、下一步话术、客户档案联动；月/周/日协作日历把跟进与团队安排放在同一时间线
- 管理后台：用户角色与状态、邀请记录、知识审核发布、数据质量闭环、AI 日志、使用统计与效果指标
- 通知中心：库存、证书和报价审批提醒可直接跳转相应业务模块
- 响应式界面：桌面、平板与手机布局

## 协作日历

跟进提醒页可创建无需客户档案的共享跟进、会议和专注事件，并邀请其他 LumaFlow 登录用户的邮箱。创建者与受邀者可以共同修改日程；页面每 20 秒读取更新，版本冲突会要求刷新。已有客户跟进任务显示在日历中；所有新建协作事件也立即显示在跟进待办，创建后自动切换到「全部任务」。点击日历事件条目会进入独立详情页；创建人可确认后删除共享事件。日历不会发送邮件、微信或系统推送提醒。

多人分别在自己的电脑运行本项目时，打开各自的 `http://127.0.0.1:3000/`，进入「跟进待办」，点击「连接云端日历」，并用**各自的账号**登录同一个 Vercel 部署。每人创建协作事件时填入同事的登录邮箱；事件、创建人、成员状态和修改记录会在受邀成员的日历中每 20 秒同步。成员可将自己的状态改为「待确认／已接受／已拒绝」或「待处理／进行中／已完成」。日历页在前台时每 30 秒报告活动，90 秒内有活动的成员显示「在线」，否则显示「离线」或「未上线」。

本机客户任务仍保存在当前部署中，不会自动同步到其他电脑；需要团队共享的跟进请创建「协作事件」并选「跟进」。本地页面的日历连接在当前浏览器会话中有效 8 小时。Vercel 使用项目已连接的私有 Blob 存储，要求 `BLOB_READ_WRITE_TOKEN` 与 Auth0 登录配置；本机不需要复制云端存储密钥。只有创建者和受邀邮箱对应的已登录用户可读取事件。公共网站不会直接访问电脑上的 CowAgent。若团队使用其他部署地址，在各电脑设置相同的 `NEXT_PUBLIC_CALENDAR_URL`。

## 技术栈

- Next.js 16 + React 19 + TypeScript
- PostgreSQL（`pg` 连接池）+ JSONB 数据仓库
- Zod 前后端运行时契约
- 原生 CSS 设计系统
- Vitest 单元测试与浏览器端到端验收
- ESLint + Next.js Core Web Vitals 规则

## 本地运行

### 新 Windows 电脑：一键部署

下载仓库 ZIP 并解压，双击根目录 **Start-LumaFlow.cmd**。首次自动准备 Node.js 22、锁定依赖、Ollama、默认 8B 权重与生产构建，再打开本地页面；不需要预装 Codex、Git 或购买模型 API。已有环境文件和本地知识资料保留。

首次下载需要网络、数 GB 空间和等待时间；默认面向 Windows 10/11 x64、16GB 内存，14B 需更多资源。完整参数、日志和启动故障处理见 [一键部署说明](docs/one-click-deploy.md)。

### 开发模式（不自动启动模型）

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。
开发和生产启动命令默认只监听 `127.0.0.1`。多人/内网部署须先补登录、客户级权限和访问网关；当前同源检查不等同于身份认证。

### Windows 笔记本：真实 8B 本地演示

已在 16GB 内存、RTX 5060 Laptop 8GB 显存上实测 Qwen3-8B Q4_K_M。它是独立的 8B 文字/工具模型，不是 Qwen3.8-27B，不需要付费模型 API。完整说明见 [`docs/local-8b-demo.md`](docs/local-8b-demo.md)。

```powershell
npm ci
npm run local:setup
npm run build
npm run local:up
```

首次安装联网下载官方 Ollama 和约 5.2GB 模型，存放在当前项目磁盘的 `.local-runtime/`、`.local-data/`（已忽略，不上传 Git）。之后启动只需双击启动器或 `npm run local:up`；启动命令会检测源码、配置和锁文件变化，必要时重新构建。

打开 **Chat-AI**，顶部可切换 **Chat / Work**。Chat 输入问题；Work 在输入框内选择 Agent。点击输入框右下的模型菜单选择模型，再用 **Light / Medium / Ultra** 按钮切换推理档位，等待“模型已连接”后发送。加号可附加图片；模型偏好记在当前浏览器，生成期间不能切换。

可选安装较大的 14B 模型：`npm run local:setup -- --model=14b`。完成后在页面选择 **Qwen3 14B · 本机演示**；8GB 显存下会使用 CPU/GPU 混合加载，16GB 内存比较紧张，默认仍推荐使用 8B。已在此笔记本上实测 14B 的真实工具调用和回答，不代表任意长任务都能流畅执行。

### 模型、Size 与推理档位

Chat 和 Work 共用输入框内的模型菜单。Light、Medium、Ultra 是 LumaFlow 的推理预算档位。生成期间不可切换，切换后清空旧答案；实际模型和预算在“查看依据与本轮模型”中显示。每次是独立提问，不会自动回放上一轮聊天或保存长期记忆。

各档真实参数、输入限制与验收说明见 [`docs/inference-modes.md`](docs/inference-modes.md)。Size 不是答案长度，较大参数规模或更多思考预算不构成准确率保证。

如果还看到旧标题“自然语言、图片和附件，一处搜索”，请确认最新代码已重新构建、重启服务，再强制刷新页面。旧智能搜索曾使用本地规则直接拼答案，不能作为真实模型验收；新入口不会预填答案或伪造引用，失败时也不会用规则答案替代模型。

`npm run verify:local` 会实际请求本机模型，核验产品查询、库存工具输出、流式回复与 GPU 模型加载信息，不使用协议模拟器。业务数据目前仍是 JSON 演示种子，不代表真实公司库存。

### Ternary Bonsai 2 27B：本机文字与图片模型

项目提供独立的 Windows 安装与启动脚本。首次安装会下载约 5.9 GB 的 PTQ1_0 权重、约 629 MB 的视觉投影文件和 PrismML CUDA 运行时；每个下载文件都会校验 SHA-256。文件保存在 `.local-data/` 与 `.local-runtime/`（已从 Git 和 Vercel 上传包中排除）。

```powershell
.\scripts\setup-bonsai.ps1
.\scripts\start-bonsai.ps1
```

模型服务只监听本机 `127.0.0.1:8081`。本地 `.env.local` 中将 `LLM_BACKEND` 设为 `openai-compatible`、`LLM_BASE_URL` 设为 `http://127.0.0.1:8081/v1`、`LLM_MODEL` 设为 `ternary-bonsai-2-27b`，并把可见模式设为 `light,medium,ultra`。网站图片由模型的 `mmproj` 文件处理；只安装主权重时，服务只能生成文字。

要让 Vercel 上的页面连接本机服务，还需 HTTPS 隧道和带令牌校验的本机代理：

```powershell
.\scripts\setup-bonsai-proxy.ps1
.\scripts\start-bonsai-proxy.ps1
```

代理仅监听 `127.0.0.1:8082`，只开放模型列表与聊天接口，要求 Bearer 令牌、单路推理并限制请求频率。Vercel 的 `LLM_BASE_URL` 需指向 HTTPS 隧道的 `/v1`，`LLM_API_KEY` 需与本机代理令牌匹配，`LLM_MODEL` 必须是 `ternary-bonsai-2-27b`。隧道尚未启用时，Vercel 不能访问本机模型；电脑还需要保持开机并联网。

Tailscale Funnel 给出公开 HTTPS 地址后，可以运行 `.\scripts\connect-bonsai-vercel.ps1 -FunnelUrl https://设备名.tailnet.ts.net/ -Deploy`。脚本先用私有令牌验证外网模型接口，再设置 Vercel Production 变量并部署；令牌不会打印到终端。请用 Funnel 实际显示的地址替换示例地址。

电脑重启后，可运行 `.\scripts\start-bonsai-stack.ps1` 一次恢复模型、代理和 Funnel。运行 `.\scripts\install-bonsai-autostart.ps1` 可设置为 Windows 登录后自动恢复；若不再需要，运行 `.\scripts\install-bonsai-autostart.ps1 -Remove` 删除该启动任务。电脑关机、休眠或未登录时，线上模型无法回答。

当前 Vercel 网站没有用户登录。启用面向公网的隧道前，应先决定是否限制网站访问；否则任何能访问页面的人都可以经由网站 API 请求本机模型。Tailscale Funnel 地址可从公网访问，令牌只保护模型代理本身，并不会替网站访问者登录。

## 数据文件

数据已经按所有权明确分离：

- `src/config/ui-static.ts`：前端发布时即可确定的导航、页面文案、推荐问题和静态演示身份
- `src/config/agent-roles.ts`：前端静态角色名称、说明与输入提示；后端角色指令和工具权限位于 `src/lib/ai/agent-roles.ts`
- `.local-data/knowledge/`：真实上传原件和分类元数据（Git 忽略，需自行备份），由知识库 API 读取；不会混入 Git 中的演示 JSON
- `/api/v1/bootstrap`：产品、库存、客户、报价、跟进、日志与统计等后端动态数据的唯一页面入口
- `src/lib/server/json-data.ts`：带 `server-only` 保护的 JSON 读取器，浏览器不能直接引用

后端开发种子数据位于：

- `src/data/catalog.json`：产品、SKU、参数、库存、资料与产品知识
- `src/data/business.json`：知识库、汇率、报价历史、用户、AI 日志与数据质量问题
- `src/data/crm.json`：客户、联系人、会话、需求、历史报价与跟进任务

业务函数只保留类型、查询和计算逻辑。没有配置数据库时，后端 API 读取这些 JSON 文件，方便修改、审查和版本管理；页面仍然必须等待 API 响应，不能直接导入种子数据。

## 后端 API

- `GET /api/v1/bootstrap`：页面首屏动态数据与真实派生指标
- `GET /api/v1/health`：当前数据源与 PostgreSQL 可达性
- `GET/POST /api/v1/products`、`GET/PATCH /api/v1/products/{id}`
- `GET /api/v1/customers`
- `GET /api/v1/followups`、`PATCH /api/v1/followups/{id}`
- `GET /api/v1/assistant/models`：服务器允许选择的模型目录与连接状态
- `GET /api/v1/assistant/health?modelProfileId=local-qwen3-8b`：所选模型配置与可达性
- `GET /api/v1/assistant/skills`：从文件实际加载的 Agent/Skill 版本及工具清单
- `POST /api/v1/assistant/chat`：Qwen 流式 Agent、工具调用和真实产品卡片
- `GET/POST /api/v1/knowledge`：真实本地文件目录、统计与上传分类
- `GET/PATCH /api/v1/knowledge/{id}`：文件详情与人工确认
- `GET /api/v1/knowledge/{id}/download`、`POST /api/v1/knowledge/{id}/classify`：下载原件与重试分类

架构、数据库与安全设计见 [`docs/backend-architecture.md`](docs/backend-architecture.md)，机器可读接口契约见 [`docs/openapi.yaml`](docs/openapi.yaml)。

## 连接 PostgreSQL

1. 复制 `.env.example` 为 `.env.local`，填写真实的 `DATABASE_URL`。
2. 确保目标 PostgreSQL 数据库已经创建。
3. 初始化表结构并把 JSON 数据写入 PostgreSQL：

```bash
npm run db:setup
npm run dev
```

应用启动后访问 [http://localhost:3000/api/data-source](http://localhost:3000/api/data-source)，`source` 为 `postgres` 表示页面正在读取 PostgreSQL；未配置连接时为 `json`。连接异常时默认安全回退为 `json-fallback`，生产环境可设置 `POSTGRES_REQUIRED=true` 禁止回退。

产品和跟进等业务持久化写操作默认关闭。接好身份系统前，可为同源开发环境设置 `DEMO_WRITES_ENABLED=true`；服务器间调用可配置 `API_WRITE_TOKEN`。这些业务 API 只写 PostgreSQL 并同步记录审计事件，绝不会改写 Git 中的 JSON 文件。知识文件归档独立写入 `.local-data/knowledge/`，不依赖 PostgreSQL；它使用本机同源检查或 `ASSISTANT_API_TOKEN`，不受 `DEMO_WRITES_ENABLED` 控制。

数据库结构位于 `database/schema.sql`，初始化脚本位于 `scripts/seed-postgres.mjs`。连接串只应写入被 Git 忽略的 `.env.local`，不要提交真实密码。

## 验证命令

```bash
npm run lint
npm test
npm run build
npm run verify:api
```

`verify:api` 需在本地服务运行时执行；它会把 API 返回的产品数量、首条 ID 和 SKU 与 JSON 种子逐项比对，并检查筛选、输入拒绝、默认禁写、请求 ID、无缓存和安全响应头。

`node scripts/verify-knowledge-agent.mjs` 使用真实本机 8B 验证上传、分类、去重、原件下载与微信客服文件引用；会保留明确标记的虚构验收样本。`npm run verify:local -- --model=14b` 验证 14B 的真实业务工具调用。模拟测试与真实模型验收不能互相替代。

## 接入 Qwen / vLLM

模型通过 OpenAI-compatible vLLM 私有端点接入，浏览器不会获得模型地址或密钥：

```env
LLM_BACKEND=vllm
LLM_BASE_URL=http://127.0.0.1:8000/v1
LLM_API_KEY=local
LLM_MODEL=lumaflow-qwen
LLM_MAX_OUTPUT_TOKENS=8192
```

销售 Agent 使用 Vercel AI SDK `ToolLoopAgent`，最多执行 5 步，只开放 `searchProducts`、`getProductDetails`、`checkInventory`、`searchKnowledge`、`getProductAssets` 和 `createQuoteDraft` 六个受控工具。模型没有 SQL、任意 HTTP 或直接写数据库的能力；成本与供应商字段不会进入模型工具结果；报价工具只生成未持久化草稿。

当前 Agent Controller 放在已有 Next.js BFF 中，避免原型阶段再复制一套 FastAPI 鉴权和数据层；vLLM 始终是独立私网服务。工具逻辑保持无框架，后续加入 pgvector/后台文档 Worker 时可平移到 FastAPI，而不改变前端接口。

`ai` 和 `@ai-sdk/*` 在这里是本机运行的代码库，不需要 Vercel 云部署、AI Gateway 或付费 OpenAI API。调用目标由服务器的 `LLM_BASE_URL` 决定。使用者需要自己安装模型及其运行环境，模型推理所需硬件和电力并非零成本。

自定义 Ollama Qwen3 服务可设置 `LLM_BACKEND=ollama`；Instant 通过 `reasoning_effort=none` 关闭 thinking。本机登记的 8B / 14B 可使用新的推理档位开启 thinking。llama.cpp 等其他兼容服务使用 `LLM_BACKEND=openai-compatible` 和实际的 `/v1` 地址、模型名称，不发送 vLLM 专用参数。自定义模型能力未经验证，界面只开放 Instant 生成预算，不承诺其思考开关已生效。旧 API 的 fast/normal/deep 保留兼容行为；视觉和其他模型的工具模板须分别验证。当前没有完成普通电脑上的真实 27B 推理验收。

浏览器只发送服务器白名单 `modelProfileId`（`local-qwen3-8b` / `local-qwen3-14b` / `configured`），不接收用户传入的模型 URL、Key 或任意模型名。未传该字段的旧 API 客户端仍使用 `configured`；页面默认显式选择本地 8B。响应头 `X-Model-Profile` 与 `X-Model-Id` 标明实际选择。

当前 API 每次只接受一条用户文本；拒绝浏览器提交的 assistant/tool 历史，防止伪造数据库查询结果。后续多轮历史必须从服务端持久化会话加载。

### 角色与底层业务流程配置

用户界面只展示四种 Agent 角色，不再要求选择 Skill。角色的后端指令及工具白名单位于 `src/lib/ai/agent-roles.ts`；角色权限与管理员流程配置取交集，不能通过切换角色扩大工具权限。`agentRoleId` 与 `knowledgeDocumentIds` 在 `/assistant/chat` 中经过服务端校验；模型只接收服务端读出的、有长度限制的正文。人工确认的公共知识才加入智能搜索，未确认的聊天记录仅在本轮显式勾选时引用。

`agent/profile.json` 选择启用的流程，`agent/skills/*.json` 保存 `id`、`version`、`name`、`description`、`tools` 和 `instructions`。现在启用产品顾问、回复草拟、报价草稿、定制交接草拟四个 Skill。后端每次调用读取并校验文件，把指令与工具白名单真正用于 Agent；修改文件后下一次调用即生效，前端无需重新构建。返回头 `X-Agent-Profile`、`X-Agent-Skills` 可核对当前版本。

这些是 LumaFlow 应用自己的流程配置，使用者无需安装 Codex 或 Codex Skills。配置只能引用代码已注册的六个工具，不能通过新增 JSON 获得任意 SQL、脚本执行或文件访问能力。当前四个流程只能查询或生成草稿；客户记忆、跟进写入等必须先实现并验证对应后端工具才能开放。

没有真实 GPU 服务时，可验证完整 OpenAI-compatible 流式工具协议：

```bash
npm run mock:vllm
```

第二个 PowerShell 终端启动应用（模拟端口是 **8010**，不是实际 vLLM 示例端口 8000）：

```powershell
$env:LLM_BASE_URL="http://127.0.0.1:8010/v1"
$env:LLM_BACKEND="vllm"
$env:LLM_MODEL="lumaflow-qwen"
$env:LLM_CONNECTION_KIND="protocol-mock"
npm run dev
```

第三个终端运行 `npm run verify:assistant`。脚本验证 Skill 已进入模型请求、产品与库存两次工具调用、流式结果、跨域拒绝以及伪造工具历史拒绝。模拟文本读取工具结果，不内置产品答复。

模拟器只验证协议、工具执行、真实 SKU 回传和 SSE 流，不代表真实 Qwen 模型质量。真实上线前必须连接实际 vLLM，并运行公司问题评测集。
验证时把 `LLM_CONNECTION_KIND=protocol-mock` 传给开发服务，页面会明确显示“协议模拟已连接”；正式环境不要设置该值。

## 当前数据边界

当前目录内的数据仍是可替换的演示数据，但读取入口已经统一为“PostgreSQL 优先、JSON 兜底”的服务端数据仓库。产品新增表单在 PostgreSQL 数据源下已调用持久化 API；其他尚未接写 API 的编辑交互会明确保持在当前会话。身份认证与细粒度权限校验仍须在正式上线前完成。

目前 Repository 的空表会回填 JSON 演示记录，初始化脚本也会按种子 ID 更新数据。因此接真实公司数据前，还必须拆开数据库迁移与演示导入、允许正式空集合并取消自动混入演示数据。不要把当前种子初始化脚本直接用于已有业务数据库。

进入生产使用前，还应接入企业对象存储、真实消息渠道、审批通知和财务汇率。销售助手的“确认并记录”不会自动向外部客户发送消息；智能搜索不提供未经接入的图片/附件正文识别；正式报价不能直接依赖演示价格或固定汇率。
