param([int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Push-Location (Join-Path $root 'platform')
try {
  if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.13 or newer first.' }
  if (!(Test-Path 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE) { throw 'Dependency install failed' } }
  if (!(Test-Path 'dist\index.html')) { & npm.cmd run build; if ($LASTEXITCODE) { throw 'Web build failed' } }
  $env:PV_PORT = [string]$Port
  & node --env-file-if-exists=.env server/index.mjs
} finally { Pop-Location }
