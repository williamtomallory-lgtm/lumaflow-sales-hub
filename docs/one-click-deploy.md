# LumaFlow 一键部署（Windows 优先）

`Start-LumaFlow.cmd` 是新电脑上的入口。把项目目录解压或克隆到一个可写位置后，双击它即可启动本机 LumaFlow；项目路径可以包含空格。启动器不安装 Windows 服务、不写系统目录、不需要 Codex 或付费 API，也不会按进程名结束其他程序。

## 首次启动

在 Windows 10/11 x64 上需要：

- 可写的项目目录；
- 首次运行可访问 `nodejs.org`、npm registry、GitHub Releases 和 Ollama 模型仓库的网络；
- Node/Ollama 运行时与 8B 模型需要数 GB 磁盘空间。8B 权重约 5.2 GB，14B 约 9 GB；实际占用取决于 Ollama 缓存和系统；
- 建议至少 16 GB 内存。8B 是默认档，14B 可能使用 CPU/GPU 混合并明显变慢。

双击项目根目录的 `Start-LumaFlow.cmd`。启动流程会：

1. 使用已有的 Node.js 22+；若没有，则下载固定的官方 Node.js `22.23.2` win-x64 zip 到 `.local-runtime/`，先核对 SHA-256，再解压到项目目录。整个过程不需要管理员权限。
2. 首次缺少依赖或 `package-lock.json` 改变时运行 `npm ci --no-audit --no-fund`；后续运行复用已匹配的 `node_modules`。
3. 仅当 `.env.local` 和 `.env` 都不存在时，才根据 `.env.example` 创建带有明确 `DATA_SOURCE=json`、空 `DATABASE_URL` 的本地演示 `.env.local`。已有环境文件一律保留，不会覆盖或打印其中的值。内置 `local-qwen3-8b`/`local-qwen3-14b` 档位使用 loopback Ollama，不需要付费 API key。
4. 使用项目内固定 Ollama 运行时；默认缺少 `lumaflow-qwen3-8b:latest` 时拉取 8B 模型。已存在的运行时、模型 blob 和服务会复用，不会重复下载。
5. 首次启动或源文件、依赖锁文件、Next 配置、环境文件改变时运行 `next build`；否则复用已有 `.next` 生产构建。
6. 只绑定 `127.0.0.1`，等待 `/api/v1/health` 与所选模型的 `/api/v1/assistant/models` 检查都成功后，打开 `http://127.0.0.1:3000`。

模型服务关闭或启动失败时，错误会指出日志位置。启动器不会因为端口占用而杀进程：如果 3000 被其他程序占用，会安全失败并显示 PID（能读取时）以及替代端口提示。

## 可选参数

需要 14B 或其他 loopback 端口时，在 PowerShell 中运行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Action start -Model 14b
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Action start -Port 3001
```

`-NoBrowser` 只跳过自动打开浏览器；`-PreferPortableNode` 强制使用项目内固定 Node；`-Action setup` 只完成运行时、依赖、环境文件和模型准备，不启动 Next.js；`-Action check` 只检查 Node 与依赖。正常入口不需要这些选项。

## 日志与保留的数据

- `.local-data/logs/bootstrap.log`：每次启动的步骤、错误和健康检查进度；
- `.local-data/logs/next-app.log` 与 `.local-data/logs/next-app.log.error.log`：Next.js 子进程输出；
- `.local-data/logs/ollama.log`：本机 Ollama 服务输出；
- `.local-runtime/`：固定 Ollama/Node 运行时及下载压缩包；
- `.local-data/models/`：Ollama 模型数据；
- `.local-data/npm-install-state.json`、`.local-data/next-build-state.json`：只保存锁文件/构建输入的 SHA-256 和版本元数据，不保存密钥。

这些目录已经被 `.gitignore` 排除。不要把 `.env.local`、`.env` 或模型目录提交到仓库。

## 故障处理

如果端口冲突，先查看启动器给出的 PID/进程名；也可以换用 `-Port 3001`。不要用 `taskkill /IM node.exe` 或按名称结束进程，因为那可能影响其他项目。

如果 Node 下载失败，检查网络代理/防火墙后重试。压缩包必须匹配启动器内固定的 SHA-256；校验失败会拒绝解压和执行。如果项目内固定 Node 目录不完整，启动器会拒绝覆盖它，请只删除错误消息中明确指出的那个版本目录后重试。

如果模型下载中断，重新运行入口即可让 Ollama 继续使用本地 blob。若启动器提示模型未就绪，先查看 `ollama.log`；不要把日志中的环境变量内容复制到公开渠道。

## 手动/开发命令

这些是现有项目的手动等价命令，启动器不会修改 `package.json`：

```powershell
npm ci
npm run local:setup -- --model=8b
npm run local:up -- --model=8b --port=3000
```

如需仅做部署检查，可运行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Action check -SkipModelSetup
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.tests.ps1
```

## 验证边界

2026-09-08 验证：PowerShell 5.1 和 7 各通过 19 项 helper 检查。在带空格的独立部署目录中，实际下载并校验便携 Node 22.23.2、运行 npm ci、校验和解压 Ollama 缓存包、生产构建并启动 3010；重复启动复用服务，源码变化后只重建本目录的应用。生产接口真实调用 8B 查询库存通过。根目录入口也从另一个工作目录直接运行成功；遇到其他部署占用端口时退出，未终止对方进程。

该测试复用了本机已安装的模型权重与 Ollama 服务，并非重装操作系统或在另一台物理电脑上测试；没有为验收重复下载约 5.2GB 权重。新电脑的网络、显卡驱动、磁盘余量和速度仍取决于现场环境。详细记录见 [Chat-AI 与部署验收](verification-2026-09-08-chat-ai.md)。
