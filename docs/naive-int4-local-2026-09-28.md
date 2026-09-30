# Naive N0.5 Flash 原权重本机实验版（2026-09-28）

## 已交付的产物

模型目录：`E:\DataDocument\ChatGPT\NewProject\.local-data\models\Naive-N0.5-Flash-int4-48L-1E`。

它由 [NaiveAI 官方 FP8 权重](https://huggingface.co/NaiveAI/Naive-N0.5-Flash-FP8)的修订 `1cd079a56408064751b45c31da60d3c4ee8dd930` 构建，没有使用其他模型的权重。保留原模型全部 48 层，但每个 MoE 层只保留原 256 个专家中的专家 0；矩阵采用分组 INT4 量化。50 个 safetensors 文件合计 3,712,121,048 字节（3.712 GB）。`NAIVE_INT4.json` 记录了来源、所保留的层与专家及每个张量的转换信息。构建脚本只读取所需的原始张量，没有下载全部约 315 GB 的官方权重。

**能力不达标。** 本机实际加载和生成成功，但中文、数学和英文问答输出乱码、标点或重复词，不能正常聊天，也没有任何“保留 90% 能力”的实测依据。该产物仅证明原权重极端剪枝后可以装进目标容量，并非可用的 Naive 替代品。

## 网站接入和运行边界

本机 `.env.local` 将 `naive-n05-flash-int4-experimental` 加入可见模型。模型菜单显示“Naive N0.5 Flash · 3.7 GB 实验版”；默认模型仍为 Bonsai。此模型指向独立的本机 `127.0.0.1:8083` OpenAI 兼容服务。服务加载完真实模型后，`/health` 才报告就绪。网站模型 API 和浏览器模型菜单均验证过两项列表和选中操作；连接测试时 Naive 显示“已连接，可调用”。

在这台 8 GB 显存、16 GB 内存的电脑上，只加载用户选择的一个模型。网站通过 `scripts/manage-local-model.ps1` 按需卸载另一模型，再等待新模型真实就绪。全局队列、跨进程互斥锁及流式请求租约避免正在生成时切换；已有自动启动任务现在也遵守保存的模型选择。菜单保留 Bonsai 与 Naive，未加载项显示“待加载，选择后启动”。

Naive 将 INT4 packed 权重一次缓存到 GPU，矩阵按 1024 行解码，避免每个 token 反复从 CPU 复制每个小分块；生成后清理临时 CUDA 缓存。修复了模型初始化时误清空 RoPE 频率缓冲的错误。当前服务只保留最后 128 个输入 token、最多生成 16 个输出 token，网站不会因 `finish_reason=length` 自动反复续写。128-token 截断会丢失较早的系统和对话内容，因此不能用于需要完整上下文的任务。

本次真实网站 runtime API 从 Bonsai 切到 Naive 用时 19.31 秒，确认只剩 8083 模型端口；独立发送 53 个 prompt token、最多 4 个输出 token 的中文问题，耗时 2.806 秒，实际输出仍是“。的的的”。此前同类实验存在几十秒至超时的情况，但旧版本的 RoPE/内存行为不同，不能把这两组数据当作严格可比的加速倍数。记录在 `artifacts/naive/optimized-runtime-verification.json`。速度优化没有恢复剪掉的专家或语言能力。

若要单独实验，在项目根目录运行统一管理器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/manage-local-model.ps1 -Profile naive-n05-flash-int4-experimental
```

访问 `http://127.0.0.1:8083/health` 检查 `loaded`、`gpu_packed_weights`、实际加载秒数和 CUDA 占用。切回 `-Profile configured` 即可释放 Naive 并恢复 Bonsai。当前实验仅适合技术验证，不应依赖它完成聊天或业务任务。

构建与推理代码分别位于 `scripts/build-naive-int4.py`、`scripts/run-naive-int4.py`、`scripts/serve-naive-int4.py`。网站接入位于 `src/lib/ai/model-config.ts` 和 `src/lib/contracts/api.ts`。TypeSafe Jev 是结构化语义判断模型，不负责权重量化或 Naive 的文本生成；参考 [TypeSafe System One 文档](https://docs.typesafe.ai/concepts/system-one.md)。
