# LumaFlow

> 这是随完整项目提供的 CowAgent 源码快照。当前前端、四模式界面、安装器和模型附件统一位于 [LumaFlow Sales Hub](https://github.com/williamtomallory-lgtm/lumaflow-sales-hub)；线上界面为 [lumaflow-sales-hub.vercel.app](https://lumaflow-sales-hub.vercel.app/)。请从完整项目根目录运行安装器，不要另行启动此处的旧 frontend。下面保留原工程的历史使用说明。

LumaFlow 是一个本地优先的销售知识库与多 Agent 工作台。这个仓库把原先分开的两个工程放在同一处：

- `frontend/`：Next.js 管理界面、知识库、智能搜索、销售助手与模型选择。
- `backend/`：基于 CowAgent 的 Agent 运行时、个人微信与企业微信群通道、多实例路由、定时任务和记忆能力。

## 当前可用功能

- 知识库统一管理产品档案、销售资料和上传原件；销售资料包已作为知识库内部栏目，不再占用独立导航。
- 销售资料包只打包用户明确选择的真实上传原件，同时生成可编辑话术、产品参数和附件清单；任何原件读取失败都会终止打包，避免生成看似完整的空资料包。
- 跟进提醒采用待办列表，显示完整日期、星期、时间和本机时区；新建、完成与重新打开均通过后端保存。
- PostgreSQL 可用时只读取数据库真实记录；未配置 PostgreSQL 时，产品、客户和跟进任务保存在被 Git 忽略的 `.local-data/business/records.json`。测试 fixture 不进入运行时，也不会自动补齐空表。
- 本机演示推理使用 Ollama `qwen3:8b`；模型、知识文件、微信凭据和业务数据不会提交到 GitHub。

## 本机端口

- LumaFlow：`http://127.0.0.1:3000/?ui=agents-v2`
- CowAgent API：`http://127.0.0.1:9876`
- Ollama：`http://127.0.0.1:11434`
- 可选 Bonsai 2 27B 本地推理：`http://127.0.0.1:8081/v1`

所有服务默认只监听 loopback。本机 `.env`、微信凭据、二维码会话、知识文件、数据库、模型权重和运行日志均被 Git 忽略。

已完成本机配置后，可双击根目录 `Start-Local.cmd`，统一启动 Ollama、CowAgent 和 LumaFlow。也可执行 `./Start-Local.ps1 -NoBrowser`。脚本复用已运行的服务，读取 `.local-data/cowagent/config.json`，不下载模型。Agent 数据与微信凭据存放在 `.local-data/cowagent/`；日志写入 `.local-runtime/`。此入口需要已安装依赖和已生成前端生产构建，并不是新电脑的自动安装器。微信持续回复需要电脑开机、联网且未休眠。

## 启动前端

### 本机 Bonsai 2 27B

2026-09-18 本机已实测 Ternary Bonsai 2 27B PTQ1_0（5.95 GB），使用 PrismML 专用 llama.cpp CUDA 运行时，不是把该量化格式导入 Ollama。RTX 5060 Laptop 8GB 显存采用 8K 上下文、单并发、默认关闭思考；不同时加载其他模型。

`Setup-Bonsai.ps1` 可下载并校验固定版本的官方模型与运行时；`Start-Bonsai.ps1` 单独启动模型。配置选择 Bonsai 后，原来的 `Start-Local.cmd` 也会自动启动它。详细配置、实测结果和边界见 [Bonsai 本机部署记录](docs/bonsai-local-deployment.md)。

```powershell
cd frontend
npm ci
npm run build
npm start
```

Windows 新电脑也可以双击 `frontend/Start-LumaFlow.cmd`，由前端引导脚本准备 Node、Ollama、Qwen3 8B 和生产构建。

## 启动 CowAgent

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config-template.json config.json
$env:COW_WEB_PORT = "9876"
$env:COW_LUMAFLOW_UI_URL = "http://127.0.0.1:3000/?ui=agents-v2"
.\.venv\Scripts\python.exe app.py
```

`Qwen/Qwen3.8-Flash-Next` 目前只是模型目录项，不会自动下载。笔记本演示模型使用 Ollama `qwen3:8b`。

## 验证

```powershell
cd frontend
npm test
npm run lint
npx tsc --noEmit
npm run build

cd ..\backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_agent_admin.py tests/test_agent_registry.py tests/test_agent_routing.py tests/test_agent_web_management.py tests/test_channel_agent_types.py tests/test_channel_instances.py tests/test_multi_agent_runtime.py tests/test_web_channel_disconnect.py tests/test_weixin_credentials_path.py tests/test_weixin_attachments.py tests/test_lumaflow_primary_ui.py
```

本次交付的逐项验收结果记录在 [`docs/verification-2026-09-09.md`](docs/verification-2026-09-09.md)。该报告会区分已通过、需要人工扫码以及当前仍未通过的检查。

个人微信扫码登录表示一个真实微信账号接入一个 Agent 实例，并不会把多个软件 Agent 变成同一微信账号里的多个新好友。企业微信群 Agent 使用独立的企业微信机器人凭据。实际扫码与企业微信应用凭据必须由部署者本人提供。

## 微信销售助手使用网站知识

在知识库的「微信 Agent 使用网站知识库」区域，给指定 Agent 授权已上传的可读文件。四份虚构测试 TXT 可通过显式按钮导入独立演示空间，不进入公司上传资料库。微信 Agent 检索时读取网站当前正文，并标注来源；自我介绍使用「我是 LumaFlow 销售助手」。本机桥接配置及验证见 [`docs/website-wechat-knowledge.md`](docs/website-wechat-knowledge.md)。个人微信 iLink 本身只有消息收发能力；朋友圈发布需在同一台 Windows 上保持已登录且可见的微信桌面客户端，由本机桌面桥执行，不会读取微信数据库或凭据。发送“自定义模式(正文)”只生成待发布草稿；随后必须再次发送“确认发布”，收到“已提交”回执后才算把内容交给微信编辑器，最终展示状态仍以微信页面为准。发布器可用环境变量 `LUMAFLOW_MOMENTS_PUBLISHER=windows_desktop` 显式开启（Windows 默认开启）；Linux/macOS 会安全降级为未发布。

本机六场景真实运行及未完成的手机端验收边界见 [`docs/verification-2026-09-17.md`](docs/verification-2026-09-17.md)。

## 来源与许可证

后端基于 [CowAgent](https://github.com/zhayujie/CowAgent) 扩展。仓库按根目录 `LICENSE` 中的 Apache-2.0 条款分发；第三方依赖仍遵循各自许可证。
