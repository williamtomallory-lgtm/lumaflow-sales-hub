# LumaFlow 知识维基

知识库分为三层：原始文件、可重建的 Markdown Wiki、整理规则。原件以 SHA-256 去重并保留下载入口；Wiki 的来源页、主题页、索引、处理记录、维护检查会在上传或人工改分类后更新。页面提供标题与正文节选检索，结果指向来源页和原件。维护检查列出待确认、无法解析、失效链接、孤立页面和同名不同原件。主题页汇编各来源的摘要，不把模型建议当作已核实事实，也不宣称已经完成跨文档 LLM 综合。

本机原件保存在 `.local-data/knowledge/files/`，Wiki 保存在 `.local-data/knowledge/wiki/`。Vercel 使用按 Auth0 账号隔离的私有 Blob 路径；浏览器和公开 URL 无法直接读取 Blob。所有读写仍经过同源检查，云端还要求登录会话。

把本项目安装并运行在另一台电脑时，以上本机路径相对于**那台电脑上的项目目录**，不引用原安装电脑的盘符或文件。每台本机安装各有独立知识库；搬迁与备份步骤见 [一键部署说明](one-click-deploy.md#在另一台电脑保存知识文件)。

## 启用线上上传

1. 在已关联的 Vercel 项目中建立 **Private Blob** store，并关联 Production 环境。确认项目环境变量中出现 `BLOB_READ_WRITE_TOKEN`。当前项目已关联 `lumaflow-knowledge-private`，仅限 Production 环境。Vercel Hobby 在免费额度内可用，超出免费额度后会暂停 Blob 访问。
2. 保留 `REMOTE_KNOWLEDGE_ENABLED=true`、Auth0 配置和 `WORK_PAIRING_SIGNING_KEY`。部署后从知识库页面登录，再使用上传按钮。
3. 当前本机单文件上限为 25 MB；Vercel 服务器接收的单文件上限为 4 MB。界面会在超限时说明，不会显示虚假的上传成功。
4. `TYPESAFE_API_KEY` 可选。配置后，TypeSafe Jev 只负责从固定类别中建议一个分类；正文摘要和来源核对仍由人工或已配置的生成模型负责。密钥仅在服务端使用。

## 维护规则

- 原件不可由 Wiki 修改。任何型号、商品编码和规格以原始 JSON 与截图共同核对。
- 只有真实上传的来源进入私人 Wiki；天昭产品快照仍有独立的可搜索目录。
- Wiki 来源页始终指向原件，主题页指向来源页。人工确认前的模型分类会明确标为待确认。
- TypeSafe Jev 只判断固定分类；若使用它，页面展示的是标记为待核对的原文节选，不把节选称为生成摘要。
- 无可读正文的文件仅归档。维护检查列出待人工确认和无法解析的来源。
- Wiki 内容可从原件元数据重建。不要把衍生摘要当作独立证据。

参考：[Karpathy 的 LLM Wiki 构想](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。
