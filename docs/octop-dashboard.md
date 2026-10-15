# Octop Dashboard 构建资产

LumaFlow 使用上游 TencentCloud/Octop 的 Dashboard 构建产物作为本机能力中心的静态资产。上游源码固定在临时目录
`C:\Users\Willi\AppData\Local\Temp\lumaflow-octop-source-20261012`，构建基线为
`664c1fb38e354ea987041aa14b151e20d15ce71f`。

## SheetJS 修复

Dashboard 的 `DocumentPreviewCore` 动态导入 `xlsx`，因此该依赖会进入生产浏览器 bundle。原来的 registry 版本
`^0.18.5` 已切换为 SheetJS 官方安装文档所指向的 0.20.3 tarball：

`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`

精确版本、tarball integrity、package-lock SHA-256 和源修改清单保存在
`config/octop-dashboard-patch.json`。上游只修改了 `dashboard/package.json` 与
`dashboard/package-lock.json`；没有修改 Dashboard 源码、根项目依赖、数据库或安装脚本。

## 可重复构建

在用户仓库根目录执行：

```powershell
./scripts/build-octop-dashboard.ps1
```

脚本会确认固定上游 commit，使用 Dashboard 自己的锁文件运行
`npm ci --ignore-scripts --no-audit --no-fund`，再运行 `npm run build:docker`。如果依赖已安装，重复构建可使用
`-SkipInstall`。构建输出位于上游源码的 `src/octop/dashboard`，脚本最后输出文件数、总字节数和锁文件哈希；它不会执行部署、推送或修改用户仓库的 Next.js 依赖。

## 验证边界

已用 0.20.3 做最小中文工作簿读写回环，确认中文单元格、合计数和 `DocumentPreviewCore` 使用的
`read`、`write`、`utils.decode_range`、`utils.encode_cell`、`utils.format_cell` API 可用，并重新执行
Dashboard 的 `build:docker`。本次没有运行上游完整测试套件，也不在此文档中宣称远程部署已经完成；远程运行时需要由部署流程复制新生成的 `src/octop/dashboard` 资产后再做现场核验。
