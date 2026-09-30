# 线上前端与完整本机源码

线上地址：[https://lumaflow-sales-hub.vercel.app/](https://lumaflow-sales-hub.vercel.app/)。

GitHub 主仓库保存完整工作台、CowAgent 后端快照、模型构建与安装代码、测试、配置模板和文档。大模型权重放在同仓库 Release，通过安装器按哈希下载；个人环境密钥、微信登录状态和用户聊天记录不属于公开发行文件。

Vercel 从根目录的 Next.js 项目构建当前前端。`.vercelignore` 排除 CowAgent 源码快照、模型权重、运行目录和大型产品截图资料；无需配置或启动模型服务。既有网站认证、存储、模型端点环境配置保持不变。图像 API 的 `maxDuration=300` 是部署平台元数据；本机图像工作器的请求时限仍单独设置。

线上 Image 可打开图片风格和模板、编辑提示词，但不能通过该页面加载本机模型或提交生成请求。线上 Work 继续使用账号与本机连接器配对流程。更新 UI 不代表替访客部署本地 Agent、登录微信或验证模型质量。

当前 README 图片来自实际浏览器渲染。`scripts/capture-workspace-ui.py` 使用独立空白浏览器上下文，隐藏个人项目/历史，只进行导航与界面验证，不发送任务、不运行模型。它会验证模式单选、图片精灵加载和 Image 返回 Chat 关闭生图；对线上网址还验证图像提交保持禁用。

```powershell
# 需要 Python Playwright 和 Chrome；不会请求模型推理
python scripts/capture-workspace-ui.py
python scripts/capture-workspace-ui.py --url https://lumaflow-sales-hub.vercel.app/ --output outputs/production-ui
```
