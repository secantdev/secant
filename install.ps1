[CmdletBinding()]
param(
  [string]$Version = "latest",
  [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ArchiveName = "secant-windows-x64.zip"
$ExecutableName = "secant.exe"
$LicenseName = "LICENSE"
$NoticesName = "THIRD-PARTY-NOTICES.md"
$ManifestName = "candidate-manifest.json"
$ChecksumsName = "SHA256SUMS"
$RepositoryReleases = "https://github.com/secantdev/secant/releases"

function Get-HostPlatform {
  if ($PSVersionTable.PSEdition -eq "Desktop") {
    return "windows"
  }
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    return "windows"
  }
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::OSX)) {
    return "macos"
  }
  if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Linux)) {
    return "linux"
  }
  return "unknown"
}

function Get-HostArchitecture {
  $Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($Architecture -eq "amd64") {
    return "x64"
  }
  return $Architecture
}

function Assert-SupportedTarget {
  $Platform = Get-HostPlatform
  $Architecture = Get-HostArchitecture
  if ($Platform -ne "windows" -or $Architecture -ne "x64") {
    throw "Unsupported target: the Secant PowerShell installer supports Windows x64; detected $Platform $Architecture. No candidate was downloaded."
  }
}

function ConvertTo-SemanticVersion {
  param(
    [string]$Value,
    [switch]$AllowLeadingV
  )

  # SemVer 2.0.0 is a frozen external grammar. Keeping the recognizer here
  # avoids a package/runtime dependency in the native installer while rejecting
  # leading-zero numeric identifiers and empty dot-separated identifiers.
  $Core = '(?:0|[1-9][0-9]*)'
  $PrereleaseIdentifier = '(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
  $Prefix = if ($AllowLeadingV) { 'v?' } else { '' }
  $Pattern = "^$Prefix($Core\.$Core\.$Core(?:-$PrereleaseIdentifier(?:\.$PrereleaseIdentifier)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$"
  $Match = [regex]::Match($Value, $Pattern)
  if (-not $Match.Success) {
    throw "Invalid semantic version '$Value'."
  }
  return $Match.Groups[1].Value
}

function Resolve-RequestedVersion {
  if ($Version -eq "latest") {
    return "latest"
  }
  try {
    return ConvertTo-SemanticVersion $Version -AllowLeadingV
  }
  catch {
    throw [System.ArgumentException]::new("Version must be 'latest' or an exact semantic version such as 1.2.3.", $_.Exception)
  }
}

function Copy-CandidateFile {
  param(
    [string]$Name,
    [string]$Destination,
    [string]$RequestedVersion
  )

  if ($env:SECANT_INSTALLER_CANDIDATE_DIRECTORY) {
    $Source = Join-Path $env:SECANT_INSTALLER_CANDIDATE_DIRECTORY $Name
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
      throw "Local candidate file is missing: $Source."
    }
    Copy-Item -LiteralPath $Source -Destination $Destination
    return
  }

  if ($RequestedVersion -eq "latest") {
    $ReleaseBase = "$RepositoryReleases/latest/download"
  }
  else {
    $ReleaseBase = "$RepositoryReleases/download/v$RequestedVersion"
  }
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$Name" -OutFile $Destination
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-Digest {
  param(
    [string]$Path,
    [string]$Expected,
    [string]$Description
  )

  if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
    throw "$Description has a malformed SHA-256 digest in $ManifestName."
  }
  $Actual = Get-Sha256 $Path
  if ($Actual -ne $Expected.ToLowerInvariant()) {
    throw "$Description digest $Actual does not match the candidate manifest $($Expected.ToLowerInvariant())."
  }
}

