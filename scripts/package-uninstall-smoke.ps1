param([ValidatePattern('^\d{1,5}\.\d{1,5}\.\d{1,5}$')][string]$Version)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version }
$archivePath = Join-Path $projectRoot "dist\CodexWallpaperBridge-$Version-win-x64.zip"
$uninstallerPath = Join-Path $projectRoot "dist\CodexWallpaperBridge-Uninstall-$Version.exe"
$archiveHelper = Join-Path $projectRoot 'build\BridgeArchive.exe'
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ('.local-evidence\PackageUninstallFixture-' + [Guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped workspace.' }
$portableRoot = [IO.Path]::GetFullPath((Join-Path $fixtureRoot 'Portable Bridge'))
if (-not $portableRoot.StartsWith($fixtureRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Portable target escaped fixture.' }
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
[IO.File]::WriteAllText((Join-Path $fixtureRoot '.bridge-package-fixture'), 'CodexWallpaperBridge/PackageFixture/1')
$result = [ordered]@{
  version = $Version
  fixture = $fixtureRoot
  scope = 'Production archive helper and production uninstaller, selected isolated portable directory only. No default installed removal, registry edits, real profile changes, Codex/Wallpaper Engine shutdown, or running-user-Bridge signals.'
}
function Assert-Package([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-Package([string]$Executable, [string]$Arguments, [int]$ExpectedExit = 0) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
  Assert-Package ($process.ExitCode -eq $ExpectedExit) "Unexpected process exit $($process.ExitCode), expected $ExpectedExit."
}
function Wait-Package([scriptblock]$Condition) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do { if (& $Condition) { return }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Timed out waiting for package uninstall.'
}
try {
  $result.archiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  $result.uninstallerSha256 = (Get-FileHash -LiteralPath $uninstallerPath -Algorithm SHA256).Hash
  Invoke-Package $archiveHelper ('"' + $archivePath + '" "' + $portableRoot + '" ' + $result.archiveSha256)
  Assert-Package ([IO.File]::ReadAllText((Join-Path $portableRoot '.bridge-owned')) -eq 'CodexWallpaperBridge/1') 'Extracted ownership mismatch.'
  $inventory = [IO.File]::ReadAllLines((Join-Path $portableRoot 'installed-files.txt'))
  Assert-Package (@($inventory | Sort-Object -Unique).Count -eq $inventory.Length) 'Archive helper produced duplicate uninstall entries.'
  Assert-Package ($inventory -contains 'Uninstall.exe' -and $inventory -contains 'CodexWallpaperBridge.exe') 'Uninstall inventory is incomplete.'
  $requiredRuntimeFiles = @('BridgeWebIntegration.exe', 'BridgeGraphicsHook.dll', 'BridgeApplicationInput.dll', 'BridgeApplicationInputHook32.dll',
    'src\isolated-player.mjs', 'src\private-scene.mjs', 'src\source-watch.mjs', 'src\frame-fetch.mjs',
    'src\independent-application.mjs', 'src\independent-application-worker.ps1', 'src\silent-unity-application.mjs',
    'src\web-integration.mjs', 'src\web-files.mjs', 'src\web-runtime.mjs', 'src\pointer-events.mjs')
  foreach ($relative in $requiredRuntimeFiles) {
    Assert-Package ($inventory -contains $relative) ('New runtime file is missing from uninstall inventory: ' + $relative)
    $expected = if ($relative.StartsWith('src\')) { Join-Path $projectRoot $relative } else { Join-Path $projectRoot ('build\' + $relative) }
    Assert-Package ((Get-FileHash -LiteralPath (Join-Path $portableRoot $relative) -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash) ('Packaged runtime differs from the validated build: ' + $relative)
  }
  $result.newRuntimeFilesAndInventoryVerified = $requiredRuntimeFiles.Count
  $result.updateArchiveExtractionAndUniqueInventory = $true
  $selectedUninstaller = Join-Path $portableRoot 'Uninstall.exe'
  Assert-Package ((Get-FileHash -LiteralPath $selectedUninstaller -Algorithm SHA256).Hash -eq $result.uninstallerSha256) 'Archive does not carry the current standalone uninstaller.'
  $result.currentUninstallerIncluded = $true
  $unknownFile = Join-Path $portableRoot 'User Files\keep.txt'
  New-Item -ItemType Directory -Path (Split-Path $unknownFile) -Force | Out-Null
  [IO.File]::WriteAllText($unknownFile, 'user-package-preservation-sentinel')
  $outsideFile = Join-Path $fixtureRoot 'persistent-preferences.json'
  [IO.File]::WriteAllText($outsideFile, 'outside-portable-data-sentinel')
  $installedFiles = @(Get-ChildItem -LiteralPath $portableRoot -Recurse -Force -File | ForEach-Object FullName)
  # Newly extracted executable files can briefly be inspected by Windows/background scanners.
  $lock = $null
  for ($attempt = 0; $attempt -lt 100 -and -not $lock; $attempt++) {
    try { $lock = [IO.File]::Open((Join-Path $portableRoot 'node.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
    catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
  }
  Assert-Package ($null -ne $lock) 'Could not acquire the controlled exclusive product-file fixture lock.'
  try { Invoke-Package $uninstallerPath ('--silent --portable-root "' + $portableRoot + '"') 1 } finally { $lock.Dispose() }
  foreach ($file in $installedFiles) { Assert-Package (Test-Path -LiteralPath $file) ('Locked product file was deleted: ' + $file) }
  $result.productionLockedFailurePreservesAllFiles = $true
  $tempsBefore = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'CodexWallpaperBridge-Uninstall-*' | ForEach-Object Name)
  # Run inside the extracted product to exercise asynchronous relocation and deletion of the running entrance.
  Invoke-Package $selectedUninstaller '--silent'
  Wait-Package { -not (Test-Path -LiteralPath (Join-Path $portableRoot '.bridge-owned')) }
  foreach ($name in $inventory) { Assert-Package (-not (Test-Path -LiteralPath (Join-Path $portableRoot $name))) ('Owned package file remained: ' + $name) }
  Assert-Package (-not (Test-Path -LiteralPath (Join-Path $portableRoot 'installed-files.txt'))) 'Inventory remained.'
  Assert-Package ([IO.File]::ReadAllText($unknownFile) -eq 'user-package-preservation-sentinel') 'Unknown portable file changed.'
  Assert-Package ([IO.File]::ReadAllText($outsideFile) -eq 'outside-portable-data-sentinel') 'Outside fixture data changed.'
  Wait-Package { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'CodexWallpaperBridge-Uninstall-*' | Where-Object { $_.Name -notin $tempsBefore }).Count -eq 0 }
  $result.productionSelfRemovalAndTemporaryCleanup = $true
  $result.productionUnknownAndOutsideDataPreserved = $true
  Invoke-Package $uninstallerPath ('--silent --portable-root "' + $portableRoot + '"')
  $result.productionRepeatRemoval = $true
  $result.passed = $true
} catch {
  $result.passed = $false
  $result.error = $_.Exception.Message
  throw
} finally {
  $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'result.json') -Encoding UTF8
  Write-Output ($result | ConvertTo-Json -Compress)
  Write-Output ('Evidence: ' + $fixtureRoot)
}
