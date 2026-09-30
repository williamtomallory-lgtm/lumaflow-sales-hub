# Bonsai 本地推理优化与实测（2026-09-28）

## 实施结果

保留 Ternary Bonsai 2 27B 的 PTQ1_0 权重、视觉投影、32,768 上下文、Q4 KV 缓存和现有模型 ID。更新 `scripts/start-bonsai.ps1`，默认使用实测的 `optimized` 配置：

| 参数 | 原配置 baseline | 默认 optimized |
| --- | ---: | ---: |
| 逻辑批大小 | 256 | 1024 |
| 物理批大小 | 128 | 512 |
| CPU 线程 | 运行时自动 | 8 |
| 提示词快照的主存缓存上限 | 默认 8192 MiB | 1024 MiB |
| 推测解码 | 关闭 | ngram-simple，匹配 12 token，草稿最多 16 token |
| GPU 层 / 并发槽 | 99 / 1 | 99 / 1 |
| Flash Attention | 开启 | 开启 |

这里的 ngram 草稿取自已有上下文，再由原模型验证，不下载第二个模型。缓存上限只限制保留的提示词快照，不缩短 32K 上下文。实验性的 GPU 采样没有显示明确收益，最终配置没有启用。

启动脚本会确认进程路径、完整模型路径和参数；相同配置重复启动会复用进程。切换正在运行的配置须显式传入 `-Restart`，并检查推理槽是否空闲；端口未释放或参数不匹配时直接报错。切换期间应暂停其他客户端提交新请求，空闲检查并非原子化的流量排空机制。

## 与 TensorFold、TypeSafe 的关系

- 参考 [TensorFold](https://github.com/ashhart/TensorFold) 的上下文草稿、提示词缓存和基准方法；核查时 main 为 `34bae79ac97da6c3ab3fe10159cf49633ce8112a`。
- TensorFold 当时有 MLX 和 CUDA 后端，但其支持家族没有 Bonsai PTQ1_0 GGUF。没有安装 TensorFold，也没有把其他模型冒充 Bonsai。实际使用的是已安装的 PrismML 定制 llama.cpp 的 ngram 实现。
- TensorFold 的[精确性约定](https://github.com/ashhart/TensorFold/blob/34bae79ac97da6c3ab3fe10159cf49633ce8112a/docs/recipes/README.md)依赖自己的运行时和逐行计算。本次修改不提供这一保证：短问答、复制测试输出完全一致，摘要措辞存在变化。
- 已按用户指定阅读 TypeSafe 技能与[最新官方文档](https://docs.typesafe.ai/concepts/system-one)。Jev 提供结构化判断，不是 Bonsai 的本地 CUDA 加速器。本次没有新增远程模型依赖或将本地请求改送 Jev。

## 基准方法与结果

机器：Windows，RTX 5060 Laptop 8 GB，i7-14650HX，16 GB 主存。运行时 `b10683-d8f26eec7`。模型端点 `http://127.0.0.1:8081`。

使用 `scripts/benchmark-bonsai.py`：每个配置显式预热，三种固定公开测试文本各运行三次，temperature=0、seed=1234、max_tokens=128，主对比禁用提示词复用；记录真实流式首字延迟、服务器 token 计数/耗时、结束标记、输出 SHA-256 与全文。128 token 是统一的速度测试上限，输出可能截断，不能据此评价完整回答质量。

初次旧进程约 29–30 token/s；重新启动原配置后达到约 32 token/s。因此以下采用**重启复测的原配置**作为比较基线，排除仅靠重启/预热带来的表面收益。测试顺序为原配置、两组候选、原配置复测、最终配置。不是随机化的实验室测量，笔记本负载与功耗会有波动。

| 任务 | 原首字 → 优化首字 | 原生成速度 → 优化生成速度 | 原总耗时 → 优化总耗时 |
| --- | --- | --- | --- |
| 短问答（25 prompt token） | 0.532 → 0.517 秒 | 32.53 → 32.29 token/s | 4.449 → 4.449 秒 |
| 上下文复制（780 prompt token） | 3.208 → 2.796 秒 | 32.05 → 35.24 token/s | 7.184 → 6.400 秒 |
| 摘要（782 prompt token） | 3.211 → 2.809 秒 | 32.01 → 31.87 token/s | 7.179 → 6.794 秒 |

全部为三次中位数。复制任务生成吞吐提高 9.95%，总耗时缩短 10.91%；摘要首字等待缩短 12.52%，总耗时缩短 5.36%；短问答没有实质加速。不可外推成所有任务都快 10%，也不是大型模型质量评测。

单独的缓存探针复用了 778 token，仅重新处理 4 token，首字约 0.23–0.24 秒。提示词缓存原来已开启，该结果仅验证仍然生效，不计入新增优化收益。nvidia-smi 测试中观察到约 6.6 GB 显存占用；不是经过连续采样验证的峰值。

## 本地运行与验证

```powershell
# 使用优化配置；现有自动启动链也调用这个脚本。
npm run local:bonsai

# 启动网站（3000 已在运行时无需重复启动）
npm run dev

# 回退原配置，不更换模型或权重
npm run local:bonsai -- -PerformanceProfile baseline -Restart

# 每次先启动相应配置，再测量；不要并行跑推理任务。
python scripts/benchmark-bonsai.py --label baseline --output artifacts/bonsai/retest-baseline.json
npm run local:bonsai -- -Restart
python scripts/benchmark-bonsai.py --label optimized --output artifacts/bonsai/retest-optimized.json

# 网站上的真实模型和库存工具验证
npm run verify:bonsai -- --output=artifacts/bonsai/app-verification.json
```

验证记录：

- 模型健康、模型目录、32K 上下文及文本/视觉能力均由实时接口确认。
- 在实际网页中输入色温问题，看到 Bonsai 流式回答并完成；浏览器未报告页面错误。启动调参期间页面曾缓存断开状态，点击“刷新模型连接”后恢复并完成发送。
- 视觉接口发送独立的纯红色测试图片，回答“红色”，耗时约 1.34 秒。仅验证视觉链路可用，不代表识别精度评测。
- 网站真实工具链通过：Bonsai 调用了 `checkInventory`，接收 `found=false`，准确回答“暂无库存资料”，全程约 5.58 秒。当前运营产品表为空，因此验证的是未找到时的正确处理，没有创建虚构库存；天昭知识快照仍独立存在，不能当作实时库存。
- 模型配置、生成选项和模型控件的现有 38 项测试全部通过；PowerShell 与 Python 语法检查通过。

原始记录保存在本机 `artifacts/bonsai/`：`baseline.json`、`speculative.json`、`speculative-b1024.json`、`baseline-recheck.json`、`optimized.json`、`comparison.json`、`app-verification.json`、`vision-verification.json`、`runtime-metadata.json` 和 `chat-verified.png`。该目录为 Git 忽略的本地验证产物；本报告与复现脚本可进入版本控制。初轮记录含运行时 API 设置；最终环境元数据另存于 `runtime-metadata.json`，为测量后的快照。后续基准会自动记录 GPU/驱动、可执行文件哈希和经过白名单过滤的启动参数，不保存 API 密钥。

首次网站问答需要处理系统说明和工具定义：此次真实页面请求有约 3,750 个输入 token，模型侧总耗时约 14.15 秒。上表 0.52 秒是短提示词基准，不能当作网站所有请求的首字延迟。长时间闲置后 Windows 显存换页也可能再次增加首字等待。
