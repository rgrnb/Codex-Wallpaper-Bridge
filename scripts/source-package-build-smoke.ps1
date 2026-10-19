param([ValidatePattern('^\d{1,5}\.\d{1,5}\.\d{1,5}$')][string]$Version, [string]$Compiler)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version }
$archive = Join-Path $projectRoot "dist\CodexWallpaperBridge-$Version-source.zip"
$evidence = Join-Path $projectRoot ('.local-evidence\source-package-build-' + [Guid]::NewGuid().ToString('N'))
$destination = [IO.Path]::GetFullPath((Join-Path $evidence 'Source Project With Spaces'))
if (-not $destination.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build fixture escaped workspace.' }
New-Item -ItemType Directory -Path $evidence | Out-Null
$report = [ordered]@{ success = $false; project = $destination; scope = 'Complete native x64/x86 build from retained source archive in an isolated path containing spaces. No install or user settings changes.' }
$priorCompiler = $env:BRIDGE_I686_CC
try {
  if ($Compiler) {
    if (-not [IO.Path]::IsPathRooted($Compiler) -or -not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw 'An existing absolute i686 compiler path is required.' }
    $env:BRIDGE_I686_CC = $Compiler
  }
  $report.archiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  if ((Get-Content -LiteralPath ($archive + '.sha256') -Raw).Trim() -ine $report.archiveSha256) { throw 'Source archive SHA sidecar mismatch.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      $checked = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
      if (-not $checked.StartsWith($destination + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source archive escaped build fixture.' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
  & powershell.exe -NoProfile -File (Join-Path $destination 'scripts\build.ps1') *> (Join-Path $evidence 'build.log')
  $report.buildExitCode = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0) { throw 'Complete source build failed; see retained build.log.' }
  $report.artifacts = @()
  foreach ($name in @('CodexWallpaperBridge.exe','BridgeGraphicsHook.dll','BridgeApplicationInput.dll','BridgeApplicationInputHook32.dll','BridgeWebIntegration.exe','BridgeArchive.exe','BridgeLauncher.exe','Uninstall.exe')) {
    $file = Join-Path $destination ('build\' + $name)
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Source build artifact missing: ' + $name) }
    $report.artifacts += [ordered]@{ name = $name; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
  }
  $report.success = $true
} catch { $report.error = $_.Exception.Message; throw }
finally {
  $env:BRIDGE_I686_CC = $priorCompiler
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding UTF8
  Write-Output ($report | ConvertTo-Json -Depth 5 -Compress)
  Write-Output ('Evidence: ' + $evidence)
}
