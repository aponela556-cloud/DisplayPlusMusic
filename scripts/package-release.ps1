[CmdletBinding()]
param(
    [string]$PackageRoot = 'C:\Users\Shawn\OneDrive - 胖蔬商行\Coding\EVENG2Packages\DisplayLyricMusic'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$appJson = Get-Content -Raw (Join-Path $projectRoot 'app.json') | ConvertFrom-Json
$version = $packageJson.version

if ($version -ne $appJson.version) {
    throw "package.json version ($version) must match app.json version ($($appJson.version))."
}

if ($version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "Version '$version' is not a valid release version."
}

$commit = (& git -C $projectRoot rev-parse --short=7 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{7,}$') {
    throw 'Unable to determine the current Git commit short hash.'
}

Push-Location $projectRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

    & npx.cmd --no-install evenhub pack app.json dist --sdk-ver 0.0.14
    if ($LASTEXITCODE -ne 0) { throw 'Even Hub packaging failed.' }
}
finally {
    Pop-Location
}

$sourcePackage = Join-Path $projectRoot 'out.ehpk'
if (-not (Test-Path -LiteralPath $sourcePackage -PathType Leaf)) {
    throw "Expected package was not created: $sourcePackage"
}

$destinationDirectory = Join-Path $PackageRoot $version
$destinationName = "DisplayLyricMusic-$version-$commit.ehpk"
$destinationPackage = Join-Path $destinationDirectory $destinationName

if (Test-Path -LiteralPath $destinationPackage) {
    throw "Refusing to overwrite existing release package: $destinationPackage"
}

New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
Copy-Item -LiteralPath $sourcePackage -Destination $destinationPackage

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $sha256Bytes = $sha256.ComputeHash([System.IO.File]::ReadAllBytes($destinationPackage))
    $sha256Hex = -join ($sha256Bytes | ForEach-Object { $_.ToString('x2') })
}
finally {
    $sha256.Dispose()
}

[pscustomobject]@{
    Version = $version
    Commit = $commit
    Package = $destinationPackage
    SHA256 = $sha256Hex
} | Format-List
