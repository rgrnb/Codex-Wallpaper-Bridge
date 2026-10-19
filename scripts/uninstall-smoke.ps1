param([string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureId = 'BridgeUninstallFixture-' + [Guid]::NewGuid().ToString('N')
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $projectRoot '.local-evidence' }
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $EvidenceDirectory $fixtureId))
if (-not $fixtureRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture evidence must stay inside the workspace.' }
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
[IO.File]::WriteAllText((Join-Path $fixtureRoot '.bridge-test-fixture'), 'CodexWallpaperBridge/TestFixture/1')
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$priorFixture = $env:BRIDGE_SETUP_FIXTURE_ROOT
$env:BRIDGE_SETUP_FIXTURE_ROOT = $fixtureRoot
$fixtureRegistry = 'HKCU:\Software\CodexWallpaperBridge\TestFixtures\' + $fixtureId
$targetPath = Join-Path $fixtureRoot 'Programs\CodexWallpaperBridge'
$dataPath = Join-Path $fixtureRoot 'Data'
$result = [ordered]@{ fixture = $fixtureId; isolated = $true }
function Assert-Bridge([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-Bridge([string]$Executable, [string]$Arguments, [int]$ExpectedExit = 0) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
  Assert-Bridge ($process.ExitCode -eq $ExpectedExit) "Unexpected exit $($process.ExitCode) from $Arguments"
}
function Wait-Bridge([scriptblock]$Condition) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do { if (& $Condition) { return }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Timed out waiting for isolated uninstall completion.'
}
function Compile-Bridge([string]$Output, [string]$Defines, [string]$Resource) {
  $compilerArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:x64', "/out:$Output", "/define:$Defines", '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll')
  if ($Resource) { $compilerArgs += "/resource:$Resource,Bridge.Payload.zip" }
  $compilerArgs += @((Join-Path $projectRoot 'native\Setup.cs'), (Join-Path $projectRoot 'native\InstallLease.cs'), (Join-Path $projectRoot 'native\KnownPaths.cs'), (Join-Path $fixtureRoot 'BuildInfo.cs'))
  & $compilerPath @compilerArgs
  Assert-Bridge ($LASTEXITCODE -eq 0) 'Fixture compilation failed.'
}
try {
  [IO.File]::WriteAllText((Join-Path $fixtureRoot 'BuildInfo.cs'), 'namespace BridgeShared { static class BuildInfo { public const string Version = "0.2.1"; } }')
  $externalUninstaller = Join-Path $fixtureRoot 'FixtureUninstall.exe'
  Compile-Bridge $externalUninstaller 'BRIDGE_UNINSTALL,BRIDGE_SETUP_TEST'
  $payloadPath = Join-Path $fixtureRoot 'payload'
  New-Item -ItemType Directory -Path $payloadPath | Out-Null
  foreach ($entry in @('CodexWallpaperBridge.exe', 'BridgeArchive.exe', 'BridgeGraphicsHook.dll', 'node.exe', 'src\main.mjs', 'config\adapter.json', 'config\wallpaper-engine.json')) {
    $payloadFile = Join-Path $payloadPath $entry
    New-Item -ItemType Directory -Path (Split-Path $payloadFile) -Force | Out-Null
    [IO.File]::WriteAllText($payloadFile, 'isolated-product-fixture')
  }
  Copy-Item -LiteralPath (Join-Path $projectRoot 'build\BridgeLauncher.exe') -Destination (Join-Path $payloadPath 'BridgeLauncher.exe')
  Copy-Item -LiteralPath $externalUninstaller -Destination (Join-Path $payloadPath 'Uninstall.exe')
  # Match the release ZIP, which is also a directly removable portable package.
  [IO.File]::WriteAllText((Join-Path $payloadPath '.bridge-owned'), 'CodexWallpaperBridge/1')
  $portableInventory = @(Get-ChildItem -LiteralPath $payloadPath -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($payloadPath.Length + 1) })
  [IO.File]::WriteAllLines((Join-Path $payloadPath 'installed-files.txt'), $portableInventory)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = Join-Path $fixtureRoot 'payload.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($payloadPath, $zipPath)
  $setupPath = Join-Path $fixtureRoot 'FixtureSetup.exe'
  Compile-Bridge $setupPath 'BRIDGE_SETUP_TEST' $zipPath
  Invoke-Bridge $setupPath '--install-silent'
  $result.installation = (Test-Path -LiteralPath (Join-Path $targetPath 'Uninstall.exe'))
  Assert-Bridge $result.installation 'Install did not deploy the independent uninstaller.'
  $installedInventory = [IO.File]::ReadAllLines((Join-Path $targetPath 'installed-files.txt'))
  Assert-Bridge (@($installedInventory | Select-Object -Unique).Count -eq $installedInventory.Length) 'Portable payload metadata produced duplicate install inventory.'
  $result.portableMetadataInstallerCompatibility = $true
  $registration = Get-ItemProperty -LiteralPath ($fixtureRegistry + '\Uninstall')
  Assert-Bridge ($registration.UninstallString -eq ('"' + (Join-Path $targetPath 'Uninstall.exe') + '" --uninstall')) 'UninstallString mismatch.'
  Assert-Bridge ($registration.QuietUninstallString -eq ('"' + (Join-Path $targetPath 'Uninstall.exe') + '" --silent')) 'QuietUninstallString mismatch.'
  $shell = New-Object -ComObject WScript.Shell
  $uninstallShortcutPath = Join-Path $fixtureRoot 'StartMenu\卸载 Codex Wallpaper Bridge.lnk'
  $shortcut = $shell.CreateShortcut($uninstallShortcutPath)
  Assert-Bridge ($shortcut.TargetPath -eq (Join-Path $targetPath 'Uninstall.exe') -and $shortcut.Arguments -eq '--uninstall') 'Start menu uninstall shortcut mismatch.'
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  $result.registrationAndMenu = $true
  $unknown = Join-Path $targetPath 'user-added\notes.txt'
  New-Item -ItemType Directory -Path (Split-Path $unknown) -Force | Out-Null
  [IO.File]::WriteAllText($unknown, 'user-added-preservation-sentinel')
  foreach ($entry in @('settings.json', 'profile\login-data', 'logs\history.log', 'updates\0.2.1.zip', 'wallpapers\original.mp4')) {
    $dataFile = Join-Path $dataPath $entry
    New-Item -ItemType Directory -Path (Split-Path $dataFile) -Force | Out-Null
    [IO.File]::WriteAllText($dataFile, 'persistent-user-data-sentinel')
  }
  $settingsFiles = Get-ChildItem -LiteralPath $dataPath -Recurse -File | ForEach-Object { $_.FullName }
  $manifestPath = Join-Path $targetPath 'installed-files.txt'
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  $allInstalled = Get-ChildItem -LiteralPath $targetPath -Recurse -File | ForEach-Object { $_.FullName }
  $lock = [IO.File]::Open((Join-Path $targetPath 'node.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  try { Invoke-Bridge $externalUninstaller '--silent' 1 } finally { $lock.Dispose() }
  foreach ($file in $allInstalled) { Assert-Bridge (Test-Path -LiteralPath $file) ('Locked uninstall deleted: ' + $file) }
  Assert-Bridge (Test-Path -LiteralPath ($fixtureRegistry + '\Uninstall')) 'Locked uninstall removed registration.'
  $result.lockedFailureRetainsFilesAndRegistration = $true
  $outsideSentinel = Join-Path $fixtureRoot 'outside-keep.txt'
  [IO.File]::WriteAllText($outsideSentinel, 'outside-path-sentinel')
  [IO.File]::AppendAllText($manifestPath, "`r`n..\..\outside-keep.txt`r`n")
  Invoke-Bridge $externalUninstaller '--silent' 1
  foreach ($file in $allInstalled) { Assert-Bridge (Test-Path -LiteralPath $file) ('Invalid manifest deleted: ' + $file) }
  Assert-Bridge ([IO.File]::ReadAllText($outsideSentinel) -eq 'outside-path-sentinel') 'Escaped manifest touched outside file.'
  [IO.File]::WriteAllBytes($manifestPath, $manifestBytes)
  $result.pathTraversalRejectedBeforeDeletion = $true
  $markerPath = Join-Path $targetPath '.bridge-owned'
  [IO.File]::WriteAllText($markerPath, 'unrelated-product')
  Invoke-Bridge $externalUninstaller '--silent' 1
  foreach ($file in $allInstalled) { Assert-Bridge (Test-Path -LiteralPath $file) ('Mismatched identity deleted: ' + $file) }
  [IO.File]::WriteAllText($markerPath, 'CodexWallpaperBridge/1')
  $result.foreignIdentityRejected = $true
  [IO.File]::AppendAllText($manifestPath, "Uninstall.exe`r`n")
  Invoke-Bridge $externalUninstaller '--silent' 1
  [IO.File]::WriteAllBytes($manifestPath, $manifestBytes)
  $result.duplicateInventoryRejected = $true
  $redirectPath = Join-Path $fixtureRoot 'RedirectTarget'
  New-Item -ItemType Directory -Path $redirectPath | Out-Null
  [IO.File]::WriteAllText((Join-Path $redirectPath 'main.mjs'), 'redirected-outside-sentinel')
  $ownedSource = Join-Path $targetPath 'src'
  $savedSource = Join-Path $fixtureRoot 'SavedSource'
  Move-Item -LiteralPath $ownedSource -Destination $savedSource
  try {
    New-Item -ItemType Junction -Path $ownedSource -Target $redirectPath | Out-Null
    Invoke-Bridge $externalUninstaller '--silent' 1
    Assert-Bridge ([IO.File]::ReadAllText((Join-Path $redirectPath 'main.mjs')) -eq 'redirected-outside-sentinel') 'Directory junction target changed.'
  } finally {
    if (Test-Path -LiteralPath $ownedSource) { [IO.Directory]::Delete($ownedSource) }
    Move-Item -LiteralPath $savedSource -Destination $ownedSource
  }
  $result.directoryRedirectionRejected = $true
  $readOnlyFile = Join-Path $targetPath 'node.exe'
  [IO.File]::SetAttributes($readOnlyFile, [IO.FileAttributes]::ReadOnly)
  try { Invoke-Bridge $externalUninstaller '--silent' 1 } finally { [IO.File]::SetAttributes($readOnlyFile, [IO.FileAttributes]::Normal) }
  foreach ($file in $allInstalled) { Assert-Bridge (Test-Path -LiteralPath $file) ('Read-only uninstall deleted: ' + $file) }
  $result.readOnlyRejectedBeforeDeletion = $true
  $damagedPortable = Join-Path $fixtureRoot 'DamagedPortable'
  New-Item -ItemType Directory -Path $damagedPortable | Out-Null
  Copy-Item -LiteralPath $externalUninstaller -Destination (Join-Path $damagedPortable 'Uninstall.exe')
  [IO.File]::WriteAllText((Join-Path $damagedPortable 'CodexWallpaperBridge.exe'), 'damaged-portable-fixture')
  $damagedTemps = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'CodexWallpaperBridge-Uninstall-*' | ForEach-Object Name)
  Invoke-Bridge (Join-Path $damagedPortable 'Uninstall.exe') '--silent'
  Start-Sleep -Milliseconds 500
  Wait-Bridge { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'CodexWallpaperBridge-Uninstall-*' | Where-Object { $_.Name -notin $damagedTemps }).Count -eq 0 }
  foreach ($file in $allInstalled) { Assert-Bridge (Test-Path -LiteralPath $file) ('Damaged portable fallback deleted installed file: ' + $file) }
  Assert-Bridge (Test-Path -LiteralPath (Join-Path $damagedPortable 'CodexWallpaperBridge.exe')) 'Damaged portable package was modified.'
  $result.damagedPortableDoesNotFallBackToInstalled = $true
  $backupPath = Join-Path $fixtureRoot ('Programs\CodexWallpaperBridge.previous-' + [Guid]::NewGuid().ToString('N'))
  Copy-Item -LiteralPath $targetPath -Destination $backupPath -Recurse
  $tempsBefore = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'CodexWallpaperBridge-Uninstall-*' | ForEach-Object Name)
  Invoke-Bridge (Join-Path $targetPath 'Uninstall.exe') '--silent'
  Wait-Bridge { -not (Test-Path -LiteralPath (Join-Path $targetPath '.bridge-owned')) }
  Assert-Bridge (-not (Test-Path -LiteralPath (Join-Path $targetPath 'CodexWallpaperBridge.exe'))) 'Product EXE remained.'
  Assert-Bridge (-not (Test-Path -LiteralPath (Join-Path $targetPath 'Uninstall.exe'))) 'Running uninstaller did not remove its installed copy.'
  Assert-Bridge (-not (Test-Path -LiteralPath ($fixtureRegistry + '\Uninstall'))) 'Uninstall registration remained.'
  Assert-Bridge (-not (Test-Path -LiteralPath $uninstallShortcutPath)) 'Uninstall menu shortcut remained.'
  Assert-Bridge (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'Programs\CodexWallpaperBridge.Launcher.exe'))) 'Stable launcher remained.'
  Assert-Bridge ([IO.File]::ReadAllText($unknown) -eq 'user-added-preservation-sentinel') 'Unknown active file changed.'
  Assert-Bridge ([IO.File]::ReadAllText((Join-Path $backupPath 'user-added\notes.txt')) -eq 'user-added-preservation-sentinel') 'Unknown backup file changed.'
  Assert-Bridge (-not (Test-Path -LiteralPath (Join-Path $backupPath 'node.exe'))) 'Owned backup file remained.'
  foreach ($file in $settingsFiles) { Assert-Bridge ([IO.File]::ReadAllText($file) -eq 'persistent-user-data-sentinel') ('Persistent data changed: ' + $file) }
  Wait-Bridge { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'CodexWallpaperBridge-Uninstall-*' | Where-Object { $_.Name -notin $tempsBefore }).Count -eq 0 }
  $result.installedSelfRemoval = $true
  $result.temporaryWorkerSelfCleanup = $true
  $result.unknownAndPersistentDataPreserved = $true
  Invoke-Bridge $externalUninstaller '--silent'
  $result.repeatRemoval = $true
  $portablePath = Join-Path $fixtureRoot 'PortableBridge'
  New-Item -ItemType Directory -Path (Join-Path $portablePath 'assets\nested') -Force | Out-Null
  Copy-Item -LiteralPath $externalUninstaller -Destination (Join-Path $portablePath 'Uninstall.exe')
  [IO.File]::WriteAllText((Join-Path $portablePath 'CodexWallpaperBridge.exe'), 'portable-product-fixture')
  [IO.File]::WriteAllText((Join-Path $portablePath 'assets\nested\owned.dat'), 'portable-owned-fixture')
  [IO.File]::WriteAllText((Join-Path $portablePath 'keep.txt'), 'portable-unknown-sentinel')
  [IO.File]::WriteAllText((Join-Path $portablePath '.bridge-owned'), 'CodexWallpaperBridge/1')
  [IO.File]::WriteAllLines((Join-Path $portablePath 'installed-files.txt'), @('CodexWallpaperBridge.exe', 'Uninstall.exe', 'assets\nested\owned.dat', '.bridge-owned'))
  Invoke-Bridge (Join-Path $portablePath 'Uninstall.exe') '--silent'
  Wait-Bridge { -not (Test-Path -LiteralPath (Join-Path $portablePath '.bridge-owned')) }
  Assert-Bridge ([IO.File]::ReadAllText((Join-Path $portablePath 'keep.txt')) -eq 'portable-unknown-sentinel') 'Portable unknown file changed.'
  Assert-Bridge (-not (Test-Path -LiteralPath (Join-Path $portablePath 'assets'))) 'Empty owned parent directories remained.'
  Assert-Bridge (-not (Test-Path -LiteralPath (Join-Path $portablePath 'Uninstall.exe'))) 'Portable uninstaller remained.'
  Wait-Bridge { @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'CodexWallpaperBridge-Uninstall-*' | Where-Object { $_.Name -notin $tempsBefore }).Count -eq 0 }
  $result.portableSelfRemovalAndEmptyParentCleanup = $true
  $result.passed = $true
} catch {
  $result.passed = $false
  $result.error = $_.Exception.Message
  throw
} finally {
  $env:BRIDGE_SETUP_FIXTURE_ROOT = $priorFixture
  if (Test-Path -LiteralPath $fixtureRegistry) { Remove-Item -LiteralPath $fixtureRegistry -Recurse }
  $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'result.json') -Encoding UTF8
  Write-Output ($result | ConvertTo-Json -Compress)
  Write-Output ('Evidence: ' + $fixtureRoot)
}
