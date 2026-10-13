# BCCLI installer for Windows (PowerShell)
# Usage:
#   irm https://raw.githubusercontent.com/farijarifriyanto-debug/bccli/main/install.ps1 | iex
$ErrorActionPreference = "Stop"
$tag = if ($env:BCCLI_VERSION) { $env:BCCLI_VERSION } else { "next" }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $major = [int](node -p 'process.versions.node.split(".")[0]')
  if ($major -lt 22) {
    Write-Host "Node.js $(& node --version) is older than 22. Install Node 22+ from https://nodejs.org/ first." -ForegroundColor Yellow
    exit 1
  }
} else {
  Write-Host "Node.js not found. Install Node 22+ from https://nodejs.org/ first, then re-run this script." -ForegroundColor Yellow
  exit 1
}

Write-Host "Installing @botconnector/bccli@$tag ..."
npm install -g "@botconnector/bccli@$tag"

$ver = & bccli --version
Write-Host ""
Write-Host "BCCLI $ver installed." -ForegroundColor Cyan
Write-Host "Next steps:"
Write-Host "  bccli login          # store your BotConnector Cloud API key"
Write-Host "  cd your-project; bccli"
Write-Host ""
Write-Host "Docs: https://botconnector.id/id/download"
