# LumaFlow Work 的本地 OpenCode ACP

`scripts/setup-work-coding-agent.py` 为完整 Octop 的 ACP Runner 准备隔离的 OpenCode 1.x。安装目录是
`.local-runtime/opencode`，配置和 ACP 启动器是 `.local-data/octop/acp`；两者都已被仓库忽略。脚本不会使用
`npm -g`，不会覆盖全局 OpenCode 配置，也不会把模型网关 key 写进 OpenCode JSON 或 Octop Runner API。

## 默认模型和可选本地模型

默认模型是 `lumaflow/configured`，对应原有的 Ternary Bonsai 2 27B。`small_model` 也指向这个已配置的本地模型，
所以首次安装不依赖额外模型或实验性模型。没有 catalog metadata 时，内置 fallback 使用 16,384 context tokens 和 2,048 output tokens；
catalog 提供更小的真实上限时，脚本会保留更小值。

私密 `.local-data/octop/lumaflow.json` 可以提供 `modelCatalog`，脚本会把其中具有有效 ID、上下文窗口和输出上限的
本地模型加入同一个 `lumaflow` provider。需要选择可选模型时显式传入其 catalog ID：

```powershell
python scripts/setup-work-coding-agent.py setup --model <local-model-id>
```

显式传入的 ID 不在 catalog 中时 setup 会失败，不会静默改用另一个模型。未指定 `--model` 时使用 metadata 中明确且仍有效的 `workModelId`；
如果该字段是旧的无效选择，则自动回到 `configured`。生成配置只启用 loopback 的 `lumaflow` provider，不能通过云 provider 回退。

## 固定版本和隔离安装

脚本固定官方 npm 包 `opencode-ai@1.19.0`，并核对 npm 官方 metadata 的 tarball integrity。Windows 优先使用
`node_modules/opencode-ai/bin/opencode.exe` 的绝对路径，不依赖 `.cmd` 包装器或 PATH。

由于该 npm 包在安装时先放置一个诊断占位文件，脚本在禁用 npm 生命周期脚本后，只对这个已固定包直接运行它自己的
`postinstall.mjs` 来选择 Windows 平台二进制；这一步仍然留在隔离目录内。

生成的配置固定以下边界：

- `enabled_providers` 只有 `lumaflow`；
- `autoupdate` 为 `false`，`share` 为 `disabled`；
- 模型网关地址来自私密 metadata 的 loopback `gatewayBaseUrl`；
- API key 只通过 `{env:LUMAFLOW_GATEWAY_KEY}` 注入 wrapper 子进程，不写入配置或日志。

网关地址的正常形式是
`http://127.0.0.1:3000/api/v1/work-engine/models`。OpenAI-compatible provider 会在该地址后追加
`/chat/completions`。脚本不配置云 provider，也不会在本地模型不可用时自动切换到云端。

## 安装、注册和验证

在项目根目录执行：

```powershell
python scripts/setup-work-coding-agent.py setup
python scripts/setup-work-coding-agent.py verify
```

`setup` 会固定版本安装、生成 Bonsai 默认配置和 wrapper，并以私密 metadata 中的 owner 信息生成 5 分钟 JWT，调用 Octop 的
`GET /api/acp` 和 `PUT /api/acp/{runner_name}` 注册一个 `lumaflow-opencode-local` Runner。已有同名 Runner 配置不一致时，
脚本使用带数字后缀的新名字，不覆盖用户已有配置。Runner 只保存绝对 Python 路径、wrapper 路径、OpenCode 路径和配置路径，
不保存网关 key。

如果只需要生成本地文件而暂时不注册 Runner，可以执行：

```powershell
python scripts/setup-work-coding-agent.py setup --no-register
```

`verify` 直接运行绝对路径的 `opencode.exe --version`，然后发送 ACP `initialize` 和
`notifications/initialized` 的 stdio JSON-RPC 握手，并检查生成配置中的默认/选中模型确实存在于 provider catalog。LumaFlow Next
尚未启动时，验证仍可检查配置和 ACP 握手；待本机 Work 网关启动后，再运行：

```powershell
python scripts/setup-work-coding-agent.py verify --probe-gateway
```

这一步会使用私密 key 请求 `/api/v1/work-engine/models`，确认 Bonsai `configured` 和当前选中模型都由网关真实暴露，输出中不会显示 key。
除安装阶段从官方 npm registry 下载固定包外，脚本的 API/JWT 操作只访问 loopback 地址，不执行远程命令；远程部署由父流程负责。

模型列表和 `initialize` 握手只能证明配置可读。真实 Work 任务仍需在已部署的 Octop Agent 中执行，并保存实际模型回执、工具状态和最终结果；
本脚本不会把配置检查或 ACP 握手伪装成模型任务成功。

## 协议边界

Octop 上游的 ACP Runner 是用户级配置：`GET /api/acp`、`PUT /api/acp`、`GET/PUT/DELETE /api/acp/{runner_name}`；每个 Agent
另有 `/api/agents/{agent_id}/acp/tool` 控制 `acp_runner` 工具。Runner 使用 `command`、`args`、`env`、`trusted`、
`tool_parse_mode` 和 `stdio_buffer_limit_bytes` 字段。OpenCode 的 ACP 命令是 `opencode acp`，通过 stdio JSON-RPC 工作。

本地配置形状可参考 [config/work-coding-agent.example.json](../config/work-coding-agent.example.json)。上游 Runner 定义见固定
Octop 源码的 `docs/acp.md`；OpenCode 配置、OpenAI-compatible provider 和 ACP 规范分别见：

- <https://opencode.ai/docs/config/>
- <https://opencode.ai/docs/providers/#custom-provider>
- <https://opencode.ai/docs/acp/>

如果 `.local-data/octop/lumaflow.json` 缺失、选中的本地模型不在 catalog、模型网关尚未启动，或 Octop API 没有本机 admin 用户，脚本会失败并给出
不含凭据的原因；它不会退回云模型，也不会伪造 ACP 或模型可用状态。
