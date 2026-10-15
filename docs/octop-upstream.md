# Octop 本地运行时

LumaFlow 使用 TencentCloud/Octop 的独立实例承载原生 Dashboard、WebSocket、专家和团队、长期记忆、定时任务、MCP、插件、浏览器、终端、桌面、ACP、备份以及 HTTP API。它和现有 CowAgent 运行时共存，数据根目录不同。

## 固定版本和目录

当前接入上游仓库的固定版本为 `1.0.2b7`，Git commit 为
`664c1fb38e354ea987041aa14b151e20d15ce71f`。安装脚本使用 Python 3.12 或更高版本，创建独立虚拟环境：

```text
.local-runtime/octop/venv/       Python 运行时和已安装 wheel
.local-runtime/octop/install.json 版本、来源和 commit 记录
.local-data/octop/               Octop SQLite、插件、专家、工作区和日志
.local-data/octop/lumaflow.json  本地集成元数据和运行所需私密字段
```

`.local-data/` 和 `.local-runtime/` 已被仓库忽略。管理员密码保存于
`.local-data/octop/owner-credentials.json`，完整/只读网关 key 和 JWT secret 保存于
`.local-data/octop/lumaflow.json`；这些字段不会由脚本打印，也不会提交 Git。
`lumaflow.json` 的 `version` 是 `1.0.2b7`，`schemaVersion` 是 `1`；`jwtSecretEncoding`
为 `base64`，值是数据库原始 secret 的 URL-safe base64 表示（解码时补齐 `=` padding）。

## 安装、初始化和启动

在仓库根目录运行：

```powershell
python scripts/setup-octop.py --source C:\path\to\Octop
.\scripts\start-octop.ps1
```

不传 `--source` 时，脚本从固定 commit 的 GitHub 上游安装。`--source` 适合离线演练和审计已克隆的源码；`--offline` 会禁止 PyPI/Git 网络请求，但要求依赖 wheel 已在 pip 缓存中。重复运行不会删除数据库、工作区、插件或已有账号；发现同名但不是本实例创建的 provider、agent 或团队时会停止并提示人工处理。

若目标机没有 Git，已知 TencentCloud/Octop 上游会回退到固定版本
`octop==1.0.2b7` wheel；`.local-runtime/octop/install.json` 同时记录
`requestedSource`、实际 `source` 和 commit，便于审计。源码 checkout 缺少生成的
Dashboard 时，安装脚本会复用同版本 wheel 中的 `octop/dashboard` 静态资源。

远程 Windows 主机不需要把 `uv` 放进 `PATH`。把经过校验的独立二进制放到
`.local-runtime/tools/uv.exe`，或者显式传入 `--uv D:\tools\uv.exe`。安装默认包含
桌面和 OCR 支持；为控制只有约 14 GiB 可用空间的机器的占用，fastembed/HuggingFace
本地向量模型依赖默认不安装，需要时显式加 `--local-embedding`（该开关本身也不会下载模型）。

远程实例已在隔离环境安装本地向量检索依赖，并启用 `BAAI/bge-small-zh-v1.5` 的 512 维 ONNX 检索；私有文档在本机处理。新安装可执行 `scripts/setup-octop.py --local-embedding` 后运行 `scripts/prepare-work-knowledge.py --repo-root D:/LumaFlow`。网络无法下载模型时，应从已验证的公开模型缓存转移并核对哈希，而不是上传私有文档到云端。

固定上游版本的交互终端原先只支持 POSIX。本项目的 `scripts/patch-octop-windows.py` 为 Windows 增加隔离的 `pywinpty==2.0.15` ConPTY 分支，保留上游认证、会话与 POSIX 实现。补丁核对固定源文件 SHA-256、保存原始文件、支持重复应用和已知旧版本升级；安装流程会自动应用。真实 Windows 测试覆盖启动、尺寸调整、命令计算、读取输出和关闭后的进程回收。

Work wrapper 保留上游 Harness 的完整工具和技能注册，不再为已经删除的 Strata/Qwen
配置注入小上下文的工具压缩或技能屏蔽。Bonsai 的输入和输出上限由网关配置同步到
Octop agent runtime；原生 `tool_search`、审批、记忆和只读策略仍由上游引擎负责。
原生 compact 命令属于上游运行时，本次配置迁移没有把它伪装成已验证的模型推理结果。

只安装并初始化而暂时不做 API bootstrap：

```powershell
python scripts/setup-octop.py --source C:\path\to\Octop --skip-bootstrap
```

检查服务：

```powershell
.local-runtime\octop\venv\Scripts\python.exe scripts\octop-runtime.py status
```

