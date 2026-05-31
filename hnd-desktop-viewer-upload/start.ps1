$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = if ($env:PORT) { $env:PORT } else { "47855" }
$Url = "http://127.0.0.1:$Port/"
$PidFile = Join-Path $AppDir ".server.pid"
$EdgeProfileDir = Join-Path $AppDir ".edge-profile"
$EdgeCandidates = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)
$ChromeCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

function Test-HndViewer {
  param([string]$ViewerUrl)
  try {
    $response = Invoke-WebRequest -Uri $ViewerUrl -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Find-Browser {
  foreach ($Candidate in ($EdgeCandidates + $ChromeCandidates)) {
    if (Test-Path -LiteralPath $Candidate) {
      return $Candidate
    }
  }
  return $null
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
  Write-Host "Node.js was not found." -ForegroundColor Red
  Write-Host "Install Node.js LTS from https://nodejs.org, then run this file again." -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
  exit 1
}

Set-Location $AppDir

if (-not (Test-HndViewer $Url)) {
  $env:CAMERA_OPEN_BROWSER = "0"
  $env:PORT = $Port
  $process = Start-Process -FilePath $NodeCommand.Source `
    -ArgumentList "`"$AppDir\server.js`"" `
    -WorkingDirectory $AppDir `
    -WindowStyle Hidden `
    -PassThru
  $process.Id | Set-Content -LiteralPath $PidFile

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 200
    if (Test-HndViewer $Url) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    Write-Host "The local server did not start at $Url" -ForegroundColor Red
    Write-Host "Try running this file again, or run: node server.js" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
  }
}

$BrowserPath = Find-Browser
if ($BrowserPath) {
  New-Item -ItemType Directory -Force -Path $EdgeProfileDir | Out-Null
  Start-Process -FilePath $BrowserPath -ArgumentList @(
    "--app=$Url",
    "--window-size=1180,760",
    "--user-data-dir=$EdgeProfileDir",
    "--no-first-run"
  )
  Write-Host "Wi-Fi Endoscope Viewer opened as an app window." -ForegroundColor Green
} else {
  Start-Process $Url
  Write-Host "A Chromium browser was not found. Opened with the default browser: $Url" -ForegroundColor Yellow
}