function Read-CandidateTarget {
  param(
    [object]$Manifest,
    [string]$RequestedVersion
  )

  $HasVersion = $null -ne $Manifest.PSObject.Properties["version"] -and [bool]$Manifest.version
  $HasTargets = $null -ne $Manifest.PSObject.Properties["targets"] -and [bool]$Manifest.targets
  if (-not $HasVersion -or -not $HasTargets) {
    throw "Malformed $ManifestName: version or targets is missing."
  }
  try {
    $CandidateVersion = ConvertTo-SemanticVersion ([string]$Manifest.version)
  }
  catch {
    throw [System.IO.InvalidDataException]::new("Malformed ${ManifestName}: version is not semantic.", $_.Exception)
  }
  if ($RequestedVersion -ne "latest" -and $CandidateVersion -ne $RequestedVersion) {
    throw "Requested Secant $RequestedVersion, but the candidate manifest describes $CandidateVersion."
  }

  $Matches = @($Manifest.targets | Where-Object { [string]$_.key -eq "windows-x64" })
  if ($Matches.Count -ne 1) {
    throw "Malformed $ManifestName: expected exactly one windows-x64 target."
  }
  $Target = $Matches[0]
  $Identity = @{
    os = "windows"
    cpu = "x64"
    archive = $ArchiveName
    archiveType = "zip"
    executable = $ExecutableName
    package = "@secantdev/secant-windows-x64"
  }
  foreach ($Field in $Identity.Keys) {
    if ([string]$Target.$Field -ne $Identity[$Field]) {
      throw "Candidate identity mismatch for windows-x64: expected $Field '$($Identity[$Field])'."
    }
  }
  return $Target
}

function Assert-ArchiveChecksum {
  param(
    [string]$ArchivePath,
    [string]$ChecksumsPath,
    [object]$Target
  )

  Assert-Digest $ArchivePath ([string]$Target.archiveSha256) $ArchiveName
  $ExpectedLine = "$(([string]$Target.archiveSha256).ToLowerInvariant())  $ArchiveName"
  $Lines = @(Get-Content -LiteralPath $ChecksumsPath)
  if ($Lines -notcontains $ExpectedLine) {
    throw "$ArchiveName is not listed with its candidate digest in $ChecksumsName."
  }
}

function Assert-StagedCandidate {
  param(
    [string]$StageDirectory,
    [object]$Manifest,
    [object]$Target
  )

  $ExpectedNames = @($ExecutableName, $LicenseName, $NoticesName) | Sort-Object
  $Entries = @(Get-ChildItem -LiteralPath $StageDirectory -Force)
  $ActualNames = @($Entries | ForEach-Object { $_.Name } | Sort-Object)
  if ($Entries.Count -ne $ExpectedNames.Count -or (Compare-Object $ExpectedNames $ActualNames)) {
    throw "$ArchiveName has an unexpected layout: $($ActualNames -join ', ')."
  }
  foreach ($Entry in $Entries) {
    if (-not $Entry.PSIsContainer -and (Test-Path -LiteralPath $Entry.FullName -PathType Leaf)) {
      continue
    }
    throw "$ArchiveName contains a non-file entry: $($Entry.Name)."
  }

  $ExecutablePath = Join-Path $StageDirectory $ExecutableName
  Assert-Digest $ExecutablePath ([string]$Target.binarySha256) $ExecutableName
  Assert-Digest (Join-Path $StageDirectory $LicenseName) ([string]$Manifest.licenseSha256) $LicenseName
  Assert-Digest (Join-Path $StageDirectory $NoticesName) ([string]$Manifest.noticesSha256) $NoticesName

  $ObservedVersion = (& $ExecutablePath --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "$ExecutableName --version exited $LASTEXITCODE."
  }
  if ($ObservedVersion -ne [string]$Manifest.version) {
    throw "$ExecutableName reported version '$ObservedVersion' instead of '$($Manifest.version)'."
  }
}

