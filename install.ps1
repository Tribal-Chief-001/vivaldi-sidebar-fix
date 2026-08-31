<#
.SYNOPSIS
    Cross-platform Windows PowerShell Installer for Vivaldi Edge-Style Web Panels Mod.
.DESCRIPTION
    Installs edge-panel-mod.js into Vivaldi on Windows, creates backups, injects window.html,
    and runs width expansion on bundle.js.
.EXAMPLE
    .\install.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "⚡ Vivaldi Edge-Style Web Panels: Windows Installer" -ForegroundColor Cyan
Write-Host "==============================================================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Candidate search directories on Windows
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
    Write-Error "[-] Error: Could not locate Vivaldi resources directory on this system.`n    Please verify Vivaldi is installed under %LOCALAPPDATA% or %ProgramFiles%."
    exit 1
}

Write-Host "[+] Detected Vivaldi directory: $VivaldiResourceDir" -ForegroundColor Green

# 1. Backup window.html
$WindowHtml = "$VivaldiResourceDir\window.html"
$WindowOrig = "$VivaldiResourceDir\window.html.orig"
if (-not (Test-Path $WindowOrig)) {
    Write-Host "[+] Creating pristine backup: window.html.orig" -ForegroundColor Yellow
    Copy-Item -Path $WindowHtml -Destination $WindowOrig -Force
}

# 2. Copy edge-panel-mod.js
Write-Host "[+] Installing edge-panel-mod.js into Vivaldi..." -ForegroundColor Green
$ModSrc = "$ScriptDir\src\edge-panel-mod.js"
Copy-Item -Path $ModSrc -Destination "$VivaldiResourceDir\edge-panel-mod.js" -Force

# 3. Inject script tag into window.html
$HtmlContent = Get-Content -Path $WindowHtml -Raw -Encoding UTF8
if ($HtmlContent -notmatch 'src="edge-panel-mod\.js"') {
    Write-Host "[+] Injecting script tag into window.html..." -ForegroundColor Green
    $HtmlContent = $HtmlContent -replace '</body>', '<script src="edge-panel-mod.js"></script></body>'
    [System.IO.File]::WriteAllText($WindowHtml, $HtmlContent, [System.Text.Encoding]::UTF8)
} else {
    Write-Host "[*] Script tag already present in window.html" -ForegroundColor Gray
}

# 4. Patch bundle.js for 88% width expansion
$BundleJs = "$VivaldiResourceDir\bundle.js"
if (Test-Path $BundleJs) {
    Write-Host "[+] Running width expansion patch on bundle.js..." -ForegroundColor Green
    python "$ScriptDir\src\patch-bundle.py" "$BundleJs"
}

Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "[✓] Windows Installation Complete!" -ForegroundColor Green
Write-Host "    - Dedicated close button (X) active"
Write-Host "    - 0 MB instant RAM discard via chrome.tabs.discard() active"
Write-Host "    - 88% max panel width slider enabled"
Write-Host ""
Write-Host "Restart Vivaldi to apply changes." -ForegroundColor Yellow
Write-Host "==============================================================================" -ForegroundColor Cyan
