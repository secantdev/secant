param(
  [Parameter(Mandatory = $true)][string]$Counter,
  [Parameter(Mandatory = $true)][int]$PassAt
)
# See check.sh. Increment the Workspace counter and pass once it reaches PassAt;
# the exit status becomes the Step's Verdict.
$ErrorActionPreference = "Stop"
$n = 0
if (Test-Path $Counter) { $n = [int](Get-Content -Raw $Counter) }
$n++
Set-Content -NoNewline -Path $Counter -Value $n
Write-Output "gate iteration $n of $PassAt"
if ($n -ge $PassAt) { exit 0 } else { exit 1 }
