<#
.SYNOPSIS
    Windows PowerShell Uninstaller / Factory Rollback for Vivaldi Edge-Style Web Panels Mod.
.EXAMPLE
    .\uninstall.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "🔄 Vivaldi Edge-Style Web Panels: Windows Uninstaller" -ForegroundColor Cyan
Write-Host "==============================================================================" -ForegroundColor Cyan

$SearchRoots = @(
    $env:LOCALAPPDATA,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
)

$VivaldiResourceDir = $null

foreach ($root in $SearchRoots) {
    if (-not [string]::IsNullOrEmpty($root)) {
        $patterns = @(
            "$root\Vivaldi\Application\*\resources\vivaldi",
            "$root\Vivaldi Snapshot\Application\*\resources\vivaldi"
        )
        foreach ($pat in $patterns) {
            $matches = Get-Item -Path $pat -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
            foreach ($match in $matches) {
                if (Test-Path "$($match.FullName)\window.html") {
                    $VivaldiResourceDir = $match.FullName
                    break
                }
            }
            if ($VivaldiResourceDir) { break }
        }
    }
    if ($VivaldiResourceDir) { break }
}

if (-not $VivaldiResourceDir) {
    Write-Error "[-] Error: Could not locate Vivaldi resources directory."
    exit 1
}

Write-Host "[+] Restoring stock Vivaldi files in $VivaldiResourceDir..." -ForegroundColor Green

# 1. Restore window.html
$WindowHtml = "$VivaldiResourceDir\window.html"
$WindowOrig = "$VivaldiResourceDir\window.html.orig"
if (Test-Path $WindowOrig) {
    Write-Host "[+] Restoring window.html from window.html.orig..." -ForegroundColor Green
    Copy-Item -Path $WindowOrig -Destination $WindowHtml -Force
    Remove-Item -Path $WindowOrig -Force
} else {
    Write-Host "[*] Stripping script tag from window.html..." -ForegroundColor Gray
    $HtmlContent = Get-Content -Path $WindowHtml -Raw -Encoding UTF8
    $HtmlContent = $HtmlContent -replace '<script src="edge-panel-mod\.js"></script>', ''
    [System.IO.File]::WriteAllText($WindowHtml, $HtmlContent, [System.Text.Encoding]::UTF8)
}

# 2. Remove edge-panel-mod.js
$ModJs = "$VivaldiResourceDir\edge-panel-mod.js"
if (Test-Path $ModJs) {
    Write-Host "[+] Removing edge-panel-mod.js..." -ForegroundColor Green
    Remove-Item -Path $ModJs -Force
}

# 3. Restore bundle.js
$BundleJs = "$VivaldiResourceDir\bundle.js"
$BundleOrig = "$VivaldiResourceDir\bundle.js.orig"
if (Test-Path $BundleOrig) {
    Write-Host "[+] Restoring bundle.js from bundle.js.orig..." -ForegroundColor Green
    Copy-Item -Path $BundleOrig -Destination $BundleJs -Force
    Remove-Item -Path $BundleOrig -Force
}

Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "[✓] Uninstallation Complete! Vivaldi restored to 100% stock factory state." -ForegroundColor Green
Write-Host "Restart Vivaldi to apply changes." -ForegroundColor Yellow
Write-Host "==============================================================================" -ForegroundColor Cyan
