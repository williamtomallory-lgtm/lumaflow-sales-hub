$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $projectRoot 'public\downloads\LumaFlow-Work-Connector-Windows.zip'
$files = @(
  (Join-Path $PSScriptRoot 'work-connector\Start-LumaFlow-Work.cmd'),
  (Join-Path $PSScriptRoot 'work-connector\start-local-work.ps1'),
  (Join-Path $PSScriptRoot 'local-work-bridge.mjs')
)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Create)
try {
  $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($file in $files) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, [System.IO.Path]::GetFileName($file), [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
Write-Host "Packaged $target"
