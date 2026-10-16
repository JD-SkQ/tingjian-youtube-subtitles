$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) { & '.\setup.ps1' }
& '.\.venv\Scripts\python.exe' -m pip install -r backend/requirements-gpu.txt
if ($LASTEXITCODE -ne 0) { throw 'NVIDIA runtime installation failed. Check network and retry.' }
Write-Host 'CUDA runtime installed locally. Run start.ps1 next.'
