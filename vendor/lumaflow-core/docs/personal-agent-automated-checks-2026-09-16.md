# 个人 Agent 自动化检查记录（2026-09-16）

这是代码层检查，不是手机微信人工验收结果。

执行：在 backend 使用本机 .venv，运行以下八个测试模块：

- test_agent_capabilities.py
- test_web_channel_registry.py
- test_weixin_attachments.py
- test_weixin_credentials_path.py
- test_scheduler_task_ownership.py
- test_scheduler_channel_resolution.py
- test_scheduler_run_records.py
- test_knowledge_service.py

结果：**57 项通过、1 项失败**。覆盖组合角色策略、通道管理器读取、附件归档/去重/路径限制、微信凭据隔离、任务所属 Agent/实例路由/运行记录及知识服务。

失败项：test_knowledge_service.py::test_build_graph_resolves_encoded_and_anchored_links。

现象：图谱边 ID 在 Windows 返回 `concepts\\health.md` 等反斜线路径；测试期待 `concepts/health.md`。这是图谱路径格式的兼容性问题，尚未修复，不能把本轮说成全绿，也不能单凭此失败认定微信正文收发失效。对应知识可视化需要后续复验。

此外，人工用例文档编号与记录模板均为 PA-01 至 PA-36，36 项一一对应；四份 TXT 测试资料只供手动上传，没有写入正式数据库或自动导入知识库。

手机收发、真实文档正文读取、前端知识库共享检索、记忆重启检索、定时微信实际发送及文件回传，仍须按 [人工验收方案](personal-wechat-agent-test-cases.md) 实际执行。正确拒绝不支持的操作不能冒充该操作已实现。
