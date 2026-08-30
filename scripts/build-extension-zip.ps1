# Builds dist/mnestic-extension.zip — the file you upload to the Chrome Web Store.
# The zip must have manifest.json at its ROOT (not inside an "extension" folder).
# Run:  pwsh scripts/build-extension-zip.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src  = Join-Path $root 'extension'
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$out = Join-Path $dist 'mnestic-extension.zip'
if (Test-Path $out) { Remove-Item $out }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $out
Write-Host "Built $out"
