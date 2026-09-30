# LumaFlow 本机 PostgreSQL

`Setup-Postgres.ps1` 会在 Windows 项目目录内准备一个可重复运行的 PostgreSQL 17.11 portable cluster。它不安装系统服务、不使用 Docker、不向网卡开放端口，也不会下载模型或写入业务样本。

## 初始化与启动

先确认 portable PostgreSQL 已经存在于：

```text
.local-runtime/postgres-package/extracted/pgsql/bin/
```

然后在仓库根目录运行：

```powershell
.\Setup-Postgres.ps1
```

脚本会：

- 在 `.local-data/postgres/data/` 创建并持久化 cluster；首次初始化使用 UTF-8、`scram-sha-256`，并拒绝 `trust` 规则。
- 只监听 `127.0.0.1:5432`，用 `pg_ctl` 隐藏后台启动，日志写入 `.local-runtime/postgres-server.log` 和 `.local-runtime/postgres-setup.log`。
- 将迁移 owner `lumaflow_owner` 与应用 DML 角色 `lumaflow_app` 分开。应用角色不是超级用户，也没有建库、建角色、建表、TRUNCATE、REFERENCES 或 TRIGGER 权限。
- 通过 `pg` 创建 `lumaflow` 数据库、执行 `frontend/database/schema.sql`、授予应用所需的 `SELECT/INSERT/UPDATE/DELETE` 权限，并验证十张业务表可读。
- 在 `.local-data/postgres-secrets.json` 保存随机本机凭据；该文件具有当前 Windows 用户私有 ACL。连接串只写入被 Git 忽略的 `frontend/.env.local`。
- 合并 `DATABASE_URL`、`POSTGRES_REQUIRED=true` 与 `LUMAFLOW_WRITES_ENABLED=true`，保留 `.env.local` 中的其他配置。旧文件备份在 `.local-data/postgres-env-backups/`，同样不应上传。

脚本不会覆盖非本项目 PostgreSQL。如果 `5432` 已被其他进程监听，会直接报错并保持该进程不变。已有 cluster、角色、表和业务数据会被复用，不会执行清库或插入 fixture；缺少已有 cluster 的 secrets 文件时也会停止，而不是生成无法匹配的新密码。

## 启动器复用模式

项目启动器在发现 `PG_VERSION` 后使用：

```powershell
.\Setup-Postgres.ps1 -StartOnly
```

此模式只启动同一个已初始化 cluster，不重新初始化、不执行 migration/schema、不修改角色或 `.env.local`。需要重新配置时由用户明确运行无参数的完整 Setup。

## 停止与检查

停止本机 cluster（不会删除数据）：

```powershell
.local-runtime/postgres-package/extracted/pgsql/bin/pg_ctl.exe stop `
  -D .local-data/postgres/data -m fast -w
```

可查看状态：

```powershell
.local-runtime/postgres-package/extracted/pgsql/bin/pg_ctl.exe status `
  -D .local-data/postgres/data
```

`frontend/scripts/bootstrap-local-postgres.mjs` 也可以在 cluster 已运行、secrets 文件存在时单独执行；它只负责角色、schema、权限验证和 `.env.local` 合并：

```powershell
node frontend/scripts/bootstrap-local-postgres.mjs
```

脚本的标准输出不会打印数据库 URL、用户名密码或 `.env.local` 内容；失败日志也会屏蔽连接串和密码。不要把 `.local-data/`、`.local-runtime/` 或 `frontend/.env.local` 加入提交。
