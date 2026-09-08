# LumaFlow Sales Hub

面向照明销售团队的产品知识、客户协作与报价工作台。当前版本把“客户咨询 → 找产品与资料 → 生成待审回复 → 报价 → 跟进 → 管理复盘”做成一个无需外部 AI Key 即可完整运行的本地演示闭环。

产品目标是可自行部署、可持续积累的本地销售 Agent。两张业务截图对应的 Agent/Skill 拆解、长期记忆、数据库、部署和验收方案见 [`docs/local-agent-blueprint.md`](docs/local-agent-blueprint.md)。当前已经接通模型协议与业务 Skill；永久客户记忆、真实工作簿导入和完整 CRM 写入仍待实现。

## 已实现

- 产品中心：结构化管理产品、型号、SKU、参数、材质、尺寸、场景、供应商、成本、MOQ、库存、状态与关联产品，支持筛选和 PostgreSQL 新增 API
- 资料中心：统一管理图片、尺寸图、参数表、PDF、证书、案例、视频与说明书，支持搜索、上传、下载和版本历史
- 知识库：覆盖 FAQ、销售话术、产品/公司知识、政策与案例，支持新建、版本草稿和 TXT/CSV/Markdown/DOCX/PDF 服务端正文解析
- 智能搜索：支持 SKU/型号精确搜索、参数筛选、自然语言与语义匹配，以及图片/附件文件名特征检索；回答只引用目录数据
- 销售资料包：组合图片、参数、PDF、证书、案例和推荐话术，支持复制、系统分享以及真实 ZIP 生成
- 销售助手：分析客户消息的意图和紧急度，推荐产品与附件，生成可编辑回复，并在人工确认后记录为待发送
- 客户与会话：客户档案、联系人、聊天记录、需求、历史报价和上下文记忆集中管理，并可跳转销售助手或 CPQ
- 报价系统（CPQ）：价格库、数量阶梯、手动折扣、多币种、超限审批、版本保存、实时预览和 PDF 下载
- 跟进系统：未回复/逾期/今日/即将到期筛选、任务创建与完成、下一步话术、客户档案联动
- 管理后台：用户角色与状态、邀请记录、知识审核发布、数据质量闭环、AI 日志、使用统计与效果指标
- 通知中心：库存、证书和报价审批提醒可直接跳转相应业务模块
- 响应式界面：桌面、平板与手机布局

## 技术栈

- Next.js 16 + React 19 + TypeScript
- PostgreSQL（`pg` 连接池）+ JSONB 数据仓库
- Zod 前后端运行时契约
- 原生 CSS 设计系统
- Vitest 单元测试与浏览器端到端验收
- ESLint + Next.js Core Web Vitals 规则

## 本地运行

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

首次安装联网下载官方 Ollama 和约 5.2GB 模型，存放在当前项目磁盘的 `.local-runtime/`、`.local-data/`（已忽略，不上传 Git）。之后启动只需 `npm run local:up`。更新代码后需重新 `npm run build`。

打开销售助手，选择 **Qwen3 8B · 本机演示**，等待“模型已连接”，输入客户消息并点击“调用模型分析”。下拉框也保留服务器环境变量配置的自定义模型；选择会记在当前浏览器，切换时清空上一模型的草稿和轨迹，生成期间不能切换。

`npm run verify:local` 会实际请求本机模型，核验产品查询、库存工具输出、流式回复与 GPU 模型加载信息，不使用协议模拟器。业务数据目前仍是 JSON 演示种子，不代表真实公司库存。

## 数据文件

数据已经按所有权明确分离：

- `src/config/ui-static.ts`：前端发布时即可确定的导航、页面文案、推荐问题和静态演示身份
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

持久化写操作默认关闭。接好身份系统前，可为同源开发环境设置 `DEMO_WRITES_ENABLED=true`；服务器间调用可配置 `API_WRITE_TOKEN`。写 API 只写 PostgreSQL 并同步记录审计事件，绝不会改写 Git 中的 JSON 文件。

数据库结构位于 `database/schema.sql`，初始化脚本位于 `scripts/seed-postgres.mjs`。连接串只应写入被 Git 忽略的 `.env.local`，不要提交真实密码。

## 验证命令

```bash
npm run lint
npm test
npm run build
npm run verify:api
```

`verify:api` 需在本地服务运行时执行；它会把 API 返回的产品数量、首条 ID 和 SKU 与 JSON 种子逐项比对，并检查筛选、输入拒绝、默认禁写、请求 ID、无缓存和安全响应头。

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

自定义 Ollama Qwen3 服务可设置 `LLM_BACKEND=ollama`；它通过 `reasoning_effort=none` 关闭 thinking。llama.cpp 等其他兼容服务使用 `LLM_BACKEND=openai-compatible` 和实际的 `/v1` 地址、模型名称，不发送 vLLM 专用参数。上述两种模式的 FAST/NORMAL/DEEP 仅调整输出预算，不代表切换 thinking；视觉和其他模型的工具模板须分别验证。当前没有完成普通电脑上的真实 27B 推理验收。

浏览器只发送服务器白名单 `modelProfileId`（`local-qwen3-8b` / `configured`），不接收用户传入的模型 URL、Key 或任意模型名。未传该字段的旧 API 客户端仍使用 `configured`；页面默认显式选择本地 8B。响应头 `X-Model-Profile` 与 `X-Model-Id` 标明实际选择。

当前 API 每次只接受一条用户文本；拒绝浏览器提交的 assistant/tool 历史，防止伪造数据库查询结果。后续多轮历史必须从服务端持久化会话加载。

### 你自己的业务 Skill

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

进入生产使用前，还应接入企业对象存储、真实消息渠道、审批通知和财务汇率。销售助手的“确认并记录”不会自动向外部客户发送消息；图片/附件检索使用文件名与目录特征，不做未经验证的视觉诊断；正式报价不能直接依赖演示价格或固定汇率。
