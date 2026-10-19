param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\build'))
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $destination.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Web integration output must stay within the workspace.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$framework = Split-Path $compiler
$metadata = Join-Path $env:WINDIR 'System32\WinMetadata'
$references = @('System.Web.Extensions.dll', 'System.Drawing.dll',
  "$framework\System.Runtime.WindowsRuntime.dll", "$framework\System.Runtime.dll",
  "$metadata\Windows.Foundation.winmd", "$metadata\Windows.Media.winmd", "$metadata\Windows.Storage.winmd") | ForEach-Object { "/reference:$_" }
& $compiler /nologo /target:exe /optimize+ /platform:x64 "/out:$destination\BridgeWebIntegration.exe" $references (Join-Path $projectRoot 'native\WebIntegrationHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Web integration build failed.' }
Write-Output "Built $destination\BridgeWebIntegration.exe"
