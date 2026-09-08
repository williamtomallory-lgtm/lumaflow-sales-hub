# 本地销售 Agent 验证记录

验证日期：2026-09-07。验证范围是模型接入骨架、应用 Skill 加载、工具数据来源、前端未连接状态；不代表完成真实 Qwen 或真实公司数据库验收。

| 检查 | 结果 |
|---|---|
| `npm run lint` | 通过 |
| `npm test` | 10 个文件，57 个测试通过 |
| `npm run build` | 生产构建与 TypeScript 通过 |
| `npm audit --omit=dev --audit-level=high` | npm 官方 registry 返回 0 个漏洞 |
| `npm run verify:api` | 22 项通过；数据源 JSON，PostgreSQL 未配置 |
| 普通启动与浏览器 | 首页与销售助手显示正常，无浏览器错误或框架错误层 |
| 模型未连接状态 | 模型调用按钮禁用；规则草稿和未持久化状态明确显示 |
| `/api/v1/assistant/skills` | 返回从文件加载的四个 Skill 及版本；永久记忆标识为未实现 |
| 生产文件跟踪 | 包含 `agent/profile.json` 和四个 Skill JSON；未包含 `.env.local` |
| 客户端构建内容 | 未找到种子 SKU、模型服务地址变量、密钥变量或 Skill 指令正文 |

`assistant-route.test.ts` 使用真实 POST 处理器、AI SDK、Skill 加载器、JSON Repository 和业务工具，只把模型 HTTP 响应替换为内存中的模拟流。测试证明三轮请求完成“加载 Skill → 查询产品 → 查询库存 → 返回 SSE”，且模型收到的产品记录没有成本和供应商字段。它同时检查伪造 assistant/tool 历史返回 422、跨域请求返回 403、未配置模型返回 503。

`skill-profile.test.ts` 还验证：修改 Skill 文件后下一次加载读取新版本、任意 SQL 工具被拒绝、越界 Skill 路径被拒绝。`model-options.test.ts` 经真实 SDK 请求序列化验证 vLLM 专用参数与通用兼容参数的区别，并拒绝空的模型列表冒充健康服务。

仍需实机验收：Qwen3.8-27B 的推理质量、视觉输入、性能与硬件配置；真实 PostgreSQL 读写；Excel 导入、长期记忆、重启保留、客户隔离和安装升级。浏览器本次未完成连接模型后的流式交互验收；已通过的模型协议证据来自内存模拟测试。
