param([switch]$Package, [switch]$NativeOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
if ($releaseVersion -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { throw 'A three-part release version is required.' }
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw '.NET Framework 4.8 C# compiler is required.' }
$buildPath = Join-Path $projectRoot 'build'
New-Item -ItemType Directory -Path $buildPath -Force | Out-Null
$frameworkPath = Split-Path $compilerPath
$winMetadataPath = Join-Path $env:WINDIR 'System32\WinMetadata'
$knownPathsSource = Join-Path $projectRoot 'native\KnownPaths.cs'
$references = @('System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Management.dll',
  "$frameworkPath\System.Runtime.WindowsRuntime.dll", "$frameworkPath\System.Runtime.InteropServices.WindowsRuntime.dll", "$frameworkPath\System.Runtime.dll",
  "$winMetadataPath\Windows.Foundation.winmd", "$winMetadataPath\Windows.Graphics.winmd") | ForEach-Object { "/reference:$_" }
& $compilerPath /nologo /target:winexe /optimize+ /platform:x64 "/out:$buildPath\CodexWallpaperBridge.exe" "/win32manifest:$projectRoot\native\app.manifest" $references (Join-Path $projectRoot 'native\BridgeHost.cs') (Join-Path $projectRoot 'native\WgcCapture.cs') (Join-Path $projectRoot 'native\WeConsole.cs') (Join-Path $projectRoot 'native\GraphicsCaptureBridge.cs') (Join-Path $projectRoot 'native\ProcessMetrics.cs') $knownPathsSource
if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
Write-Output "Built $buildPath\CodexWallpaperBridge.exe"
& $compilerPath /nologo /target:exe /optimize+ /platform:x64 "/out:$buildPath\BridgeArchive.exe" /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $projectRoot 'native\ArchiveHost.cs') (Join-Path $projectRoot 'native\InstallLease.cs')
if ($LASTEXITCODE -ne 0) { throw 'Archive helper build failed.' }
& $compilerPath /nologo /target:winexe /optimize+ /platform:x64 "/out:$buildPath\BridgeLauncher.exe" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $projectRoot 'native\Launcher.cs') $knownPathsSource
if ($LASTEXITCODE -ne 0) { throw 'Recovery launcher build failed.' }
if ($NativeOnly) { if ($Package) { throw 'NativeOnly cannot package an incomplete build.' }; exit 0 }
$gccPath = (Get-Command gcc.exe -ErrorAction Stop).Source
$minhookRoot = Join-Path $projectRoot 'third_party\minhook'
$hookSources = @('src\buffer.c', 'src\hook.c', 'src\trampoline.c', 'src\hde\hde64.c') | ForEach-Object { Join-Path $minhookRoot $_ }
& $gccPath -shared -std=gnu11 -O2 -static-libgcc "-I$minhookRoot\include" "-I$minhookRoot\src" -o (Join-Path $buildPath 'BridgeGraphicsHook.dll') (Join-Path $projectRoot 'native\GraphicsHook.c') $hookSources -ld3d11 -ldxgi -ldxguid -luser32 -lkernel32
if ($LASTEXITCODE -ne 0) { throw 'Graphics capture module build failed.' }
if ($Package) {
  $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
  if ((& $nodeExecutable --version) -ne 'v24.19.0') { throw 'Packaging requires Node v24.19.0 to match the reviewed bundled runtime/license.' }
  $packagePath = Join-Path $buildPath ('package-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $packagePath -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $projectRoot 'dist') -Force | Out-Null
  foreach ($directory in @('src', 'config', 'docs', 'third_party')) { Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $packagePath -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $buildPath 'CodexWallpaperBridge.exe') -Destination $packagePath -Force
  Copy-Item -LiteralPath (Join-Path $buildPath 'BridgeArchive.exe') -Destination $packagePath -Force
  Copy-Item -LiteralPath (Join-Path $buildPath 'BridgeLauncher.exe') -Destination $packagePath -Force
  Copy-Item -LiteralPath (Join-Path $buildPath 'BridgeGraphicsHook.dll') -Destination $packagePath -Force
  Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $packagePath 'node.exe') -Force
  foreach ($file in @('README.md', 'THIRD_PARTY_NOTICES.md', 'package.json')) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $packagePath -Force }
  Copy-Item -LiteralPath (Join-Path $projectRoot 'third_party\Node-LICENSE.txt') -Destination $packagePath -Force
  $archive = Join-Path $projectRoot "dist\CodexWallpaperBridge-$releaseVersion-win-x64.zip"
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  [IO.Compression.ZipFile]::CreateFromDirectory($packagePath, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
  (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash | Set-Content -LiteralPath "$archive.sha256" -Encoding Ascii
  Write-Output "Packaged $archive"
  $setupPath = Join-Path $projectRoot "dist\CodexWallpaperBridge-Setup-$releaseVersion.exe"
  $buildInfoPath = Join-Path $buildPath 'ReleaseVersion.cs'
  "namespace BridgeShared { static class BuildInfo { public const string Version = `"$releaseVersion`"; } }" | Set-Content -LiteralPath $buildInfoPath -Encoding UTF8
  & $compilerPath /nologo /target:winexe /optimize+ /platform:x64 "/out:$setupPath" "/win32manifest:$projectRoot\native\app.manifest" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$archive,Bridge.Payload.zip" (Join-Path $projectRoot 'native\Setup.cs') (Join-Path $projectRoot 'native\InstallLease.cs') $knownPathsSource $buildInfoPath
  if ($LASTEXITCODE -ne 0) { throw 'Setup build failed.' }
  $verifyProcess = Start-Process -FilePath $setupPath -ArgumentList '--verify-payload' -WindowStyle Hidden -Wait -PassThru
  if ($verifyProcess.ExitCode -ne 0) { throw 'Setup payload verification failed.' }
  (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash | Set-Content -LiteralPath "$setupPath.sha256" -Encoding Ascii
  Write-Output "Built and payload-verified $setupPath"
  $appDestination = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\app'))
  $priorPackage = [IO.Path]::GetFullPath((Join-Path $buildPath ('package-previous-' + [Guid]::NewGuid().ToString('N'))))
  foreach ($checkedPath in @($packagePath, $appDestination, $priorPackage)) {
    if (-not ([IO.Path]::GetFullPath($checkedPath)).StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package move escaped workspace.' }
  }
  if (Test-Path -LiteralPath $appDestination) { Move-Item -LiteralPath $appDestination -Destination $priorPackage }
  Move-Item -LiteralPath $packagePath -Destination $appDestination
  # Source archive has only the explicitly selected source tree, never private
  # profiles, wallpaper assets, signing fixtures, caches or local diagnostics.
  $sourceArchive = Join-Path $projectRoot "dist\CodexWallpaperBridge-$releaseVersion-source.zip"
  if (Test-Path -LiteralPath $sourceArchive) { Remove-Item -LiteralPath $sourceArchive -Force }
  $sourceZip = [IO.Compression.ZipFile]::Open($sourceArchive, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($sourceDirectory in @('src','config','docs','native','scripts','tests','third_party')) {
      foreach ($sourceFile in (Get-ChildItem -LiteralPath (Join-Path $projectRoot $sourceDirectory) -File -Recurse)) {
        $entryName = $sourceFile.FullName.Substring($projectRoot.Length + 1).Replace('\','/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($sourceZip, $sourceFile.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
      }
    }
    foreach ($sourceFile in @('README.md','THIRD_PARTY_NOTICES.md','package.json','.gitignore')) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($sourceZip, (Join-Path $projectRoot $sourceFile), $sourceFile, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $sourceZip.Dispose() }
  (Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash | Set-Content -LiteralPath "$sourceArchive.sha256" -Encoding Ascii
  Write-Output "Packaged retained source $sourceArchive"
}
