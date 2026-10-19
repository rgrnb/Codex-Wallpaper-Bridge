param([ValidatePattern('^\d{1,5}\.\d{1,5}\.\d{1,5}$')][string]$Version, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot ('.local-evidence\package-audit-' + [Guid]::NewGuid().ToString('N')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'result.json')) { throw 'Audit evidence already exists.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-StreamHash($Stream) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
}
function Test-Archive([string]$Archive, [string]$Directory, [string[]]$Expected, [switch]$Source) {
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
    if (@($names | Sort-Object -Unique).Count -ne $names.Count) { throw 'Duplicate archive entries.' }
    $differences = @(Compare-Object -ReferenceObject @($Expected | Sort-Object) -DifferenceObject @($names | Sort-Object))
    if ($differences.Count) { throw ('Archive inventory differs: ' + ($differences | Out-String)) }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\','/')
      if ($name -match '(^|/)(\.local-evidence|\.reference|\.git|node_modules)(/|$)|(^|/)(settings|auth|credentials)\.json$|\.(pem|key|pfx|p12)$' -or
          ($Source -and $name -match '\.(exe|dll|zip|mp4|webm)$')) { throw ('Private/generated archive entry: ' + $name) }
      $file = [IO.Path]::GetFullPath((Join-Path $Directory $name))
      if (-not $file.StartsWith($Directory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped source root.' }
      $stream = $entry.Open()
      try { $entryHash = Get-StreamHash $stream } finally { $stream.Dispose() }
      if ($entryHash -ne (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()) { throw ('Archive content differs: ' + $name) }
    }
    return [ordered]@{ entries = $names.Count; sha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant(); allContentMatches = $true; inventoryExact = $true }
  } finally { $zip.Dispose() }
}
$result = [ordered]@{ version = $Version; success = $false; scope = 'Read-only exact source/runtime archive inventory and SHA audit; no application launch or user profile access.' }
try {
  $sourceFiles = @('README.md','THIRD_PARTY_NOTICES.md','package.json','.gitignore')
  foreach ($directory in @('src','config','docs','native','scripts','tests','third_party','assets')) {
    $sourceFiles += @(Get-ChildItem -LiteralPath (Join-Path $projectRoot $directory) -File -Recurse | ForEach-Object { $_.FullName.Substring($projectRoot.Length + 1).Replace('\','/') } |
      Where-Object { $_ -notmatch '^scripts/experiments/fixtures/.+/shaders/blobs[^/]+/' })
  }
  $appRoot = Join-Path $projectRoot ('dist\app-' + $Version)
  $runtimeFiles = @(Get-ChildItem -LiteralPath $appRoot -File -Recurse -Force | ForEach-Object { $_.FullName.Substring($appRoot.Length + 1).Replace('\','/') })
  $result.source = Test-Archive (Join-Path $projectRoot "dist\CodexWallpaperBridge-$Version-source.zip") $projectRoot $sourceFiles -Source
  $result.runtime = Test-Archive (Join-Path $projectRoot "dist\CodexWallpaperBridge-$Version-win-x64.zip") $appRoot $runtimeFiles
  $result.sidecars = @()
  foreach ($name in @("CodexWallpaperBridge-$Version-source.zip", "CodexWallpaperBridge-$Version-win-x64.zip", "CodexWallpaperBridge-Setup-$Version.exe", "CodexWallpaperBridge-Uninstall-$Version.exe")) {
    $file = Join-Path $projectRoot ('dist\' + $name)
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ((Get-Content -LiteralPath ($file + '.sha256') -Raw).Trim().ToLowerInvariant() -ne $actual) { throw ('SHA sidecar differs: ' + $name) }
    $result.sidecars += [ordered]@{ name = $name; sha256 = $actual; matches = $true }
  }
  $result.success = $true
} catch { $result.error = $_.Exception.Message; throw }
finally {
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding UTF8
  Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
  Write-Output ('Evidence: ' + $OutputDirectory)
}
