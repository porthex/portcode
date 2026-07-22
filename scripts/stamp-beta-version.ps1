param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+-beta\.\d+$')]
  [string]$Version,

  [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function ProjectPath([string]$RelativePath) {
  Join-Path $resolvedRoot $RelativePath
}

$packagePath = ProjectPath "package.json"
$tauriPath = ProjectPath "src-tauri/tauri.conf.json"
$cargoPath = ProjectPath "src-tauri/Cargo.toml"
$lockPath = ProjectPath "Cargo.lock"

function StampVersion([string]$Path, [string]$Pattern, [string]$Label) {
  $content = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  $matcher = New-Object System.Text.RegularExpressions.Regex(
    $Pattern,
    [System.Text.RegularExpressions.RegexOptions]::Multiline
  )
  if (-not $matcher.IsMatch($content)) { throw "Could not find $Label version in $Path" }
  $updated = $matcher.Replace(
    $content,
    { param($match) $match.Groups[1].Value + $Version + $match.Groups[2].Value },
    1
  )
  [System.IO.File]::WriteAllText($Path, $updated, $utf8NoBom)
}

StampVersion $packagePath '^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$' "package.json"
StampVersion $tauriPath '^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$' "tauri.conf.json"
StampVersion $cargoPath '(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")' "Cargo package"
StampVersion $lockPath '(^\[\[package\]\]\r?\nname = "portcode"\r?\nversion\s*=\s*")[^"]+(")' "Cargo.lock package"

$packageVersion = ([System.IO.File]::ReadAllText($packagePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
$tauriVersion = ([System.IO.File]::ReadAllText($tauriPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
$cargoVersion = (Select-String -LiteralPath $cargoPath -Pattern '^version\s*=\s*"([^"]+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
$lockVersion = $null
$lockLines = [System.IO.File]::ReadAllLines($lockPath, [System.Text.Encoding]::UTF8)
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
