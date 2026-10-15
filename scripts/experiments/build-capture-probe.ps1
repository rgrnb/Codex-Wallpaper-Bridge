$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$frameworkPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$metadataPath = Join-Path $env:WINDIR 'System32\WinMetadata'
$outputPath = Join-Path $projectRoot '.local-evidence\CaptureProbe.exe'
New-Item -ItemType Directory -Path (Split-Path $outputPath) -Force | Out-Null
$references = @('System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll',
  "$frameworkPath\System.Runtime.WindowsRuntime.dll", "$frameworkPath\System.Runtime.InteropServices.WindowsRuntime.dll", "$frameworkPath\System.Runtime.dll",
  "$metadataPath\Windows.Foundation.winmd", "$metadataPath\Windows.Graphics.winmd") | ForEach-Object { "/reference:$_" }
& (Join-Path $frameworkPath 'csc.exe') /nologo /target:exe /optimize+ /platform:x64 "/out:$outputPath" "/win32manifest:$projectRoot\native\app.manifest" $references (Join-Path $PSScriptRoot 'CaptureProbe.cs') (Join-Path $projectRoot 'native\WgcCapture.cs')
if ($LASTEXITCODE -ne 0) { throw 'Probe build failed.' }
Write-Output $outputPath
