<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 天昭灯网产品知识库

本项目的天昭灯网产品知识库位于仓库目录 `knowledge_base/tianzhao-products`。当前快照包含 1887 款产品、7674 张产品详情页截图和 7645 份 OCR 结果；源数据与导出核对均为 PASS。

处理天昭灯网产品查询时，先用以下命令搜索，再打开结果中的原始 JSON 和图片路径核对：

`python knowledge_base/tianzhao-products/search.py "查询词"`

图片 OCR 搜索使用：

`python knowledge_base/tianzhao-products/search.py "查询词" --images`

知识库的 `products.jsonl` 保留每款完整原始 JSON，`images.jsonl` 记录截图归属、OCR 路径、文件大小和 SHA-256。图片是微信小程序产品详情页截图，不是商家原始图片。OCR 可能有误；具体规格、型号和商品编码应以原始 JSON 与截图共同核对。空字段不得自行推断。
