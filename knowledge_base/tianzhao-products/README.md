# 天昭灯网产品知识库

这是天昭灯网微信小程序现有产品资料的本地可检索知识库。知识库从已核验的导出包构建，覆盖产品字段、完整原始 JSON、产品截图路径和 OCR 结果。

## 当前范围

- 产品：1887 款
- 产品页面截图：7674 张
- OCR 结果文件：7645 份
- 源数据核对：PASS
- 导出核对：PASS
- 快照日期：2026-09-20

源资料位于：

`E:\DataDocument\ChatGPT\NewProject\outputs\01a0b6ce-ef4f-70c1-a93f-356639863e1d\天昭灯网现有资料_719款_20260919`

图片保留在源资料文件夹中，知识库通过绝对路径引用，未重复复制约 1.6 GB 图片。

GitHub 完整资料包发布页：

`https://github.com/williamtomallory-lgtm/lumaflow-sales-hub/releases/tag/tianzhao-20260920`

部署代码另含 `src/data/tianzhao-products.json`，Agent 的 `searchKnowledge` 工具可直接检索 1887 款产品；无需访问开发电脑上的绝对路径。

## 文件

- `tianzhao_products.sqlite`：SQLite 全文检索库，含产品表、图片表和 FTS5 索引。
- `products.jsonl`：每行一个产品，包含规范化字段、完整原始 JSON、截图和 OCR 路径。
- `images.jsonl`：每行一张截图，包含归属产品、OCR 路径、大小和 SHA-256。
- `manifest.json`：数量、状态、源路径和数据库完整性结果。
- `search.py`：供 agent 或人工快速搜索。
- `build_kb.py`：源资料更新后重新构建知识库。

## 搜索

```powershell
python E:\DataDocument\ChatGPT\NewProject\knowledge_base\tianzhao-products\search.py "TZ-YML-K6602"
python E:\DataDocument\ChatGPT\NewProject\knowledge_base\tianzhao-products\search.py "新中式 铜材"
python E:\DataDocument\ChatGPT\NewProject\knowledge_base\tianzhao-products\search.py "胡桃木色" --images
```

## 数据边界

产品图片目录保存的是微信小程序产品详情页截图，不是商家原始无水印图片。OCR 字段可能有识别误差；回答具体规格、型号或商品编码时，应打开记录指向的原始 JSON 和截图核对。空字段表示截图中未能可靠确认，不能自行补写。
