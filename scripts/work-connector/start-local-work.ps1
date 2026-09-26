$ErrorActionPreference = 'Stop'

function Show-Problem([string]$Message) {
  Write-Host ''
  Write-Host $Message -ForegroundColor Yellow
  Write-Host '打开 https://lumaflow-sales-hub.vercel.app/work-setup 查看连接步骤。'
  exit 1
}

function Find-Node {
  $candidate = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($candidate) {
    try {
      $version = & $candidate.Source --version
      if ([version]($version -replace '^v', '') -ge [version]'22.0.0') { return $candidate.Source }
    } catch { }
  }

  # Fixed official Node.js release. The archive hash is from the release's SHASUMS256.txt.
  $version = '22.23.2'
  $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  switch ($architecture) {
    'X64' { $platform = 'win-x64'; $expectedHash = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97' }
    'Arm64' { $platform = 'win-arm64'; $expectedHash = 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3' }
    default { Show-Problem '此连接包目前支持 Windows x64 和 ARM64。' }
  }
  $root = Join-Path $env:LOCALAPPDATA 'LumaFlow\WorkConnector\runtime'
  $name = "node-v$version-$platform"
  $nodePath = Join-Path $root "$name\node.exe"
  if (Test-Path -LiteralPath $nodePath -PathType Leaf) { return $nodePath }

  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $archive = Join-Path $root "$name.zip"
  Write-Host '首次启动：正在下载运行环境，请稍候（约 30–40 MB）…'
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/download/release/v$version/$name.zip" -OutFile $archive -UseBasicParsing -TimeoutSec 180
  } catch { Show-Problem '运行环境下载失败，请检查网络后再次双击启动器。' }
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { Show-Problem '运行环境校验失败，已停止启动。请重新下载连接包。' }
  Expand-Archive -LiteralPath $archive -DestinationPath $root -Force
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { Show-Problem '运行环境未能解压，请重新双击启动器。' }
  return $nodePath
}

function Find-CowAgent {
  if ($env:COWAGENT_BASE_URL) {
    $configured = $env:COWAGENT_BASE_URL.TrimEnd('/')
    if ($configured -notmatch '^https?://(127\.0\.0\.1|localhost|\[::1\]):\d+$') {
      Show-Problem 'CowAgent 地址必须是这台电脑的本机地址。'
    }
    $bases = @($configured)
  } else {
    $bases = @('http://127.0.0.1:9876', 'http://127.0.0.1:9899')
  }
  foreach ($base in $bases) {
    try {
      $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 3
      if ($health.status -eq 'ok' -or $health.ok -eq $true) { return $base }
    } catch { }
  }
  return $null
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'local-work-bridge.mjs') -PathType Leaf)) {
  Show-Problem '连接器文件不完整。请先解压整个 ZIP 文件，再双击启动器。'
}

Write-Host 'LumaFlow Work 正在连接这台电脑…' -ForegroundColor Green
$cowAgent = Find-CowAgent
if (-not $cowAgent) {
  Show-Problem '还没找到正在运行的 CowAgent。请先安装并打开 CowAgent，然后重新双击启动器。'
}
Write-Host '已找到本机 CowAgent。'

try {
  $response = Invoke-WebRequest -Uri 'http://127.0.0.1:9877/health' -Headers @{ Origin = 'https://lumaflow-sales-hub.vercel.app' } -UseBasicParsing -TimeoutSec 2
  if ($response.StatusCode -eq 200) {
    Write-Host '连接器已经在运行。请回到原窗口查看配对码；找不到时，关闭原窗口后重新双击。' -ForegroundColor Yellow
    Read-Host '按 Enter 关闭这个窗口' | Out-Null
    exit 0
  }
} catch { }

$node = Find-Node
$env:COWAGENT_BASE_URL = $cowAgent
$env:LUMAFLOW_SIMPLE_START = '1'
Write-Host '保持此窗口打开，回到网站输入下面的配对码。' -ForegroundColor Green
Write-Host ''
& $node (Join-Path $PSScriptRoot 'local-work-bridge.mjs')
if ($LASTEXITCODE -ne 0) { Show-Problem '连接器意外停止，请检查上面的提示并重试。' }