服务只监听 `127.0.0.1:8088`，原生 Dashboard 在
`http://127.0.0.1:8088/`，API 文档在 `/api/docs`。启动脚本遇到已经健康的实例时只复用并验证，不杀其他进程。
服务子进程优先经过仓库内的 `scripts/octop-work-app.py`，由该入口统一处理
`/lumaflow/launch` 的短期 JWT handoff，再调用 Octop 官方 ASGI launcher；wrapper 尚未部署时
安装演练暂时回退到官方 launcher。

## LumaFlow provider 和 Work 团队

bootstrap 会通过 Octop 管理 API 创建两个 OpenAI-compatible provider。完整 provider
供 Work 主执行者和原生团队使用，只读 provider 只供研究员和核验员使用：

| 字段 | 值 |
| --- | --- |
| provider name | `configured`（完整） |
| read-only provider name | `configured-readonly` |
| kind | `openai` |
| base URL | `http://127.0.0.1:3000/api/v1/work-engine/models` |
| managed model ID | `configured`（Ternary Bonsai 2 27B） |
| Octop model ref | `configured/configured` |
| read-only model ref | `configured-readonly/configured` |
| Bonsai metadata | `LLM_CONTEXT_TOKENS` / `LLM_MAX_OUTPUT_TOKENS`；本机有效上限按实测 `16384` / `4096`，更低显式值会保留 |
| temperature | `0` |
| reasoning | disabled |

只读 provider 的名称为 `configured-readonly`，它使用同一个 Bonsai model ID，但拥有独立
的 gateway key。研究员、核验员的 `default_model` 固定为
`configured-readonly/configured`；Work 主执行者和团队使用完整的
`configured/configured`。

两个 provider 都指向同一个 LumaFlow gateway；该 gateway 将 `configured` lease 到
本机已经配置的 Bonsai 2-27B profile。上下文和输出上限由
`LLM_CONTEXT_TOKENS`、`LLM_MAX_OUTPUT_TOKENS` 读取；无有效配置时按实测的 16K/4K
安全上限，不会把旧的 32K/8K metadata 当成实际能力，也不会添加新的 Strata/Qwen 模型。完整 provider 使用
`lumaflow.json` 中的随机 `gatewayKey`，只读 provider 使用独立的随机
`gatewayReadKey`；两个 key 都只写入私密 metadata。父 gateway 必须把
`gatewayReadKey` 视为只读租约，在服务端过滤请求工具和返回的 tool calls，即使 Octop
仍注册了 `task`/`write_todos` 也不能把它们交给只读模型。provider 中早期 bootstrap
生成的、名称仍为 `Strata Coder（LumaFlow 网关）` 的精确旧条目会被清理，其他用户模型
保留。

网关应提供：

```text
GET  http://127.0.0.1:3000/api/v1/work-engine/models
POST http://127.0.0.1:3000/api/v1/work-engine/models/chat/completions
```

首次 bootstrap 会把 Octop active model 设为 `configured/configured`。后续启动只把本实例
早期生成的 `configured/local:strata-coder`（或只读 provider 的对应旧 ref）迁移到 Bonsai；
用户在 Dashboard 中选择的其他 provider/model 会保留。脚本只创建和更新自身
`lumaflow.json` 记录的两个 provider，不会删除其他 provider 或模型。若存在本实例的
`.local-data/octop/acp/opencode.json`，bootstrap 只迁移其中精确的旧 `model`/
`small_model` ref，删除旧显示名的 Strata entry，并把 Bonsai limit 同步到有效 16K/4K；
其他 ACP provider/model 配置保留。

bootstrap 还会创建专用的 Octop workspace 和原生团队：

```text
.local-data/octop/workspaces/work
.local-data/octop/workspaces/researcher  # 研究员自己的会话/日志目录
.local-data/octop/workspaces/verifier    # 核验员自己的会话/日志目录
.local-data/octop/workspaces/team
```

团队成员为 `资料研究员`、`Work执行助手`、`结果核验员`。研究员和核验员各自保留
独立的 `workspace_dir`，因此自己的 `SOUL.md`、`AGENTS.md`、记忆、会话和 checkpoint
不会写入 Work 主角色；两者的 local-shell backend 读取根都指向
`workspaces/work`，用于检查主执行者产物。配置了上游 harness 的 `tools_disabled` denylist：
`write_file`、`edit_file`、`delete`、`execute`、环境写入、浏览器/桌面动作、cron 修改、ACP
委派、团队发现和移动端动作均被禁用；`ls`、`read_file`、`glob`、`grep` 以及网络读取工具保留。
每次 bootstrap 都会通过 API 重新读取工具设置核验 denylist，而不是只依赖系统提示词。
Work 主执行者保留自己的写入工作区和工具审批能力。

