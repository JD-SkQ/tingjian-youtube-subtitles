$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
}
& '.\.venv\Scripts\python.exe' -m pip install -r backend/requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network and retry.' }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
Write-Host 'Installed. Run start.ps1, then load the extension folder in edge://extensions.'