function Install-StagedCandidate {
  param(
    [string]$StageDirectory,
    [string]$InstallDirectory,
    [string]$BackupDirectory
  )

  $MovedExisting = $false
  try {
    if (Test-Path -LiteralPath $InstallDirectory) {
      Move-Item -LiteralPath $InstallDirectory -Destination $BackupDirectory
      $MovedExisting = $true
    }
    Move-Item -LiteralPath $StageDirectory -Destination $InstallDirectory
  }
  catch {
    if ($MovedExisting -and -not (Test-Path -LiteralPath $InstallDirectory) -and (Test-Path -LiteralPath $BackupDirectory)) {
      Move-Item -LiteralPath $BackupDirectory -Destination $InstallDirectory
    }
    throw
  }

  if ($MovedExisting) {
    Remove-Item -LiteralPath $BackupDirectory -Recurse -Force
  }
}

function Get-ManualPathInstruction {
  param([string]$InstallDirectory)
  $QuotedDirectory = $InstallDirectory.Replace("'", "''")
  return "Run this once to persist Secant on your user PATH: `$bin = '$QuotedDirectory'; `$path = [string][Environment]::GetEnvironmentVariable('Path', 'User'); `$entries = @(`$path -split ';' | ForEach-Object { `$_.TrimEnd('\') }); if (`$entries -notcontains `$bin.TrimEnd('\')) { [Environment]::SetEnvironmentVariable('Path', ((`$path.TrimEnd(';') + ';' + `$bin).TrimStart(';')), 'User') }"
}

function Update-UserPath {
  param([string]$InstallDirectory)

  $UserPath = [string][Environment]::GetEnvironmentVariable("Path", "User")
  $Entries = @($UserPath -split ";" | Where-Object { $_ })
  $AlreadyPresent = $false
  foreach ($Entry in $Entries) {
    if ([string]::Equals($Entry.TrimEnd('\'), $InstallDirectory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      $AlreadyPresent = $true
      break
    }
  }
  if (-not $AlreadyPresent) {
    $NewPath = (($UserPath.TrimEnd(';') + ";" + $InstallDirectory).TrimStart(';'))
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
  }

  $ProcessEntries = @($env:Path -split ";")
  if ($ProcessEntries -notcontains $InstallDirectory) {
    $env:Path = "$InstallDirectory;$env:Path"
  }
}

Assert-SupportedTarget
$RequestedVersion = Resolve-RequestedVersion
$DownloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("secant-installer-" + [Guid]::NewGuid().ToString("N"))
$HomeDirectory = $HOME
$SecantDirectory = Join-Path $HomeDirectory ".secant"
$InstallDirectory = Join-Path $SecantDirectory "bin"
$StageDirectory = Join-Path $SecantDirectory (".bin-stage-" + [Guid]::NewGuid().ToString("N"))
$BackupDirectory = Join-Path $SecantDirectory (".bin-backup-" + [Guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null
try {
  $ManifestPath = Join-Path $DownloadDirectory $ManifestName
  $ChecksumsPath = Join-Path $DownloadDirectory $ChecksumsName
  $ArchivePath = Join-Path $DownloadDirectory $ArchiveName
  Copy-CandidateFile $ManifestName $ManifestPath $RequestedVersion
  Copy-CandidateFile $ChecksumsName $ChecksumsPath $RequestedVersion

  try {
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  }
  catch {
    throw [System.IO.InvalidDataException]::new("Malformed ${ManifestName}: $($_.Exception.Message)", $_.Exception)
  }
  $Target = Read-CandidateTarget $Manifest $RequestedVersion

  Copy-CandidateFile $ArchiveName $ArchivePath $RequestedVersion
  Assert-ArchiveChecksum $ArchivePath $ChecksumsPath $Target

  New-Item -ItemType Directory -Path $SecantDirectory, $StageDirectory -Force | Out-Null
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $StageDirectory
  Assert-StagedCandidate $StageDirectory $Manifest $Target
  Install-StagedCandidate $StageDirectory $InstallDirectory $BackupDirectory
}
finally {
  Remove-Item -LiteralPath $DownloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $StageDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

if ($NoModifyPath) {
  Write-Output (Get-ManualPathInstruction $InstallDirectory)
}
else {
  Update-UserPath $InstallDirectory
}
Write-Output "Installed Secant $($Manifest.version) to $InstallDirectory."
