<#
.SYNOPSIS
  Builds and registers the Sketchor DXF thumbnail provider so Windows
  Explorer shows previews for .dxf files.

.DESCRIPTION
  1. Builds the crate in release mode (needs the Rust MSVC toolchain).
  2. Copies the DLL to a stable per-user location (registration records
     the DLL path, so it must not move afterwards).
  3. Registers it with regsvr32. The provider writes to HKCU\Software\Classes,
     so no administrator rights are required for a per-user install.
  4. Clears the Explorer thumbnail cache and restarts Explorer so the new
     previews appear.

.PARAMETER SkipBuild
  Register the already-built DLL without rebuilding.

.PARAMETER NoRestart
  Do not clear the cache / restart Explorer (do it yourself later).
#>
param(
  [switch]$SkipBuild,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$crateDir = $PSScriptRoot

if (-not $SkipBuild) {
  Write-Host "Building dxf-thumbnailer (release)..."
  Push-Location $crateDir
  try {
    & cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  } finally {
    Pop-Location
  }
}

$built = Join-Path $crateDir "target\release\dxf_thumbnailer.dll"
if (-not (Test-Path $built)) { throw "DLL not found at $built" }

$installDir = Join-Path $env:LOCALAPPDATA "Sketchor"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$installed = Join-Path $installDir "dxf_thumbnailer.dll"

# Unregister an older copy first (ignore errors), then replace the file.
if (Test-Path $installed) {
  Start-Process regsvr32.exe -ArgumentList "/s /u `"$installed`"" -Wait -ErrorAction SilentlyContinue
}
Copy-Item $built $installed -Force
Write-Host "Installed to $installed"

# Register via a child process so the exit code is captured reliably
# (`& regsvr32 /s` does not always surface $LASTEXITCODE).
$reg = Start-Process regsvr32.exe -ArgumentList "/s `"$installed`"" -PassThru -Wait
if ($reg.ExitCode -ne 0) {
  throw ("regsvr32 failed with exit code $($reg.ExitCode) " +
    "(5 = access denied). Registration did NOT complete.")
}
Write-Host "Registered DXF thumbnail provider."

# Confirm the handler key actually landed (catches a silent registration
# failure that would leave Explorer showing only the generic .dxf icon).
$thumbKey = "HKCU:\Software\Classes\.dxf\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96}"
if (-not (Test-Path $thumbKey)) {
  throw "Thumbnail handler key missing after registration: $thumbKey"
}
Write-Host "Verified thumbnail handler registration."

# Windows 11 Explorer only consults a thumbnail handler for an extension if
# HKLM\Software\Classes\<ext>\ShellEx\{E357FCCD-...} exists -- the handler
# itself may live in HKCU, but the marker must be machine-wide. That needs
# elevation once (UAC prompt); declining leaves Explorer showing icons.
$thumbCat = "{E357FCCD-A995-4576-B01F-234630154E96}"
$clsid = "{6F9E2A31-7C4B-4D8E-9A1F-2B3C4D5E6F70}"
$exts = ".dxf", ".step", ".stp", ".iges", ".igs", ".eps", ".ai", ".svg"
$missing = $exts | Where-Object { -not (Test-Path "HKLM:\Software\Classes\$_\ShellEx\$thumbCat") }
if ($missing) {
  Write-Host "Creating machine-wide thumbnail markers for $($missing -join ', ') (administrator approval)..."
  $cmds = $missing | ForEach-Object { "reg add `"HKLM\Software\Classes\$_\ShellEx\$thumbCat`" /ve /d `"$clsid`" /f" }
  try {
    Start-Process cmd.exe -ArgumentList "/c $($cmds -join ' & ')" -Verb RunAs -WindowStyle Hidden -Wait
  } catch {
    Write-Warning "Elevation declined; Explorer will keep showing icons for $($missing -join ', ')."
  }
}

if (-not $NoRestart) {
  Write-Host "Clearing thumbnail cache and restarting Explorer..."
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db" -Force -ErrorAction SilentlyContinue
  Start-Process explorer.exe
}

Write-Host "Done. Open a folder of .dxf files in Explorer (Large icons view) to see previews."
