using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexWallpaperBridge {
  // A separate renderer with its own installation directory/configuration. The
  // installed desktop engine never receives a control, pause or mute command.
  internal sealed class IsolatedWallpaperHost : Form {
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
      public int cb; public string reserved,desktop,title; public int x,y,width,height,xChars,yChars,fill,flags; public short show,reserved2;
      public IntPtr reservedPtr,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread;public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {public long processTime,jobTime;public uint flags;public UIntPtr minimum,maximum;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
    [StructLayout(LayoutKind.Sequential)] struct Io {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct Limits {public BasicLimit basic;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
    delegate bool Visit(IntPtr window,IntPtr parameter);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string file,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr buffer,uint size,out uint returned);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr root,Visit callback,IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder value,int count);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder value,int count);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Native.Rect rect);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
    readonly Dictionary<string,object> request;
    readonly Timer timer=new Timer{Interval=50};
    string token,root,executable,kind;IntPtr job,process,renderer;int enginePid;long engineStarted,hostStarted;
    bool ready,disposed;DateTime deadline;
    protected override bool ShowWithoutActivation { get {return !BooleanValue(request,"preview");} }
    protected override CreateParams CreateParams {get{var p=base.CreateParams;if(!BooleanValue(request,"preview"))p.ExStyle|=0x08000080;return p;}}
    static string Value(Dictionary<string,object> map,string key){object value;return map!=null&&map.TryGetValue(key,out value)?Convert.ToString(value):"";}
    static bool BooleanValue(Dictionary<string,object> map,string key){object value;return map!=null&&map.TryGetValue(key,out value)&&value is bool&&(bool)value;}
    static string Hash(string file){using(var stream=File.OpenRead(file))using(var sha=SHA256.Create())return String.Concat(sha.ComputeHash(stream).Select(x=>x.ToString("x2")));}
    static Dictionary<string,object> Map(Dictionary<string,object> map,string key){object value;return map!=null&&map.TryGetValue(key,out value)?value as Dictionary<string,object>:null;}
    static string Class(IntPtr window){var text=new StringBuilder(256);GetClassName(window,text,256);return text.ToString();}
    static string Title(IntPtr window){var text=new StringBuilder(256);GetWindowText(window,text,256);return text.ToString();}
    static string JobName(string token){return "Local\\CodexWallpaperBridge.Isolated."+token;}
    static void Reply(object id,object value){Console.WriteLine(Program.Json.Serialize(new{id=id,result=value}));Console.Out.Flush();}
    static void Failure(object id,Exception error){string code=System.Text.RegularExpressions.Regex.IsMatch(error.Message,"^ISOLATED_[A-Z0-9_]+$")?error.Message:"ISOLATED_HOST_FAILED";Console.WriteLine(Program.Json.Serialize(new{id=id,error=code}));Console.Out.Flush();}
    IsolatedWallpaperHost(Dictionary<string,object> initial){request=initial;}
    void StartEngine(){
      token=Value(request,"token");Guid parsed;
      if(!Guid.TryParseExact(token,"D",out parsed))throw new Exception("ISOLATED_TOKEN_INVALID");
      root=Path.GetFullPath(Value(request,"root"));executable=Path.Combine(root,"wallpaper64.exe");kind=Value(request,"type");
      if(!new[]{"scene","web","video"}.Contains(kind)||!Path.IsPathRooted(root)||!Path.GetFileName(root).Equals("cwb-runtime-"+token,StringComparison.Ordinal))throw new Exception("ISOLATED_RUNTIME_INVALID");
      var marker=Program.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,".bridge-isolated.json")));
      if(Value(marker,"token")!=token||Value(marker,"type")!=kind||Hash(executable)!=Value(marker,"engineHash")||Value(marker,"engineHash")!=Hash(Value(marker,"installedEngine")))throw new Exception("ISOLATED_RUNTIME_IDENTITY_INVALID");
      if(FileVersionInfo.GetVersionInfo(executable).ProductVersion!="2.8.0.42")throw new Exception("ISOLATED_ENGINE_VERSION_UNVERIFIED");
      var config=Program.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"config.json")));
      var general=Map(Map(config,Environment.UserName),"general");var user=Map(general,"user");
      object audio;if(user==null||!user.TryGetValue("videoaudiooutput",out audio)||!(audio is bool)||(bool)audio||BooleanValue(user,"autostart")||BooleanValue(user,"autostartscheduler")||BooleanValue(user,"overridewallpaper")||BooleanValue(user,"overridelockscreen"))throw new Exception("ISOLATED_MUTE_CONFIGURATION_INVALID");
      var selected=Map(Map(general,"wallpaperconfigscreensaver"),"selectedwallpapers");
      if(selected==null||selected.Count!=1||Value(Map(selected,"Monitor0"),"file")!=Value(marker,"resource").Replace('\\','/'))throw new Exception("ISOLATED_SOURCE_CONFIGURATION_INVALID");
      int width=Math.Max(320,Math.Min(3840,Convert.ToInt32(request["width"]))),height=Math.Max(180,Math.Min(2160,Convert.ToInt32(request["height"])));
      bool preview=BooleanValue(request,"preview");Text="CodexBridgeIsolated-"+token;ShowInTaskbar=preview;
      FormBorderStyle=preview?FormBorderStyle.Sizable:FormBorderStyle.None;StartPosition=FormStartPosition.Manual;
      Location=new System.Drawing.Point(preview?100:-12000,preview?100:-12000);ClientSize=new System.Drawing.Size(width,height);
      var unused=Handle;using(var current=Process.GetCurrentProcess())hostStarted=current.StartTime.ToUniversalTime().Ticks;
      job=CreateJobObject(IntPtr.Zero,JobName(token));var limits=new Limits();limits.basic.flags=0x2000;
      if(job==IntPtr.Zero||!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))))throw new Exception("ISOLATED_JOB_CREATE_FAILED");
      var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup)),flags=1,show=4};ProcessInfo child;
      var command=new StringBuilder("\""+executable+"\" -screensaver -host "+Handle.ToInt64()+" -preview -silent");
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,root,ref startup,out child))throw new Exception("ISOLATED_CREATE_FAILED");
      process=child.process;enginePid=(int)child.pid;
      try{
        if(!AssignProcessToJobObject(job,process)){TerminateProcess(process,1);throw new Exception("ISOLATED_JOB_ASSIGN_FAILED");}
        using(var current=Process.GetProcessById(enginePid))engineStarted=current.StartTime.ToUniversalTime().Ticks;
        if(ResumeThread(child.thread)==UInt32.MaxValue)throw new Exception("ISOLATED_RESUME_FAILED");
      }finally{CloseHandle(child.thread);}
      deadline=DateTime.UtcNow.AddSeconds(18);timer.Tick+=delegate{Poll();};timer.Start();
    }
    object Surface(){
      if(!ready||renderer==IntPtr.Zero)throw new Exception("ISOLATED_NOT_READY");
      var capture=kind=="scene"?renderer:Handle;uint owner;GetWindowThreadProcessId(capture,out owner);Native.Rect size;
      if(!GetClientRect(capture,out size)||size.Right<1||size.Bottom<1)throw new Exception("ISOLATED_SIZE_INVALID");
      return new{hwnd=capture.ToInt64().ToString(),pid=(int)owner,type=kind,width=size.Right,height=size.Bottom,
        isolated=new{token=token,hostPid=Process.GetCurrentProcess().Id,hostStarted=hostStarted.ToString(),hostHwnd=Handle.ToInt64().ToString(),enginePid=enginePid,engineStarted=engineStarted.ToString(),enginePath=executable,renderer=renderer.ToInt64().ToString(),type=kind},
        audioConfiguration="private-engine-output-disabled",processes=OwnedProcesses()};
    }
    object[] OwnedProcesses(){
      int capacity=128;var rows=new List<object>();var buffer=Marshal.AllocHGlobal(8+capacity*IntPtr.Size);
      try{uint returned;if(!QueryInformationJobObject(job,3,buffer,(uint)(8+capacity*IntPtr.Size),out returned))throw new Exception("ISOLATED_JOB_QUERY_FAILED");
        int count=Marshal.ReadInt32(buffer,4);if(count<1||count>capacity)throw new Exception("ISOLATED_JOB_QUERY_FAILED");
        for(int n=0;n<count;n++){int pid=(int)Marshal.ReadIntPtr(buffer,8+n*IntPtr.Size).ToInt64();try{using(var p=Process.GetProcessById(pid))rows.Add(new{pid=pid,started=p.StartTime.ToUniversalTime().Ticks.ToString(),executable=p.MainModule.FileName});}catch{}}
      }finally{Marshal.FreeHGlobal(buffer);}return rows.ToArray();
    }
    void Poll(){
      try{
        if(WaitForSingleObject(process,0)!=258)throw new Exception("ISOLATED_ENGINE_EXITED");
        if(ready)return;
        var matches=new List<IntPtr>();string expected=kind=="scene"?"WPEDesktopDX11Window":kind=="web"?"WPEDesktopCEFWindow":"WPEVideoWallpaper";
        EnumChildWindows(Handle,delegate(IntPtr h,IntPtr p){uint pid;GetWindowThreadProcessId(h,out pid);if(Class(h)==expected&&Member((int)pid,job))matches.Add(h);return true;},IntPtr.Zero);
        if(matches.Count>1)throw new Exception("ISOLATED_RENDERER_AMBIGUOUS");
        if(matches.Count==1){renderer=matches[0];ready=true;Reply(request["id"],Surface());return;}
        if(DateTime.UtcNow>deadline)throw new Exception("ISOLATED_RENDERER_TIMEOUT");
      }catch(Exception error){timer.Stop();if(!ready)Failure(request["id"],error);Close();}
    }
    void Command(Dictionary<string,object> row){
      object id=row.ContainsKey("id")?row["id"]:null;
      try{
        if(Value(row,"token")!=token)throw new Exception("ISOLATED_TOKEN_INVALID");
        switch(Value(row,"action")){
          case "surface":Reply(id,Surface());break;
          case "input-endpoint":
            int port=Convert.ToInt32(row["port"]);if(port<1024||port>65535||!ready||kind!="web")throw new Exception("ISOLATED_INPUT_ENDPOINT_INVALID");
            var owners=Native.Listeners().Where(pair=>pair.Value.Contains(port)&&Member((int)pair.Key,job)).ToArray();
            if(owners.Length!=1)throw new Exception("ISOLATED_INPUT_ENDPOINT_UNAVAILABLE");
            Reply(id,new{verified=true,pid=owners[0].Key,port=port});break;
          case "pointer":
            if(!ready)throw new Exception("ISOLATED_NOT_READY");
            double x=Convert.ToDouble(row["x"]),y=Convert.ToDouble(row["y"]);string type=Value(row,"type");
            if(Double.IsNaN(x)||Double.IsNaN(y)||x<0||x>1||y<0||y>1||!new[]{"move","click"}.Contains(type))throw new Exception("ISOLATED_POINTER_INVALID");
            uint owner;GetWindowThreadProcessId(renderer,out owner);Native.Rect r;
            if(!Member((int)owner,job)||GetAncestor(renderer,2)!=Handle||!GetClientRect(renderer,out r))throw new Exception("ISOLATED_RENDERER_CHANGED");
            int px=(int)Math.Round(x*(r.Right-1)),py=(int)Math.Round(y*(r.Bottom-1));var point=new IntPtr((py<<16)|(px&65535));
            PostMessage(renderer,0x200,IntPtr.Zero,point);
            if(type=="click"){
              var target=renderer;var parent=Handle;uint targetOwner;GetWindowThreadProcessId(target,out targetOwner);var ownedJob=job;
              PostMessage(target,0x201,new IntPtr(1),point);
              Task.Delay(80).ContinueWith(ignored=>{uint releaseOwner;GetWindowThreadProcessId(target,out releaseOwner);if(releaseOwner==targetOwner&&Member((int)releaseOwner,ownedJob)&&GetAncestor(target,2)==parent)PostMessage(target,0x202,IntPtr.Zero,point);});
            }
            Reply(id,new{sent=true});break;
          case "stop":Reply(id,new{stopped=true});Close();break;
          default:throw new Exception("ISOLATED_ACTION_INVALID");
        }
      }catch(Exception error){Failure(id,error);}
    }
    static bool Member(int pid,IntPtr job){try{using(var p=Process.GetProcessById(pid)){bool yes;return IsProcessInJob(p.Handle,job,out yes)&&yes;}}catch{return false;}}
    protected override void Dispose(bool disposing){if(!disposed){disposed=true;timer.Stop();timer.Dispose();if(job!=IntPtr.Zero){TerminateJobObject(job,0);CloseHandle(job);job=IntPtr.Zero;}if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;}}base.Dispose(disposing);}
    internal static int Run(){
      Program.SetPipes();string first=Console.ReadLine();if(first==null||first.Length>8192)throw new Exception("ISOLATED_REQUEST_INVALID");
      var request=Program.Json.Deserialize<Dictionary<string,object>>(first);
      using(var host=new IsolatedWallpaperHost(request)){
        try{host.StartEngine();}catch(Exception error){Failure(request.ContainsKey("id")?request["id"]:null,error);return 1;}
        Task.Run(()=>{try{string line;while((line=Console.ReadLine())!=null){if(line.Length>8192)break;var next=Program.Json.Deserialize<Dictionary<string,object>>(line);host.BeginInvoke(new Action(()=>host.Command(next)));}}catch{}finally{try{host.BeginInvoke(new Action(host.Close));}catch{}}});
        Application.Run(host);
      }
      return 0;
    }
    internal static void ValidateSurface(Dictionary<string,object> proof,IntPtr window,int pid){
      IntPtr job=IntPtr.Zero;
      try{
        string token=Value(proof,"token");Guid parsed;if(!Guid.TryParseExact(token,"D",out parsed))throw new Exception();
        int hostPid=Convert.ToInt32(proof["hostPid"]),enginePid=Convert.ToInt32(proof["enginePid"]);var hostHwnd=new IntPtr(Int64.Parse(Value(proof,"hostHwnd")));var renderer=new IntPtr(Int64.Parse(Value(proof,"renderer")));
        using(var host=Process.GetProcessById(hostPid))if(host.StartTime.ToUniversalTime().Ticks.ToString()!=Value(proof,"hostStarted")||!String.Equals(host.MainModule.FileName,Program.Executable,StringComparison.OrdinalIgnoreCase))throw new Exception();
        using(var engine=Process.GetProcessById(enginePid))if(engine.StartTime.ToUniversalTime().Ticks.ToString()!=Value(proof,"engineStarted")||!String.Equals(engine.MainModule.FileName,Value(proof,"enginePath"),StringComparison.OrdinalIgnoreCase))throw new Exception();
        uint rootOwner,renderOwner,captureOwner;GetWindowThreadProcessId(hostHwnd,out rootOwner);GetWindowThreadProcessId(renderer,out renderOwner);GetWindowThreadProcessId(window,out captureOwner);
        if(rootOwner!=hostPid||Title(hostHwnd)!="CodexBridgeIsolated-"+token||GetAncestor(renderer,2)!=hostHwnd||captureOwner!=pid)throw new Exception();
        job=OpenJobObject(4,false,JobName(token));if(job==IntPtr.Zero||!Member(enginePid,job)||!Member((int)renderOwner,job))throw new Exception();
        string type=Value(proof,"type");
        if(type=="scene"){if(window!=renderer||renderOwner!=enginePid||Class(renderer)!="WPEDesktopDX11Window")throw new Exception();}
        else if(type=="web"||type=="video"){if(window!=hostHwnd||pid!=hostPid)throw new Exception();}
        else throw new Exception();
      }catch{throw new Exception("FRAME_ISOLATED_IDENTITY_INVALID");}finally{if(job!=IntPtr.Zero)CloseHandle(job);}
    }
  }
}
