[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 5173,
    [ValidateRange(0, 3600)]
    [int]$AutoStopSeconds = 0,
    [switch]$SkipDependencies,
    [switch]$SkipQr
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-External {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Find-CommandPath {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string[]]$FallbackPaths = @()
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }

    foreach ($fallbackPath in $FallbackPaths) {
        if (Test-Path -LiteralPath $fallbackPath -PathType Leaf) {
            return $fallbackPath
        }
    }

    throw "$Name is not installed or is not available in PATH."
}

function Test-Ipv4Address {
    param([Parameter(Mandatory)][string]$Address)

    $parsed = $null
    return [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -and
        $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
        $Address -ne "0.0.0.0" -and
        $Address -notlike "127.*" -and
        $Address -notlike "169.254.*"
}

function Get-LanIpv4Address {
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq "Alive" -and $_.NextHop -ne "0.0.0.0" } |
        Sort-Object @{ Expression = { $_.RouteMetric + $_.InterfaceMetric } })

    foreach ($route in $routes) {
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
            Where-Object {
                $_.AddressState -eq "Preferred" -and
                (Test-Ipv4Address -Address $_.IPAddress)
            })

        if ($addresses.Count -gt 0) { return $addresses[0].IPAddress }
    }

    throw "No active LAN IPv4 address was found. Connect this computer to the same network as the phone."
}

function Wait-HttpReady {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 30
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            return Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
    while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for $Uri."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDirectory = Join-Path $repoRoot ".displayplus-runtime"
$runtimeStatePath = Join-Path $runtimeDirectory "state.json"
$stopScriptPath = Join-Path $PSScriptRoot "stop-qr.ps1"
$viteProcess = $null
$runtimeStarted = $false

Push-Location $repoRoot

try {
    if (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf) {
        throw "A previous DisplayPlus Music session was not closed. Run Stop-DisplayPlusMusic-Current.cmd first."
    }

    $npmPath = Find-CommandPath -Name "npm.cmd" -FallbackPaths @("C:\Program Files\nodejs\npm.cmd")
    $nodePath = Find-CommandPath -Name "node.exe" -FallbackPaths @("C:\Program Files\nodejs\node.exe")
    $viteScript = Join-Path $repoRoot "node_modules\vite\bin\vite.js"
    $evenHubPath = Join-Path $repoRoot "node_modules\.bin\evenhub.cmd"

    if (-not $SkipDependencies -and
        ((-not (Test-Path -LiteralPath $viteScript -PathType Leaf)) -or
         (-not (Test-Path -LiteralPath $evenHubPath -PathType Leaf)))) {
        Write-Host "[1/4] Installing locked project dependencies..."
        Invoke-External -FilePath $npmPath -Arguments @("ci")
    }
    else {
        Write-Host "[1/4] Project dependencies are ready."
    }

    if (-not (Test-Path -LiteralPath $viteScript -PathType Leaf)) {
        throw "Vite was not installed."
    }
    if (-not (Test-Path -LiteralPath $evenHubPath -PathType Leaf)) {
        throw "The Even Hub CLI was not installed."
    }

    $occupiedPort = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $occupiedPort) {
        throw "Port $Port is already in use by PID $($occupiedPort.OwningProcess). Close the old development session or run Stop-DisplayPlusMusic-Current.cmd."
    }

    $lanIp = Get-LanIpv4Address
    $pluginUrl = "http://${lanIp}:$Port"
    Write-Host "[2/4] LAN address: $lanIp"

    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $viteOutputLog = Join-Path $runtimeDirectory "vite-$timestamp.log"
    $viteErrorLog = Join-Path $runtimeDirectory "vite-$timestamp.error.log"

    Write-Host "[3/4] Starting the DisplayPlus Music development server..."
    $viteArguments = @(
        ('"' + $viteScript + '"'),
        "--host", "0.0.0.0",
        "--port", [string]$Port,
        "--strictPort"
    )
    $viteProcess = Start-Process -FilePath $nodePath `
        -ArgumentList $viteArguments `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $viteOutputLog `
        -RedirectStandardError $viteErrorLog `
        -PassThru

    $runtimeState = [ordered]@{
        computerName = [Environment]::MachineName
        repoRoot = $repoRoot
        port = $Port
        vitePid = $viteProcess.Id
        viteStartedUtc = $viteProcess.StartTime.ToUniversalTime().ToString("o")
        viteLog = $viteOutputLog
        viteErrorLog = $viteErrorLog
    }
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        $runtimeStatePath,
        (($runtimeState | ConvertTo-Json -Depth 5) + [Environment]::NewLine),
        $utf8WithoutBom)
    $runtimeStarted = $true

    Wait-HttpReady -Uri $pluginUrl | Out-Null
    $viteProcess.Refresh()
    if ($viteProcess.HasExited) {
        $details = if (Test-Path -LiteralPath $viteErrorLog) {
            [System.IO.File]::ReadAllText($viteErrorLog)
        }
        else { "No error log was created." }
        throw "The development server stopped before becoming ready. $details"
    }

    Write-Host "[4/4] Ready." -ForegroundColor Green
    Write-Host ""
    Write-Host "Plugin URL: $pluginUrl"
    Write-Host "Logs      : $runtimeDirectory"
    Write-Host ""

    if (-not $SkipQr) {
        Write-Host "Open Even Realities App > Developer Center, then scan this QR code:"
        Invoke-External -FilePath $evenHubPath -Arguments @("qr", "--url", $pluginUrl)
    }

    if ($AutoStopSeconds -gt 0) {
        Write-Host "Smoke-test mode: stopping automatically in $AutoStopSeconds seconds."
        Start-Sleep -Seconds $AutoStopSeconds
    }
    else {
        Read-Host "Press Enter when testing is finished to stop the development server"
    }
}
finally {
    if ($runtimeStarted -and (Test-Path -LiteralPath $stopScriptPath -PathType Leaf)) {
        & $stopScriptPath -Quiet
    }
    elseif ($null -ne $viteProcess) {
        try {
            if (-not $viteProcess.HasExited) {
                Stop-Process -Id $viteProcess.Id -Force -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-Warning $_.Exception.Message
        }
    }

    Pop-Location
}
