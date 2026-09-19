[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CandidateDirectory,

  [Parameter(Mandatory = $true)]
  [ValidateSet("supported", "unsupported")]
  [string]$Scenario
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $ProjectRoot "install.ps1"
$PowerShell = (Get-Process -Id $PID).Path

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-PowerShell {
  param(
    [string[]]$Arguments,
    [hashtable]$Environment = @{}
  )

  $StartInfo = [Diagnostics.ProcessStartInfo]::new()
  $StartInfo.FileName = $PowerShell
  $StartInfo.UseShellExecute = $false
  $StartInfo.RedirectStandardOutput = $true
  $StartInfo.RedirectStandardError = $true
  foreach ($Argument in $Arguments) {
    [void]$StartInfo.ArgumentList.Add($Argument)
  }
  foreach ($Name in $Environment.Keys) {
    $StartInfo.Environment[$Name] = [string]$Environment[$Name]
  }

  $Process = [Diagnostics.Process]::new()
  $Process.StartInfo = $StartInfo
  [void]$Process.Start()
  $StandardOutput = $Process.StandardOutput.ReadToEnd()
  $StandardError = $Process.StandardError.ReadToEnd()
  $Process.WaitForExit()
  return [pscustomobject]@{
    ExitCode = $Process.ExitCode
    StandardOutput = $StandardOutput
    StandardError = $StandardError
    Output = $StandardOutput + $StandardError
  }
}

function Invoke-Installer {
  param(
    [string[]]$Arguments,
    [hashtable]$Environment
  )

  return Invoke-PowerShell -Arguments (@("-NoProfile", "-NonInteractive", "-File", $Installer) + $Arguments) -Environment $Environment
}

if ($Scenario -eq "unsupported") {
  if ($IsWindows) {
    throw "The unsupported scenario must run on a non-Windows matrix leg."
  }
  $MissingCandidateDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("secant-candidate-must-not-be-read-" + [Guid]::NewGuid().ToString("N"))
  $Result = Invoke-Installer -Arguments @("-NoModifyPath") -Environment @{
    SECANT_INSTALLER_CANDIDATE_DIRECTORY = $MissingCandidateDirectory
  }
  Assert-True ($Result.ExitCode -ne 0) "The installer accepted the native unsupported target."
  Assert-True ($Result.Output -match "Unsupported target") "The unsupported-target refusal was not explicit: $($Result.Output)"
  Assert-True (-not (Test-Path -LiteralPath $MissingCandidateDirectory)) "The installer touched the candidate source before refusing the target."
  Write-Output "PowerShell installer refused the native unsupported target before reading candidates."
  exit 0
}

if (-not $IsWindows) {
  throw "The supported PowerShell installer scenario requires Windows x64."
}

$OriginalCandidateDirectory = [System.IO.Path]::GetFullPath($CandidateDirectory)
$OriginalManifest = Get-Content -LiteralPath (Join-Path $OriginalCandidateDirectory "candidate-manifest.json") -Raw | ConvertFrom-Json
$Version = [string]$OriginalManifest.version
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("secant-powershell-installer-" + [Guid]::NewGuid().ToString("N"))
$TestHome = Join-Path $TestRoot "home"
$LocalCandidate = Join-Path $TestRoot "candidate"
$ApplicationDataHome = Join-Path $TestRoot "application-data"
New-Item -ItemType Directory -Path $TestHome -Force | Out-Null

function Reset-LocalCandidate {
  Remove-Item -LiteralPath $LocalCandidate -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $LocalCandidate -Force | Out-Null
  Copy-Item -Path (Join-Path $OriginalCandidateDirectory "*") -Destination $LocalCandidate -Recurse -Force
}

function Update-LocalArchiveDigest {
  $ArchivePath = Join-Path $LocalCandidate "secant-windows-x64.zip"
  $ArchiveDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
  $ManifestPath = Join-Path $LocalCandidate "candidate-manifest.json"
  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  ($Manifest.targets | Where-Object { $_.key -eq "windows-x64" }).archiveSha256 = $ArchiveDigest
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ManifestPath
  $ChecksumPath = Join-Path $LocalCandidate "SHA256SUMS"
  $Checksums = @(Get-Content -LiteralPath $ChecksumPath | ForEach-Object {
    if ($_ -match '  secant-windows-x64\.zip$') { "$ArchiveDigest  secant-windows-x64.zip" } else { $_ }
  })
  Set-Content -LiteralPath $ChecksumPath -Value $Checksums
}

$Environment = @{
  HOME = $TestHome
  USERPROFILE = $TestHome
  SECANT_HOME = $ApplicationDataHome
  SECANT_INSTALLER_CANDIDATE_DIRECTORY = $LocalCandidate
}

$InstallDirectory = Join-Path $TestHome ".secant/bin"
$Executable = Join-Path $InstallDirectory "secant.exe"

function Assert-InstalledCandidateRuns {
  Assert-True (Test-Path -LiteralPath $Executable -PathType Leaf) "The installer did not preserve secant.exe."
  $InstalledVersion = & $Executable --version
  Assert-True ($LASTEXITCODE -eq 0) "The installed executable did not run."
  Assert-True (($InstalledVersion | Out-String).Trim() -eq $Version) "The installed executable reported the wrong version."
}

function Assert-FailurePreservesInstall {
  param(
    [string]$Name,
    [string[]]$Arguments = @("-NoModifyPath"),
    [string]$ExpectedPattern
  )

  $BeforeFailure = (Get-FileHash -Algorithm SHA256 -LiteralPath $Executable).Hash
  $Failed = Invoke-Installer -Arguments $Arguments -Environment $Environment
  Assert-True ($Failed.ExitCode -ne 0) "$Name was accepted: $($Failed.Output)"
  if ($ExpectedPattern) {
    Assert-True ($Failed.Output -match $ExpectedPattern) "$Name did not fail at the expected validation: $($Failed.Output)"
  }
  $AfterFailure = (Get-FileHash -Algorithm SHA256 -LiteralPath $Executable).Hash
  Assert-True ($AfterFailure -eq $BeforeFailure) "$Name changed the existing installation."
  Assert-InstalledCandidateRuns
}

$OriginalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
try {
  Reset-LocalCandidate
  [Environment]::SetEnvironmentVariable("Path", "C:\Windows\System32", "User")
  $PathBeforeDecline = [Environment]::GetEnvironmentVariable("Path", "User")
  $Declined = Invoke-Installer -Arguments @("-NoModifyPath") -Environment $Environment
  Assert-True ($Declined.ExitCode -eq 0) "Latest installation failed: $($Declined.Output)"
  Assert-True ([Environment]::GetEnvironmentVariable("Path", "User") -eq $PathBeforeDecline) "-NoModifyPath changed user PATH."

  Assert-True (Test-Path -LiteralPath (Join-Path $InstallDirectory "LICENSE") -PathType Leaf) "The installer did not install LICENSE."
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallDirectory "THIRD-PARTY-NOTICES.md") -PathType Leaf) "The installer did not install THIRD-PARTY-NOTICES.md."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $ApplicationDataHome "bin"))) "The installer used SECANT_HOME as its installation root."
  Assert-InstalledCandidateRuns

  $InstructionPrefix = "Run this once to persist Secant on your user PATH: "
  $InstructionLines = @($Declined.StandardOutput -split "`r?`n" | Where-Object { $_.StartsWith($InstructionPrefix) })
  Assert-True ($InstructionLines.Count -eq 1) "Declining PATH did not print one exact persistent instruction: $($Declined.Output)"
  $ManualCommand = $InstructionLines[0].Substring($InstructionPrefix.Length)
  $ManualPath = Invoke-PowerShell -Arguments @("-NoProfile", "-NonInteractive", "-Command", $ManualCommand)
  Assert-True ($ManualPath.ExitCode -eq 0) "The printed PATH instruction did not execute: $($ManualPath.Output)"
  $PathAfterManualInstruction = [Environment]::GetEnvironmentVariable("Path", "User")
  Assert-True (($PathAfterManualInstruction -split ";") -contains $InstallDirectory) "The printed instruction did not persist the fixed bin directory."
  $ManualPathAgain = Invoke-PowerShell -Arguments @("-NoProfile", "-NonInteractive", "-Command", $ManualCommand)
  Assert-True ($ManualPathAgain.ExitCode -eq 0) "The printed PATH instruction failed when repeated."
  Assert-True ([Environment]::GetEnvironmentVariable("Path", "User") -eq $PathAfterManualInstruction) "The printed PATH instruction was not idempotent."
  $TrailingSlashPath = "$PathBeforeDecline;$InstallDirectory\"
  [Environment]::SetEnvironmentVariable("Path", $TrailingSlashPath, "User")
  $ManualPathTrailingSlash = Invoke-PowerShell -Arguments @("-NoProfile", "-NonInteractive", "-Command", $ManualCommand)
  Assert-True ($ManualPathTrailingSlash.ExitCode -eq 0) "The printed PATH instruction failed with a trailing-slash entry."
  Assert-True ([Environment]::GetEnvironmentVariable("Path", "User") -eq $TrailingSlashPath) "The printed PATH instruction duplicated a trailing-slash entry."
  [Environment]::SetEnvironmentVariable("Path", $PathAfterManualInstruction, "User")

  Reset-LocalCandidate
  $Exact = Invoke-Installer -Arguments @("-Version", $Version) -Environment $Environment
  Assert-True ($Exact.ExitCode -eq 0) "Exact-version installation failed: $($Exact.Output)"
  $PathAfterExact = [Environment]::GetEnvironmentVariable("Path", "User")
  $Again = Invoke-Installer -Arguments @("-Version", "v$Version") -Environment $Environment
  Assert-True ($Again.ExitCode -eq 0) "Repeated v-prefixed exact-version installation failed: $($Again.Output)"
  Assert-True ([Environment]::GetEnvironmentVariable("Path", "User") -eq $PathAfterExact) "Repeated installation changed user PATH."

  foreach ($InvalidVersion in @("01.2.3", "1.2.3-a..b")) {
    Assert-FailurePreservesInstall "invalid version $InvalidVersion" @("-Version", $InvalidVersion, "-NoModifyPath") "Version must be 'latest'"
  }
  Assert-FailurePreservesInstall "a mismatched exact version" @("-Version", "999.0.0", "-NoModifyPath")

  Reset-LocalCandidate
  Remove-Item -LiteralPath (Join-Path $LocalCandidate "SHA256SUMS")
  Assert-FailurePreservesInstall "a missing candidate download"

  Reset-LocalCandidate
  Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Value "{"
  Assert-FailurePreservesInstall "a malformed candidate manifest" -ExpectedPattern "Malformed candidate-manifest.json"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  $Manifest.version = "01.2.3"
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "a non-semantic candidate version" -ExpectedPattern "version is not semantic"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  $Manifest.PSObject.Properties.Remove("version")
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "an absent manifest field" -ExpectedPattern "version or targets is missing"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  $Manifest.targets = @($Manifest.targets | Where-Object { $_.key -ne "windows-x64" })
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "a missing windows-x64 target" -ExpectedPattern "exactly one windows-x64 target"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  $WindowsTarget = $Manifest.targets | Where-Object { $_.key -eq "windows-x64" }
  $Manifest.targets = @($Manifest.targets) + @($WindowsTarget)
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "duplicate windows-x64 targets" -ExpectedPattern "exactly one windows-x64 target"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  ($Manifest.targets | Where-Object { $_.key -eq "windows-x64" }).os = "linux"
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "a target identity mismatch"

  Reset-LocalCandidate
  Set-Content -LiteralPath (Join-Path $LocalCandidate "SHA256SUMS") -Value ""
  Assert-FailurePreservesInstall "a missing checksum entry"

  Reset-LocalCandidate
  Add-Content -LiteralPath (Join-Path $LocalCandidate "secant-windows-x64.zip") -Value "tampered"
  Assert-FailurePreservesInstall "a tampered archive"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  ($Manifest.targets | Where-Object { $_.key -eq "windows-x64" }).binarySha256 = "0" * 64
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "an inner-binary digest mismatch"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  ($Manifest.targets | Where-Object { $_.key -eq "windows-x64" }).binarySha256 = "not-a-digest"
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "a malformed digest" -ExpectedPattern "malformed SHA-256 digest"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  $Manifest.noticesSha256 = "0" * 64
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "a legal-material digest mismatch"

  Reset-LocalCandidate
  $Manifest = Get-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json") -Raw | ConvertFrom-Json
  $Manifest.version = "999.0.0"
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $LocalCandidate "candidate-manifest.json")
  Assert-FailurePreservesInstall "an executable-version mismatch"

  Reset-LocalCandidate
  $LayoutDirectory = Join-Path $TestRoot "layout"
  Expand-Archive -LiteralPath (Join-Path $LocalCandidate "secant-windows-x64.zip") -DestinationPath $LayoutDirectory
  Set-Content -LiteralPath (Join-Path $LayoutDirectory "unexpected.txt") -Value "unexpected"
  Remove-Item -LiteralPath (Join-Path $LocalCandidate "secant-windows-x64.zip")
  Compress-Archive -Path (Join-Path $LayoutDirectory "*") -DestinationPath (Join-Path $LocalCandidate "secant-windows-x64.zip")
  Update-LocalArchiveDigest
  Assert-FailurePreservesInstall "an unexpected archive layout"

  Reset-LocalCandidate
  Remove-Item -LiteralPath $LayoutDirectory -Recurse -Force
  Expand-Archive -LiteralPath (Join-Path $LocalCandidate "secant-windows-x64.zip") -DestinationPath $LayoutDirectory
  Remove-Item -LiteralPath (Join-Path $LayoutDirectory "LICENSE")
  New-Item -ItemType Directory -Path (Join-Path $LayoutDirectory "LICENSE") | Out-Null
  Remove-Item -LiteralPath (Join-Path $LocalCandidate "secant-windows-x64.zip")
  Compress-Archive -Path (Join-Path $LayoutDirectory "*") -DestinationPath (Join-Path $LocalCandidate "secant-windows-x64.zip")
  Update-LocalArchiveDigest
  Assert-FailurePreservesInstall "a non-file archive entry" -ExpectedPattern "non-file entry"

  Write-Output "PowerShell installer installed and ran the local Windows x64 candidate and preserved it across download and validation failures."
}
finally {
  [Environment]::SetEnvironmentVariable("Path", $OriginalUserPath, "User")
  Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
