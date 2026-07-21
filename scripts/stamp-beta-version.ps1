param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+-beta\.\d+$')]
  [string]$Version,

  [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path

function ProjectPath([string]$RelativePath) {
  Join-Path $resolvedRoot $RelativePath
}

$packagePath = ProjectPath "package.json"
$tauriPath = ProjectPath "src-tauri/tauri.conf.json"
$cargoPath = ProjectPath "src-tauri/Cargo.toml"
$lockPath = ProjectPath "Cargo.lock"

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$package.version = $Version
$package | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 -LiteralPath $packagePath

$tauri = Get-Content -LiteralPath $tauriPath -Raw | ConvertFrom-Json
$tauri.version = $Version
$tauri | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 -LiteralPath $tauriPath

$cargoLines = Get-Content -LiteralPath $cargoPath
$cargoStamped = $false
$inPackage = $false
for ($i = 0; $i -lt $cargoLines.Count; $i++) {
  if ($cargoLines[$i] -eq "[package]") {
    $inPackage = $true
    continue
  }
  if ($inPackage -and $cargoLines[$i] -match '^version\s*=') {
    $cargoLines[$i] = "version = `"$Version`""
    $cargoStamped = $true
    break
  }
}
if (-not $cargoStamped) { throw "Could not find [package].version in $cargoPath" }
$cargoLines | Set-Content -Encoding utf8 -LiteralPath $cargoPath

$lockLines = Get-Content -LiteralPath $lockPath
$lockStamped = $false
for ($i = 0; $i -lt $lockLines.Count - 1; $i++) {
  if ($lockLines[$i] -eq 'name = "portcode"' -and $lockLines[$i + 1] -match '^version\s*=') {
    $lockLines[$i + 1] = "version = `"$Version`""
    $lockStamped = $true
    break
  }
}
if (-not $lockStamped) { throw "Could not find the portcode package in $lockPath" }
$lockLines | Set-Content -Encoding utf8 -LiteralPath $lockPath

$packageVersion = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
$tauriVersion = (Get-Content -LiteralPath $tauriPath -Raw | ConvertFrom-Json).version
$cargoVersion = (Select-String -LiteralPath $cargoPath -Pattern '^version\s*=\s*"([^"]+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
$lockVersion = $null
$lockLines = Get-Content -LiteralPath $lockPath
for ($i = 0; $i -lt $lockLines.Count - 1; $i++) {
  if ($lockLines[$i] -eq 'name = "portcode"' -and $lockLines[$i + 1] -match '^version\s*=\s*"([^"]+)"') {
    $lockVersion = $Matches[1]
    break
  }
}

$observed = @($packageVersion, $tauriVersion, $cargoVersion, $lockVersion)
if ($observed.Where({ $_ -ne $Version }).Count -ne 0) {
  throw "Version stamping disagreed: $($observed -join ', ')"
}

Write-Output "Stamped Portcode beta version $Version in package.json, tauri.conf.json, Cargo.toml, and Cargo.lock"
