[CmdletBinding()]
param([switch]$Quiet)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDirectory = Join-Path $repoRoot ".displayplus-runtime"
$runtimeStatePath = Join-Path $runtimeDirectory "state.json"

if (-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)) {
    if (-not $Quiet) {
        Write-Host "No managed DisplayPlus Music development session is running."
    }
    return
}

$state = Get-Content -LiteralPath $runtimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($state.computerName -ne [Environment]::MachineName -or $state.repoRoot -ne $repoRoot) {
    throw "This session belongs to another computer or checkout and was not stopped."
}

$process = Get-Process -Id ([int]$state.vitePid) -ErrorAction SilentlyContinue
if ($null -ne $process) {
    $expectedStart = [DateTime]::Parse(
        [string]$state.viteStartedUtc,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind)
    $actualStart = $process.StartTime.ToUniversalTime()

    if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 2) {
        throw "PID $($state.vitePid) now belongs to a different process and was not stopped."
    }

    Stop-Process -Id $process.Id -Force
    if (-not $Quiet) {
        Write-Host "[STOP] DisplayPlus Music development server (PID $($process.Id))"
    }
}

Remove-Item -LiteralPath $runtimeStatePath -Force
if (-not $Quiet) {
    Write-Host "DisplayPlus Music development services are stopped."
}
