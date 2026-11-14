# install.ps1 - Install the zyrk CLI from GitHub releases (latest) or npm (legacy).
#
# Usage:
#   irm https://raw.githubusercontent.com/kingjethro999/zyrk/main/install.ps1 | iex
#   .\install.ps1 -Version v0.9.9   # a specific release
#   .\install.ps1 -Npm              # legacy npm package
#
# npm carries zyrk only up to v0.8.9 while registry publishing is unavailable.
# Newer versions ship as package tarballs attached to GitHub releases, each
# with a SHA-256 file. The digest detects a corrupt or truncated download; it
# comes from the same release as the tarball, so it is not a signature.
#
# The tarball is installed with `npm install --global`, which also fetches
# zyrk's runtime dependencies from the npm registry. This bootstraps the CLI
# only: native project installation on Windows is not available yet.

param(
  [switch]$Npm,
  [string]$Version = $env:ZYRK_VERSION
)

$ErrorActionPreference = "Stop"

$Repo = "kingjethro999/zyrk"
$NpmVersion = "0.8.9"

function Step($msg) { Write-Host "› " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Ok($msg) { Write-Host "✓ " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Note($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Die($msg) {
  Write-Host "✖ " -ForegroundColor Red -NoNewline
  Write-Host "zyrk install: $msg"
  exit 1
}

Write-Host ""
Write-Host "  zyrk " -NoNewline
Write-Host "installer" -ForegroundColor DarkGray
Write-Host ""

# --- prerequisites -----------------------------------------------------------

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "Node.js 24 or newer is required. Install it from https://nodejs.org and retry."
}
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 24) { Die "Node.js 24 or newer is required (found $(node -v))." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Die "npm is required to place the zyrk executable on your PATH."
}
Ok "Node.js $(node -v) and npm $(npm -v)"

# --- install -----------------------------------------------------------------

if ($Npm) {
  Step "Installing zyrk@$NpmVersion from npm (legacy channel)"
  Note "npm cannot update past $NpmVersion; rerun without -Npm for the latest release."
  npm install --global "zyrk@$NpmVersion"
  if ($LASTEXITCODE -ne 0) { Die "npm could not install zyrk@$NpmVersion." }
} else {
  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("zyrk-install-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    if (-not $Version) {
      Step "Resolving the latest zyrk release"
      try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
          -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "zyrk-install" }
      } catch {
        Die "Could not reach GitHub. Check your network, or rerun with -Npm to install zyrk@$NpmVersion."
      }
      $Version = $release.tag_name
    }
    if ($Version -match '^\d+\.\d+\.\d+') { $Version = "v$Version" }
    if ($Version -notmatch '^v\d+\.\d+\.\d+[A-Za-z0-9.+-]*$') {
      Die "Could not determine a release version (got '$Version'). Pass one with -Version vX.Y.Z."
    }

    # npm pack names the tarball <name>-<version>.tgz, for example zyrk-0.9.9.tgz.
    $asset = "zyrk-$($Version.Substring(1)).tgz"
    $base = "https://github.com/$Repo/releases/download/$Version"
    $tgz = Join-Path $work $asset
    $sumFile = Join-Path $work "$asset.sha256"

    Step "Downloading $asset from release $Version"
    try {
      Invoke-WebRequest -Uri "$base/$asset" -OutFile $tgz -UseBasicParsing
    } catch {
      Die "Release $Version has no downloadable '$asset'. Choose another release with -Version, or rerun with -Npm to install zyrk@$NpmVersion."
    }
    try {
      Invoke-WebRequest -Uri "$base/$asset.sha256" -OutFile $sumFile -UseBasicParsing
    } catch {
      Die "Release $Version does not publish '$asset.sha256', so the download cannot be checked. Refusing to install it."
    }

    $expected = ((Get-Content $sumFile -TotalCount 1) -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tgz).Hash
    if (-not $expected -or $actual -ne $expected) {
      Die "SHA-256 mismatch for $asset. The download is corrupt or was altered; nothing was installed."
    }
    Ok "SHA-256 matches the release digest"

    Step "Installing zyrk $($Version.Substring(1)) with npm"
    npm install --global $tgz
    if ($LASTEXITCODE -ne 0) { Die "npm could not install $asset. Check npm's global directory permissions and retry." }
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
}

# --- verify ------------------------------------------------------------------

if (-not (Get-Command zyrk -ErrorAction SilentlyContinue)) {
  Die "zyrk was installed but is not on PATH. Add npm's global bin directory to PATH."
}

$installed = (& zyrk --version 2>$null)
if (-not $installed) { $installed = "(version unavailable)" }
Write-Host ""
Ok "zyrk $installed is ready"
Note "Run 'zyrk --help' to get started."
Note "Update later by running this installer again."
Write-Host ""
