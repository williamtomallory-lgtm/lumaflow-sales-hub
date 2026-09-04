# LumaFlow Sales Hub

面向照明销售团队的产品知识、客户协作与报价工作台。当前版本把“客户咨询 → 找产品与资料 → 生成待审回复 → 报价 → 跟进 → 管理复盘”做成一个无需外部 AI Key 即可完整运行的本地演示闭环。

## 已实现

- 产品中心：结构化管理产品、型号、SKU、参数、材质、尺寸、场景、供应商、成本、MOQ、库存、状态与关联产品，支持筛选和本地新增
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
- 原生 CSS 设计系统
- Vitest 单元测试与浏览器端到端验收
- ESLint + Next.js Core Web Vitals 规则

## 本地运行

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 数据文件

演示数据已经从组件和业务代码中分离到独立 JSON 文件：

- `src/data/catalog.json`：产品、SKU、参数、库存、资料与产品知识
- `src/data/business.json`：知识库、汇率、报价历史、用户、AI 日志与数据质量问题
- `src/data/crm.json`：客户、联系人、会话、需求、历史报价与跟进任务

业务函数只保留类型、查询和计算逻辑。没有配置数据库时，应用直接读取这些 JSON 文件，方便修改、审查和版本管理。

## 连接 PostgreSQL

1. 复制 `.env.example` 为 `.env.local`，填写真实的 `DATABASE_URL`。
2. 确保目标 PostgreSQL 数据库已经创建。
3. 初始化表结构并把 JSON 数据写入 PostgreSQL：

```bash
npm run db:setup
npm run dev
```

应用启动后访问 [http://localhost:3000/api/data-source](http://localhost:3000/api/data-source)，`source` 为 `postgres` 表示页面正在读取 PostgreSQL；未配置连接时为 `json`。连接异常时默认安全回退为 `json-fallback`，生产环境可设置 `POSTGRES_REQUIRED=true` 禁止回退。

数据库结构位于 `database/schema.sql`，初始化脚本位于 `scripts/seed-postgres.mjs`。连接串只应写入被 Git 忽略的 `.env.local`，不要提交真实密码。

## 验证命令

```bash
npm run lint
npm test
npm run build
```

## 当前数据边界

当前目录内的数据仍是可替换的演示数据，但读取入口已经统一为“PostgreSQL 优先、JSON 兜底”的服务端数据仓库。页面内新增和状态变更目前仍只保存在当前组件会话中，不会写回 PostgreSQL；持久化写入 API、身份认证和权限校验应在正式上线前完成。

进入生产使用前，还应接入企业对象存储、真实消息渠道、审批通知和财务汇率。销售助手的“确认并记录”不会自动向外部客户发送消息；图片/附件检索使用文件名与目录特征，不做未经验证的视觉诊断；正式报价不能直接依赖演示价格或固定汇率。
