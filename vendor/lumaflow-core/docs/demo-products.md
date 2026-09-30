# 演示产品数据

`frontend/database/demo-products.json` 提供 8 条灯具演示记录，字段与
`frontend/src/lib/catalog.ts` 的 `Product` / `Asset` 类型以及
`frontend/src/lib/contracts/api.ts` 的 `productSchema` / `assetSchema` 对齐。

这些记录明确是演示数据：每条产品的 `id`、`model` 和 `sku` 都以 `DEMO-`
开头，名称、参数、供应商、库存、成本和价格均带有演示或模拟标识。文件
不包含客户记录，也不引用需要下载的图片、视频或模型；`assets` 只是用于
界面展示的元数据。

## 导入 PostgreSQL

在 `frontend` 目录执行。数据库连接由 `DATABASE_URL` 提供；脚本不会修改
环境文件，也不会自动创建或清空业务数据。

```powershell
node --env-file-if-exists=.env.local scripts/seed-demo-products.mjs
```

也可以指定另一个同样结构的 JSON 文件：

```powershell
node --env-file-if-exists=.env.local scripts/seed-demo-products.mjs --file path/to/products.json
```

脚本逐条按 `id`、`model`、`sku` 查询并使用参数化 SQL 写入
`products(id, data, updated_at)`。所有检查和插入都在同一个 PostgreSQL
事务内完成：

- 数据相同的已有行会跳过，重复执行不会产生副本；
- 相同 `id` 但内容不同，或 `model` / `sku` 已被其他行占用时，整个事务回滚并拒绝写入；
- 不执行 `DELETE`、`TRUNCATE` 或覆盖更新，因此不会删除或改写演示集合之外的行。

如果尚未初始化表结构，先按项目的数据库说明执行 `npm run db:setup`，再运行
上面的导入命令。导入完成后脚本输出 JSON 摘要，其中包含总数、插入数和跳过数。

## 离线验证

不需要 PostgreSQL 的测试使用内存中的 fake pool，覆盖 JSON 合同、8 条记录、
参数化查询、事务提交、幂等重跑、ID/model 冲突拒绝、回滚和保留其他行：

```powershell
node scripts/seed-demo-products.test.mjs
```

该测试不会联网、不会下载资源，也不会写入实际数据库。
