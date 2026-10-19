param([string]$Engine = 'D:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe', [int]$Seconds = 6)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$sourceRoot = Split-Path -Parent $Engine
$runRoot = Join-Path $workspace ('.local-evidence\private-we-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $runRoot 'bin') -Force | Out-Null
$privateEngine = Join-Path $runRoot 'wallpaper64.exe'
Copy-Item -LiteralPath $Engine -Destination $privateEngine
# Only installed engine libraries are staged. Wallpaper resources are referenced,
# never copied. Engine configuration and caches belong to this private directory.
foreach ($file in @('resourceutil64.dll','scenescript64.dll','FreeImage64.dll','assimp-vc143-mt64.dll','d3dcompiler_47.dll','steam_api64.dll','CUESDK.x64_2017.dll','cloneextensions64.dll','steam_appid.txt')) {
  $from = Join-Path $sourceRoot ('bin\' + $file)
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $runRoot ('bin\' + $file)) }
}
foreach ($directory in @('assets','locale')) {
  New-Item -ItemType Junction -Path (Join-Path $runRoot $directory) -Target (Join-Path $sourceRoot $directory) | Out-Null
}
$originalConfig = Join-Path $sourceRoot 'config.json'
$before = (Get-FileHash -LiteralPath $originalConfig -Algorithm SHA256).Hash
$source = (Join-Path $sourceRoot 'projects\defaultprojects\shimmering_particles\scene.json').Replace('\','/')
$general = @{
  user = @{ videoaudiooutput = $false; autostart = $false; autostartscheduler = $false; overridewallpaper = $false; overridelockscreen = $false; fps = 30; playbackfocus = 'run'; playbackmaximized = 'run'; playbackfullscreen = 'run'; playbacksleep = 'run'; playbackaudio = 'run'; safemode = $false; plugins = @{} }
  wallpaperconfig = @{ selectedwallpapers = @{ Monitor0 = @{file = $source} } }
  wallpaperconfigscreensaver = @{ sameaswallpaper = $false; selectedwallpapers = @{ Monitor0 = @{file = $source} } }
}
$profile = @{ version = 1; general = $general }
$config = @{ '?installdirectory' = $runRoot.Replace('\','/') }
$config[[Environment]::UserName] = $profile
[IO.File]::WriteAllText((Join-Path $runRoot 'config.json'), ($config | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding $false))
$definition = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public class PrivatePreviewHost : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p=base.CreateParams;p.ExStyle|=0x08000080;return p; } }
  delegate bool Visit(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr parent,Visit callback,IntPtr parameter);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr window,StringBuilder name,int count);
  public static Dictionary<string,object> Run(string executable,int seconds) {
    var result=new Dictionary<string,object>();Process child=null;
    using(var form=new PrivatePreviewHost()) {
      form.Text="CodexBridgePrivatePreview-"+Guid.NewGuid().ToString("N");form.ShowInTaskbar=false;form.StartPosition=FormStartPosition.Manual;
      form.Location=new System.Drawing.Point(-12000,-12000);form.ClientSize=new System.Drawing.Size(640,360);form.Show();
      result["host"]=form.Handle.ToInt64().ToString();
      try {
        child=Process.Start(new ProcessStartInfo(executable,"-screensaver -host "+form.Handle.ToInt64()+" -preview -silent") {UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=System.IO.Path.GetDirectoryName(executable)});
        result["pid"]=child.Id;result["started"]=child.StartTime.ToUniversalTime().ToString("O");
        var end=DateTime.UtcNow.AddSeconds(Math.Max(2,Math.Min(20,seconds)));
        while(DateTime.UtcNow<end&&!child.HasExited){Application.DoEvents();Thread.Sleep(20);}
        result["exited"]=child.HasExited;if(child.HasExited)result["exitCode"]=child.ExitCode;
        var windows=new List<object>();
        EnumChildWindows(form.Handle,delegate(IntPtr h,IntPtr p){uint pid;GetWindowThreadProcessId(h,out pid);var name=new StringBuilder(256);GetClassName(h,name,256);windows.Add(new{hwnd=h.ToInt64().ToString(),pid=pid,className=name.ToString()});return true;},IntPtr.Zero);
        result["children"]=windows;
      } finally {
        if(child!=null){if(!child.HasExited){child.Kill();child.WaitForExit(5000);}child.Dispose();}
        form.Close();
      }
    }
    return result;
  }
}
'@
Add-Type -TypeDefinition $definition -ReferencedAssemblies System.Windows.Forms,System.Drawing
$result = [PrivatePreviewHost]::Run($privateEngine,$Seconds)
$result['originalConfigUnchanged'] = ((Get-FileHash -LiteralPath $originalConfig -Algorithm SHA256).Hash -eq $before)
$result['evidence'] = $runRoot
$json = $result | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $runRoot 'result.json'),$json)
$json
