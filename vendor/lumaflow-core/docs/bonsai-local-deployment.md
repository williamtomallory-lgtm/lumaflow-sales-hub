# Ternary Bonsai 2 27B 本机部署

## 已验证的安装

- 模型：`prism-ml/Ternary-Bonsai-2-27B-gguf`，`PTQ1_0`，5,946,648,928 字节。
- 模型提交：`6ed5e12bf84b7a63069882c91dd9e9218647d17b`。
- SHA256：`53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3`。
- 运行时：PrismML llama.cpp `prism-b10683-d8f26ee`，Windows CUDA 12.4。模型和两个二进制归档均验证 SHA256 后使用，见 `Setup-Bonsai.ps1`。
- 官方来源：[模型卡](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf)、[运行时发布](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10683-d8f26ee)。
- 实测电脑：16GB 内存、RTX 5060 Laptop 8GB 显存；模型服务显存约 6.3GB。权重及运行时放 E 盘，未删除用户文件。

本模型使用专有量化内核，使用上述专用运行时，不依赖 Ollama。原 Ollama 的 `lumaflow-qwen3-8b:latest` 和 `qwen3:8b` 已在用户确认后删除，实际释放 5,225,594,880 字节（共享权重，不是两份 5.2GB）。Ollama 程序未卸载。若需恢复，必须重新下载权重并按项目原脚本重建别名。

## 启动和配置

根目录运行 `./Start-Bonsai.ps1` 单独启动推理，或双击 `Start-Local.cmd` 启动完整项目。首次安装用 `./Setup-Bonsai.ps1 -Start`。安装器不覆盖校验失败的既存文件，也不删除旧模型。

- 模型服务只监听 `127.0.0.1:8081`；别名 `ternary-bonsai-2-27b`。
- 网站：`http://127.0.0.1:3000/`。
- CowAgent：`http://127.0.0.1:9876`。
- 参数：GPU 全层卸载、上下文 8192、单槽、batch 256 / ubatch 128、Flash Attention 开启、默认思考关闭。
- `frontend/.env.local`：`LLM_BACKEND=openai-compatible`、`LLM_BASE_URL=http://127.0.0.1:8081/v1`、`LLM_MODEL=ternary-bonsai-2-27b`、`LLM_DEFAULT_PROFILE=configured`、`LLM_VISIBLE_PROFILES=configured`、输出上限 2048。
- `.local-data/cowagent/config.json`：模型同上，`bot_type=custom`、`custom_api_base=http://127.0.0.1:8081/v1`、`enable_thinking=false`。微信客服 Agent 没有单独固定旧模型，跟随这份配置。
- 私有配置、权重、凭据、业务数据及日志仍全部忽略于 Git；修改前的后端配置已备份在 `.local-data/cowagent/`。

## 2026-09-18 实机验收

1. 原生接口中文问答正确：128 × 6 = 768。首次 CUDA 预热较慢，随后短回答约 32 token/s；此速度不是长上下文或多任务性能承诺。
2. 原生工具调用返回结构化 `lookup_stock` 调用与正确 SKU 参数。
3. 网站真实流式接口返回“我是 LumaFlow 灯饰销售助手……”；不是测试模拟模型。
4. 网站真实 `checkInventory` 工具查询 PostgreSQL 中不存在的测试型号，工具返回 `found=false`；Bonsai 据此明确答复没有库存记录，没有编造。
5. 通过 CowAgent `/message` 调用实际 `wechat-service` Agent，独立测试会话返回“我是 LumaFlow 销售助手，128 乘 6 等于 768”。日志确认调用 `ternary-bonsai-2-27b`。未向联系人发测试消息，也未发布朋友圈。
6. 当前任务不把“本机 Agent 后端验证”说成“手机微信端到端验证”。微信通道保持运行，但需用户在手机端再发消息验证收发。
7. 前端完整 189 个测试、ESLint、TypeScript/生产构建通过。启动脚本语法检查通过；修复 PostgreSQL 子进程等待造成的一键启动卡住问题。

只部署文本模型：没有下载视觉投影器、图片生成模型；当前菜单仅开放 Instant，不宣称已验证全部推理档位。模型迁移本身不扩大朋友圈发布权限，发布仍由已有本地工具处理。
