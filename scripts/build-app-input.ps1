param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\build'),
  [string]$Compiler = $env:BRIDGE_I686_CC
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ([string]::IsNullOrWhiteSpace($Compiler)) {
  $available = Get-Command i686-w64-mingw32-gcc.exe,i686-w64-mingw32-clang.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($available) { $Compiler = $available.Source }
}
if ([string]::IsNullOrWhiteSpace($Compiler) -or -not (Test-Path -LiteralPath $Compiler -PathType Leaf)) {
  throw 'Reviewed Sheep input requires an i686 MinGW-w64 C compiler. Pass -Compiler <absolute i686-w64-mingw32-gcc.exe or i686-w64-mingw32-clang.exe>, or set BRIDGE_I686_CC. No compiler is downloaded or installed by this script.'
}
$target = (& $Compiler -dumpmachine | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $target -notmatch '^i[3-6]86-.*(?:mingw32|windows-gnu)$') { throw "Expected an i686 Windows compiler; selected target is '$target'." }
$managedCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $managedCompiler)) { throw '.NET Framework C# compiler is required for the reviewed application input assembly.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
& $managedCompiler /nologo /target:library /optimize+ /platform:anycpu ('/out:'+(Join-Path $output 'BridgeApplicationInput.dll')) /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $projectRoot 'native\ApplicationInputHost.cs') (Join-Path $projectRoot 'native\GraphicsCaptureBridge.cs')
if ($LASTEXITCODE -ne 0) { throw 'Reviewed application input assembly build failed.' }
$minhook = Join-Path $projectRoot 'third_party\minhook'
$sources = @('src\buffer.c','src\hook.c','src\trampoline.c','src\hde\hde32.c') | ForEach-Object { Join-Path $minhook $_ }
& $Compiler -shared -std=gnu11 -O2 -static-libgcc ('-I'+(Join-Path $minhook 'include')) ('-I'+(Join-Path $minhook 'src')) '-Wl,--kill-at' -o (Join-Path $output 'BridgeApplicationInputHook32.dll') (Join-Path $projectRoot 'native\GraphicsHook.c') $sources -ld3d11 -ldxgi -ldxguid -luser32 -lkernel32
if ($LASTEXITCODE -ne 0) { throw 'Reviewed application i686 input module build failed. Check that the compiler includes matching i686 Windows runtime and import libraries.' }
Write-Output "Built reviewed Sheep input: $output\BridgeApplicationInput.dll and BridgeApplicationInputHook32.dll"
