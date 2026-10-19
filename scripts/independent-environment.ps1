param([switch]$AllowTemporaryEnvironment, [switch]$BridgeNotRunning, [string]$BridgeExecutable, [ValidatePattern('^scripts/[a-z0-9-]+\.mjs$')][string]$TestScript = 'scripts/independent-acceptance.mjs', [ValidateSet('--blt','--float')][string[]]$TestArguments = @())
$ErrorActionPreference = 'Stop'
function Get-AcceptanceFileHash([string]$File) {
  $stream = [IO.File]::OpenRead($File); $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
  finally { $hash.Dispose(); $stream.Dispose() }
}
function Get-AcceptanceSettingsBaseline([string]$SettingsFile, [string]$BackupFile) {
  $exists = Test-Path -LiteralPath $SettingsFile
  if ($exists -and -not (Test-Path -LiteralPath $SettingsFile -PathType Leaf)) { throw 'The user settings path is not a file.' }
  $baseline = [ordered]@{ exists = $exists; sha256 = $null }
  if ($exists) {
    $baseline.sha256 = Get-AcceptanceFileHash $SettingsFile
    # Preserve bytes without copying EFS attributes to an unsupported volume.
    [IO.File]::WriteAllBytes($BackupFile, [IO.File]::ReadAllBytes($SettingsFile))
  }
  return $baseline
}
function Test-AcceptanceSettingsUnchanged([string]$SettingsFile, $Baseline) {
  $exists = Test-Path -LiteralPath $SettingsFile
  if ($exists -ne $Baseline.exists) { return $false }
  if (-not $exists) { return $true }
  return (Test-Path -LiteralPath $SettingsFile -PathType Leaf) -and (Get-AcceptanceFileHash $SettingsFile) -eq $Baseline.sha256
}
if (-not $AllowTemporaryEnvironment) { throw 'Temporary system settings require the user-authorized -AllowTemporaryEnvironment flag.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $projectRoot ('.local-evidence\environment-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AcceptanceScreenSaver {
  [DllImport("user32.dll", EntryPoint="SystemParametersInfoW", ExactSpelling=true, SetLastError=true)]
  static extern bool Read(uint action,uint value,ref int result,uint flags);
  public static int Get(uint action) { int value=0;if(!Read(action,0,ref value,0))throw new Win32Exception(Marshal.GetLastWin32Error());return value; }
  [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
  [StructLayout(LayoutKind.Sequential)] struct LastInput {public uint size,time;}
  [DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LastInput input);
  [DllImport("user32.dll")]static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")]static extern void mouse_event(uint flags,int x,int y,uint data,UIntPtr extra);
  [DllImport("user32.dll")]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",ExactSpelling=true,CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr desktop,int index,StringBuilder name,int capacity,out int needed);
  static ManualResetEvent stop;static Thread worker;public static int Nudges;
  static bool OrdinaryDesktop() {var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;try{var name=new StringBuilder(128);int needed;return GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed)&&name.ToString()=="Default";}finally{CloseDesktop(desktop);}}
  public static void Start() {
    if(Get(0x1026)!=0)throw new Exception("Synthetic activity cannot reset this system's idle timer.");
    stop=new ManualResetEvent(false);worker=new Thread(delegate(){while(!stop.WaitOne(2000)){
      var input=new LastInput{size=8};if(!OrdinaryDesktop()||!GetLastInputInfo(ref input)||unchecked((uint)Environment.TickCount-input.time)<20000)continue;
      Point before,after;if(!GetCursorPos(out before))continue;mouse_event(1,1,0,0,UIntPtr.Zero);Thread.Sleep(20);
      if(GetCursorPos(out after)&&Math.Abs(after.x-before.x)<=4&&after.y==before.y)SetCursorPos(before.x,before.y);
      Interlocked.Increment(ref Nudges);
    }});worker.IsBackground=true;worker.Start();
  }
  public static void Stop(){if(stop==null)return;stop.Set();if(!worker.Join(3000))throw new Exception("Idle helper did not stop.");stop.Dispose();stop=null;worker=null;}
}
'@
$original = [ordered]@{ active = [AcceptanceScreenSaver]::Get(0x0010); timeout = [AcceptanceScreenSaver]::Get(0x000E); secure = [AcceptanceScreenSaver]::Get(0x0076) }
$original | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidenceRoot 'screensaver-before.json') -Encoding UTF8
$releaseVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$livePath = if ($BridgeExecutable) { [IO.Path]::GetFullPath($BridgeExecutable) } else { Join-Path $projectRoot ('dist\app-' + $releaseVersion + '\CodexWallpaperBridge.exe') }
$nodeChildren = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
$live = @(Get-Process -Name CodexWallpaperBridge -ErrorAction SilentlyContinue | Where-Object { $candidate = $_; $candidate.Path -eq $livePath -and @($nodeChildren | Where-Object { $_.ParentProcessId -eq $candidate.Id -and $_.ExecutablePath -ieq (Join-Path (Split-Path $livePath) 'node.exe') }).Count -eq 1 })
if ($BridgeNotRunning) {
  if (@(Get-Process -Name CodexWallpaperBridge -ErrorAction SilentlyContinue).Count -ne 0) { throw 'BridgeNotRunning requires no Bridge hosts to be running before testing.' }
} elseif ($live.Count -ne 1) { throw 'Expected exactly one known user Bridge process before isolated testing.' }
$dataPath = Join-Path $env:LOCALAPPDATA 'CodexWallpaperBridge'
$settingsFile = Join-Path $dataPath 'settings.json'
$settingsBaseline = Get-AcceptanceSettingsBaseline $settingsFile (Join-Path $evidenceRoot 'settings.backup.json')
$keeping = $false; $stopped = $false; $result = [ordered]@{ original = $original; testExitCode = $null; restored = $false; systemPreferencesWritten = $false; bridgeInitiallyRunning = -not $BridgeNotRunning; settingsInitiallyExisted = $settingsBaseline.exists }
try {
  $desktopHelper = Join-Path $evidenceRoot 'DesktopProbe.exe'
  & (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /target:exe /platform:x64 "/out:$desktopHelper" (Join-Path $projectRoot 'scripts\experiments\CodexWindowProbe.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Desktop preflight helper compilation failed.' }
  $desktopState = (& $desktopHelper --desktop-state) | ConvertFrom-Json
  if ($desktopState.name -eq 'Screen-saver' -and $original.secure -eq 0 -and [AcceptanceScreenSaver]::Get(0x0072) -ne 0) {
    $registeredSaver = (Get-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop').'SCRNSAVE.EXE'
    if (-not [IO.Path]::IsPathRooted($registeredSaver) -or [IO.Path]::GetExtension($registeredSaver) -ine '.scr') { throw 'Unrecognized registered screen-saver executable.' }
    $screenProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId -and $_.Path -ieq $registeredSaver })
    if ($screenProcesses.Count -ne 1) { throw 'An exact registered ordinary screen-saver process is required.' }
    $saver = $screenProcesses[0]; $identity = $saver.StartTime.ToUniversalTime().Ticks
    $result.dismissedScreenSaverPid = $saver.Id
    $saverChildren = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $saver.Id) | Where-Object { $_.SessionId -eq $saver.SessionId -and $_.Name -match '^wallpaper(32|64)\.exe$' -and $_.CreationDate.ToUniversalTime().Ticks -ge $identity })
    [void]$saver.CloseMainWindow()
    if (-not $saver.WaitForExit(1000)) {
      $currentSaver = Get-Process -Id $saver.Id -ErrorAction Stop
      if ($currentSaver.Path -ine $registeredSaver -or $currentSaver.StartTime.ToUniversalTime().Ticks -ne $identity) { throw 'Screen-saver process identity changed.' }
      $currentSaver.Kill(); [void]$currentSaver.WaitForExit(3000)
    }
    foreach ($child in $saverChildren) {
      $worker = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
      if ($worker -and $worker.Path -ieq $child.ExecutablePath -and [Math]::Abs($worker.StartTime.ToUniversalTime().Ticks - $child.CreationDate.ToUniversalTime().Ticks) -lt 10) {
        [void]$worker.CloseMainWindow()
        if (-not $worker.WaitForExit(1000)) { $worker.Kill(); [void]$worker.WaitForExit(3000) }
      }
    }
    Start-Sleep -Milliseconds 600
  }
  $desktopState = (& $desktopHelper --desktop-state) | ConvertFrom-Json
  if (-not $desktopState.interactiveDesktopAvailable) { throw 'An ordinary interactive desktop is required before temporary environment changes.' }
  [AcceptanceScreenSaver]::Start(); $keeping = $true
  if (-not $BridgeNotRunning) {
  $stopped = $true
  # A freshly launched host creates its stop event only after Node/library/UI
  # startup. Reissue the normal signal until that event exists; do not lose a
  # single early signal and then launch a duplicate restoration host.
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(45); $result.stopSignals = 0
  while (-not $live[0].HasExited -and [DateTime]::UtcNow -lt $stopDeadline) {
    & $livePath --signal-stop
    $result.stopSignals++
    [void]$live[0].WaitForExit(500)
  }
  if (-not $live[0].HasExited) { throw 'Bridge did not finish restoring its own background.' }
  }
  Write-Output 'Acceptance environment ready: temporary idle helper active; no user Bridge controller running; screen-saver preferences untouched.'
  Push-Location -LiteralPath $projectRoot
  try { & node.exe $TestScript @TestArguments; $result.testExitCode = $LASTEXITCODE } finally { Pop-Location }
} finally {
  try {
    if ($keeping) { [AcceptanceScreenSaver]::Stop(); $result.keepAliveNudges = [AcceptanceScreenSaver]::Nudges }
    $result.after = [ordered]@{ active = [AcceptanceScreenSaver]::Get(0x0010); timeout = [AcceptanceScreenSaver]::Get(0x000E); secure = [AcceptanceScreenSaver]::Get(0x0076) }
    $result.restored = $result.after.active -eq $original.active -and $result.after.timeout -eq $original.timeout -and $result.after.secure -eq $original.secure
    if (-not $result.restored) { throw 'Screen-saver settings did not restore exactly.' }
  } finally {
    if ($stopped -and $live[0].HasExited) { $restarted = Start-Process -FilePath $livePath -ArgumentList '--background' -WindowStyle Hidden -PassThru; $result.restartedBridgePid = $restarted.Id }
    elseif ($stopped) { $result.originalBridgeStillRunning = $live[0].Id }
    $result.settingsUnchanged = Test-AcceptanceSettingsUnchanged $settingsFile $settingsBaseline
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'result.json') -Encoding UTF8
    Write-Output ('Environment restoration: ' + ($result | ConvertTo-Json -Depth 8 -Compress))
    Write-Output ('Evidence: ' + $evidenceRoot)
  }
}
if ($result.testExitCode -ne 0 -or -not $result.settingsUnchanged -or -not $result.restored) { exit 1 }
