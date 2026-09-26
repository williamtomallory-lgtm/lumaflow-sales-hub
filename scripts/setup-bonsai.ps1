#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Start)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot '.local-runtime\bonsai'
$weights = Join-Path $projectRoot '.local-data\models'
New-Item -ItemType Directory -Path $runtime, $weights -Force | Out-Null
$release = 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10683-d8f26ee'
$artifacts = @(
    @{
        Path = Join-Path $weights 'Ternary-Bonsai-2-27B-PTQ1_0.gguf'
        Url = 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-PTQ1_0.gguf'
        Hash = '53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3'
    },
    @{
        Path = Join-Path $weights 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'
        Url = 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'
        Hash = '6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903'
    },
    @{
        Path = Join-Path $runtime 'llama-cuda-12.4.zip'
        Url = "$release/llama-prism-b10683-d8f26ee-bin-win-cuda-12.4-x64.zip"
        Hash = '07a4c945779bda6b0e12e51ad97c55858e126ea903bfdb3053a16cd29d2f2257'
    },
    @{
        Path = Join-Path $runtime 'cudart-12.4.zip'
        Url = "$release/cudart-llama-bin-win-cuda-12.4-x64.zip"
        Hash = '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6'
    }
)

foreach ($artifact in $artifacts) {
    if (Test-Path -LiteralPath $artifact.Path) {
        if ((Get-FileHash -LiteralPath $artifact.Path -Algorithm SHA256).Hash -eq $artifact.Hash) {
            Write-Host "Verified: $(Split-Path $artifact.Path -Leaf)"
            continue
        }
        throw "Existing file failed SHA256 verification: $($artifact.Path). It has not been deleted or overwritten."
    }
    $partial = "$($artifact.Path).partial"
    & curl.exe --fail --location --retry 3 --continue-at - --output $partial $artifact.Url
    if ($LASTEXITCODE -ne 0) { throw "Download incomplete; rerun to resume: $partial" }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $artifact.Hash) {
        throw "SHA256 mismatch: $partial. The downloaded file has not been executed."
    }
    Move-Item -LiteralPath $partial -Destination $artifact.Path
}

$bin = Join-Path $runtime 'bin'
if (-not (Test-Path -LiteralPath (Join-Path $bin 'llama-server.exe')) -or
    -not (Test-Path -LiteralPath (Join-Path $bin 'cublasLt64_12.dll'))) {
    Expand-Archive -LiteralPath $artifacts[2].Path -DestinationPath $bin -Force
    Expand-Archive -LiteralPath $artifacts[3].Path -DestinationPath $bin -Force
}
& (Join-Path $bin 'llama-server.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'The PrismML CUDA runtime could not execute on this machine.' }
Write-Host "Bonsai 2 27B text + vision installed under $projectRoot"
if ($Start) { & (Join-Path $PSScriptRoot 'start-bonsai.ps1') }
