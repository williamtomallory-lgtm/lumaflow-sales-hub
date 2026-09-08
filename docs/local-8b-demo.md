# 本机 8B 演示：模型选择与运行

## 适配范围

本演示使用 **Qwen3-8B Q4_K_M + Ollama**，不是 Qwen3.8-27B。已在 Windows、16GB 内存、RTX 5060 Laptop 8GB 显存上运行真实推理，支持中文文字与受控业务工具；不支持看图/OCR。1TB 硬盘容量不是内存或显存。

模型选择在“销售助手 → 选择模型”：

| 配置 | 用途 | 连接 |
| --- | --- | --- |
| `local-qwen3-8b` | 笔记本真实 8B 演示，页面默认 | 固定 `127.0.0.1:11434/v1`，`lumaflow-qwen3-8b:latest` |
| `configured` | 保留原有 vLLM / 其他兼容模型 | 后端 `.env.local` 中的 `LLM_*` |

客户端不能指定任意 URL、密钥或模型名。切换真实发生在服务器每次推理调用时；不是只换下拉框标题。模型服务须通过 `/models` 广告对应的精确模型 ID 才显示连接成功；健康通过不等同于模型质量通过。

## 安装与启动（Windows）

需要 Node.js 22+、可用的 NVIDIA 驱动、初次下载的网络，以及建议至少 15GB 空闲磁盘。选择空间足够的磁盘放置项目，勿把整个项目放到临时目录。

```powershell
npm ci
npm run local:setup
npm run build
npm run local:up
```

首次安装脚本从官方 GitHub 下载 Ollama 0.33.3 Windows 便携包（约 1.47GB），核对固定 SHA-256 后解压，从 Ollama 下载约 5.2GB 的 `qwen3:8b`，再按 `agent/Qwen3-8B.Modelfile` 创建本地别名。基础权重共享，不因别名复制一份。下载时不要让电脑休眠；模型下载被打断可重新执行 `local:setup`。运行时归档 SHA-256：`52cb36a62e7e501f61514f60212dec7117b6c098811357585e02fffe32d2fcd7`。

所有大文件都在项目目录的 `.local-runtime/` 与 `.local-data/models/`，运行日志在 `.local-data/logs/ollama.log`，均已被 Git 忽略。脚本不写入全局环境变量、不修改已有 PostgreSQL、不使用付费模型 API。若已有 Ollama 监听 11434，会复用该服务，不修改它的模型存储位置与启动参数；此时以原服务的设置为准。

以后重启电脑，只需要在项目目录执行 `npm run local:up`。它会启动本地 Ollama 和 LumaFlow，打开 <http://localhost:3000> 即可。代码更新后先重新 `npm run build`；开发调试也可以在启动模型后使用 `npm run dev`，不要同时启动两个占用 3000 的页面服务。

此脚本只提供 Windows 便携安装。其他系统需自行安装官方 Ollama，运行 `ollama create lumaflow-qwen3-8b:latest -f agent/Qwen3-8B.Modelfile` 并确保其服务监听本机 11434；其他系统尚未实测。

## 日常操作与资源控制

1. 进入“销售助手”，选择“Qwen3 8B · 本机演示”。
2. 等待“模型已连接”，输入如“推荐一款 18W 黑色轨道灯，查库存，并提供参数表”。
3. 点击“调用模型分析”，查看实际工具轨迹和可编辑草稿。
4. 人工核对后复制；系统不会自动发微信、自动报价成交或修改库存。

选择记在当前浏览器 localStorage 中，生成时锁定切换，切换后清空上一模型的回复与工具轨迹。离线时禁用调用并提供刷新按钮。当前 8B 档位都关闭 thinking；FAST/NORMAL/DEEP 分别限制每步输出为 1024/1536/2048 tokens，不代表三个不同模型。

安装脚本新启动的 Ollama 只监听回环地址、关闭云功能，一次只加载一个模型且单请求并行；上下文 8192、Flash Attention、Q8 KV 缓存。首次加载/编译比热启动慢，默认请求超时 120 秒。大段资料应先检索提取，不能把整个文件塞入这个 8K 演示上下文。

页面关闭不会停止模型服务，模型空闲 5 分钟后卸载显存。应用终端按 Ctrl+C 停止页面服务。若其他程序占用了显存，先自行关闭不用的 GPU 程序再重试；不会为运行演示自动关闭你的程序。电力与硬件仍有成本。

## 验证与诚实边界

```powershell
npm run lint
npm test
npm run build
# 以下两个命令需要页面服务已启动
npm run verify:api
npm run verify:local
npm run verify:local -- --recommend
```

`verify:local` 不启动模拟器：验证后端模型目录、实际模型响应头、SSE、真实产品查询与库存工具结果、最终 SKU/库存文本，并从本机 Ollama `/api/ps` 读取加载模型与显存数据。精确 SKU 查询可合法使用 `getProductDetails` 或 `searchProducts`；不能仅凭出现 SKU 文本判定工具调用成功。

`--recommend` 额外验证自然语言选型、规格与附件工具。当前附件工具没有可信下载 URL，服务端会按行处理模型文本，将单行 Markdown 链接转为资料名称，再发送给前端（`X-Output-Policy: attachment-names-v1`）。这不是模型自己保证不编链接，也不是完整的 URL 安全过滤或事实审核；产品、库存及工具结果不被此格式处理改写。未来支持真实下载链接时应改为服务端签发的附件卡片。

当前客户、产品、库存仍为服务端 JSON 演示数据。已有 PostgreSQL 接口不等于本机已配置数据库。真实公司数据、长期客户记忆、工作簿导入、用户鉴权和多用户权限仍需后续实现；此版本不是可直接暴露公网的多人生产系统。模型可能选错产品或理解错需求，最终答复仍须人工审核。

官方依据：[Ollama Qwen3:8b 参数与量化](https://ollama.com/library/qwen3:8b)、[Windows 安装](https://docs.ollama.com/windows)、[OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)。实机记录见 [本机验证记录](verification-local-8b.md)。
