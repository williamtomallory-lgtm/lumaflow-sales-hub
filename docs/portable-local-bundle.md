# 完整本地安装包

## 换电脑安装

1. 从本仓库下载 ZIP 并解压，或克隆 `main`。
2. 双击 `Setup-LumaFlow.cmd`。自动准备可携带 Node/Python、下载本仓库 Release 的权重分片、逐文件校验、安装依赖。首次需联网，建议预留至少 65GB 磁盘空间。
3. 双击 `Start-LumaFlow.cmd`。启动网站与随仓库提供的 CowAgent 后端；默认关闭模型推理。所有文件位于工程内部，不依赖本机的 `E:` 路径。
4. 确定显存/内存足够时，在 PowerShell 中运行 `scripts/start-portable.ps1 -StartBonsai`。它显式加载 Bonsai 并为新启动的网站开启单模型切换。若网站已在运行，必须先停止属于这个工程的网站进程，再用该选项重启，使设置生效；不要只刷新网页。

安装配置保留已有 `.env/.env.local` 与 `.local-data/cowagent/config.json`，不会覆盖个人配置。新电脑创建的是无个人密钥的本机默认配置，微信二维码登录、云账号、PostgreSQL 与商业服务密钥需重新配置。个人聊天、微信登录状态、原件和客户资料不在公开安装包内。

当前安装支持 Windows x64。Python GPU 实验依赖 CUDA 12.8 对应的 NVIDIA 驱动；模型文件体积不是 RAM/显存预算，也不能保证任意电脑都能运行。

## 权重与状态

| 包 | 实际目录/权重字节 | 状态 |
|---|---:|---|
| Bonsai 2 27B PTQ1_0 | 5,946,648,928 + 629,246,976 视觉投影 | 默认候选；旧本机验证记录在 docs/bonsai-performance-2026-09-28.md |
| LumaFlow Image Lowbit Research Bundle（源自 Qwen-Image-2.1） | 2,904,991,964 | Built with Qwen；图像质量测试失败；Qwen 研究许可证，仅研究/评估 |
| Naive N0.5 Flash 48层/每层1专家 INT4 | 3,719,436,678 | 极端剪枝实验；不能正常聊天，不能作为默认 Agent |
| Muse Glimmer 30B 社区 Q1_0 | 4,849,682,816 | 只发布文本 GGUF；不含视觉组件；尚未验证运行、工具调用或质量；非严格4GB |

模型在 [本仓库 Release](https://github.com/williamtomallory-lgtm/lumaflow-sales-hub/releases/tag/local-bundle-20260929) 中。普通 Git/ZIP 下载含代码、安装器与哈希清单；运行安装器才会取得模型。每个附件低于2GiB；同一包的 `.part001/.part002/...` 拼接成一个 ZIP。不要把每个分片分别解压。`config/local-model-bundle.json` 固定每个分片和解压文件的 SHA-256；安装器支持中断续传，校验失败不会执行或覆盖已有不同文件。

来源、许可证与修改通知在 `model-licenses/`，并随各模型分片发布。图像与 Naive 的原始构建脚本、源修订和每张量转换清单一并保留。Qwen 的研究许可证没有授予商业使用许可。

## 选择安装与检查

```powershell
# 只安装 Bonsai 权重与其运行时；仍准备网站/Agent/Python依赖
.\Setup-LumaFlow.cmd -Models bonsai
# 校验已安装的所有模型，不进行推理
.\Setup-LumaFlow.cmd -VerifyOnly
# 只启动网站和 Agent 后端，无模型加载
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-portable.ps1
# 独立校验或从离线下载目录恢复模型
python scripts/install-local-models.py --verify-only
python scripts/install-local-models.py --offline --cache D:\LumaFlow-downloads
```

Muse 作为独立 GGUF 检查点发布；本次没有把未经验证的 Q1_0 接入自动启动或设为默认 Agent。若要使用，需要支持 Muse 架构的 llama.cpp 运行时，单独进行工具调用和任务质量验证；通过后才配置 Work 使用其本机端点。

## 其他源码与资料

`vendor/lumaflow-core/` 是另一个本地 LumaFlow/CowAgent 工程的完整代码快照，包含最新尚未提交的文档生成、Python 分析、微信文件交付改动；根目录的 Next.js 工作台仍是实际使用的网站。快照有独立上游 LICENSE 与来源记录，运行数据与环境文件未复制。不要在 vendor 的旧 frontend 再启动第二套网站。

天昭 1887 产品/详情截图的完整公开资料在既有 [tianzhao-20260920 Release](https://github.com/williamtomallory-lgtm/lumaflow-sales-hub/releases/tag/tianzhao-20260920)，详见 `knowledge_base/tianzhao-products/README.md`。新的模型 Release 不重复上传该资料包。

## 验证边界

发布时检查代码、类型、单元测试、打包/下载协议和远端附件哈希。不启动本地模型，不将字节校验视为推理或换电脑验收成功。安装器保留实验能力失败状态；完整新电脑实测仍需在满足硬件条件的干净机器上执行。
