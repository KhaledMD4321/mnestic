# Builds dist/mnestic_bridge.ankiaddon — the file you upload to AnkiWeb.
# An .ankiaddon is just a zip of the add-on's files at the archive ROOT
# (no wrapping folder). Run:  pwsh scripts/build-ankiaddon.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src  = Join-Path $root 'anki-addon\mnestic_bridge'
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$files = '__init__.py', 'config.json', 'config.md', 'manifest.json' | ForEach-Object { Join-Path $src $_ }
$tmp = Join-Path $dist 'mnestic_bridge.zip'
$out = Join-Path $dist 'mnestic_bridge.ankiaddon'
if (Test-Path $tmp) { Remove-Item $tmp }
if (Test-Path $out) { Remove-Item $out }

Compress-Archive -Path $files -DestinationPath $tmp
Rename-Item $tmp 'mnestic_bridge.ankiaddon'
Write-Host "Built $out"