这里的“只读”由父 gateway 的 key 级 allowlist 和 Octop 本地 denylist 共同提供。固定版本的
`tool_catalog.py` 把 `ls`、`read_file`、`glob`、`grep`、`write_todos` 和 `task`
标为 `CRITICAL_TOOLS`，API 会从 `tools_disabled` 中移除它们；因此 Dashboard 的
`task`/`write_todos` 仍显示为可用，脚本不会把它们伪装成已禁用。上游
`AgentManager._build_harness_config` 也没有把普通 agent config 中的
`subagents_auto_load`、`todos_enabled` 或 `team_enabled` 全部映射到
`HarnessAgentConfig`（它只对团队 host 特别处理 `subagents_auto_load`），所以这些字段
属于记录的运行提示，不是权限隔离。DeepAgents 的 `task` 子 Agent 会复用父 backend，且
默认 filesystem middleware 会重新挂载文件工具；只要上游仍保留 `task`，不能声称子 Agent
拥有严格的 OS 级只读沙箱。当前脚本因此明确验证非关键 denylist、角色 workspace 与
lead backend root，并把该残余边界留在文档中；若需要严格隔离，应由上游提供受限
backend/API middleware 或使用独立 sandbox 后再启用 task 委派。

上述边界也意味着脚本不会声称已验证“研究员通过 task 派生的子 Agent 的 write_file
一定被拒绝”。主角色模型请求会隐藏 denylist 中的 `write_file`，但当前 Octop/DeepAgents
没有一个由本 bootstrap 注入的 OS 级拒绝层来覆盖 critical `task` 派生图。
本机用固定依赖构造的无网络 Harness 演练已复现这一点：父图加入
`ToolsFilterMiddleware(tools_disabled={"write_file"})` 后，仍可通过 `task` 派生默认
general-purpose 子图，并由子图的 filesystem middleware 写入测试 marker。该演练只验证
上游权限继承路径，不代表真实模型请求已执行；严格隔离仍需受限 backend/API middleware
或独立 sandbox。
固定 commit 的实际内置工具名中，可作为只读请求 allowlist 候选的是：文件读取
`ls`、`read_file`、`glob`、`grep`；时间和网络读取 `current_time`、`web_fetch`、
`tavily_search`、`brave_search`、`google_search`、`kimi_search`、`searchfree_search`；
记忆读取 `memory_search`、`memory_get`；知识库读取 `search_knowledge`；定时任务只读
`cronjob_list`、`cronjob_get`。固定上游没有通用工具名 `web_search`，搜索工具使用上面
的 provider-specific 名称；`delete` 是 DeepAgents filesystem 工具，即使未出现在
Octop tool catalog，也应在只读 gateway 过滤器中拒绝。浏览器、桌面、移动端、发送文件、
环境写入、ACP、`agent_list`/`ask_agent`、`task`、`write_todos` 和所有其他工具默认拒绝。

三个 agent 和团队首次创建时会写入 `proactive-care.enabled=false`，避免空闲时主动消耗
本地 Bonsai 模型或向界面推送消息；用户可以在 Octop Dashboard 对需要的 agent 显式开启。

## JWT handoff 合约

Octop 使用 `HS256`。`lumaflow.json` 的 `jwtSecret` 是数据库 `secrets.jwt` 的 URL-safe base64 表示，claims 与上游一致：

```json
{
  "sub": "<owner id as string>",
  "uname": "<owner username>",
  "role": "admin",
  "iat": 0,
  "exp": 0
}
```

LumaFlow 只应签发短期 handoff token，并把它交给同源的 `/lumaflow/launch` 页面；页面再把 token 放到 Octop 的 `sessionStorage`。永久 owner 密码、完整/只读 gateway key 不应进入浏览器、父页面 localStorage、URL 或日志。若 JWT secret 文件不可读，服务端也可以改为读取 `lumaflow.json` 的路径并在自身进程内签名。

## 安全和边界

脚本不启用 Cloud provider、不替用户登录第三方服务，也不声称启用了移动设备或真实浏览器权限。Octop 本身包含这些能力和对应的 Dashboard/API；是否可用取决于远程 Windows 主机安装的浏览器、桌面会话、MCP/插件凭据和本机模型 gateway。远程部署应在目标电脑执行同一 setup/start 命令，并用 `/api/health`、`/api/providers`、`/api/agents` 和 `/api/teams` 做实测验证。

上游 Octop 以 MIT License 发布，见 `docs/licenses/octop-MIT.txt`。
