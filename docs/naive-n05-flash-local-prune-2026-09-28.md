# Naive-N0.5-Flash 本机 3–5 GB 剪枝实验（2026-09-28）

## 结果与边界

用[官方 FP8 权重](https://huggingface.co/NaiveAI/Naive-N0.5-Flash-FP8)的指定修订 `1cd079a56408064751b45c31da60d3c4ee8dd930` 生成了本机产物：

`E:\DataDocument\ChatGPT\NewProject\.local-data\models\Naive-N0.5-Flash-pruned-6L-1E`

7 个 safetensors 文件、76 个张量、权重数据 4,301,669,898 字节，连同头信息的权重文件共 4,301,678,698 字节（4.302 GB）。整个目录包含模型代码和 tokenizer，约 4.309 GB。它保留原模型的词嵌入、输出层、前 6/48 个解码层，并在每个 MoE 层仅保留原 256 个专家中的专家 0。专家 FP8 权重按官方块级反量化为 BF16。单专家路由需在复制出的官方推理代码中作一个分支适配。没有引入另一模型的权重。

**此产物只能证明容量与本机加载、推理可行，不具备可用的语言能力。** 在 RTX 5060 Laptop 8 GB 上实际加载占用约 4,102 MiB CUDA 已分配内存，调用 `generate` 成功，但 3 个正式对话输入都产生乱码/重复词。例：问“请回答：1+1等于几？”时输出 `ऋ propriéऋ proprié...`。因此未将它设为网站或 CowAgent 的可选聊天模型，也没有声称保留 90% 能力。恢复后，网站继续使用原 Bonsai。

## 为什么采用这个实验

官方 [README](https://huggingface.co/NaiveAI/Naive-N0.5-Flash-FP8/blob/main/README.md) 写明 309B 总参数、15.5B 每 token 激活参数，FP8 权重约 315 GB。官方 49 个 safetensors 文件共约 315.1 GB，未发布 3–5 GB 的同模型版本。对这些分片只读取 header 的核算结果是：专家 FP8 约 302.8 GB，其他 BF16 张量约 12.0 GB。3–5 GB 无法保存完整架构的常规 1–8 bit 权重；要达到体积必须极端剪枝或另写运行时。用户已明确接受从 Naive 原权重剪枝、性能下降，但不接受替代模型。

构建器 `scripts/build-naive-pruned.py` 使用 HTTP Range 仅取得保留的原始张量，没有下载 315 GB 全量文件，且输出固定在本机。它可用 `--audit-only` 先验证体积，再在配有 Python/Torch/Transformers 5.17 的隔离环境中构建。输出目录的 `PRUNING.json` 记录源修订和保留范围。重复运行会检查已存在的权重文件与源修订，避免混合不同权重。

诊断命令：`.local-data\venvs\naive\Scripts\python.exe scripts\run-naive-pruned.py "你好" --max-new-tokens 16`。该脚本只做单次本机推理，不启动服务，也不改变网站配置。它在输出后明确提示质量验证失败；运行前需留出显存。

## 验证记录

1. 官方源分片 header 校验：`Expected weight data: 4,301,669,898 bytes`。
2. 产物 safetensors 检查：7 个文件、76 个张量；全部名称与形状同改写后的 Naive 模型 `state_dict` 一致。
3. GPU 加载：`loaded 6.1` 秒，`cuda_mib 4102`；`generate` 成功完成。
4. 真实聊天模板问题：数学、中文问候、Python 函数三个问题均不能得到有意义答复。
5. 实验后恢复 Bonsai，`127.0.0.1:8081` 与网站 `127.0.0.1:3000/api/v1/assistant/health` 均正常。

## 后续可行方向

若必须保留基本语言能力，优先研究保留全部 48 层、对稠密层做低比特量化、在专家中作有依据的选择，并为官方 SWA/DSA 与 MoE 实现专用运行时。3–5 GB 仍是实验目标，不是已验证能正常聊天的结论。TypeSafe Jev 提供结构化语义判断，不是权重量化或大模型推理引擎，不能替代上述转换。[TypeSafe System One 文档](https://docs.typesafe.ai/concepts/system-one.md)说明了其用途。
