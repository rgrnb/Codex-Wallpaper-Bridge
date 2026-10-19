param([string]$GraphicsHost = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class CwbApplicationSession : IDisposable {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved,desktop,title; public int x,y,width,height,xChars,yChars,fill,flags; public short show,reserved2;
    public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime;public uint flags;public UIntPtr minimum,maximum;public uint active;public UIntPtr affinity;public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimit basic;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  delegate bool Visit(IntPtr window,IntPtr parameter);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string file,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit,IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window,int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window,int index,int value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
  [DllImport("user32.dll",SetLastError=true)] static extern bool PostMessage(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  IntPtr job,process; int pid; long created; string executable,sourceFile,session; IntPtr window;bool preview;
  sealed class WindowDpi : IDisposable {
    readonly IntPtr previous;
    public WindowDpi(IntPtr target) {
      var context=GetWindowDpiAwarenessContext(target);
      if(context==IntPtr.Zero||(previous=SetThreadDpiAwarenessContext(context))==IntPtr.Zero)throw new Exception("APPLICATION_WINDOW_DPI_UNAVAILABLE");
    }
    public void Dispose() { SetThreadDpiAwarenessContext(previous); }
  }
  readonly string graphicsHost;string reviewedRuntime;object graphicsPointer;Type graphicsType;
  public CwbApplicationSession(string host) { graphicsHost=host; }
  static string Quote(string value) { var result=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}result.Append('\\',slashes).Append(c);slashes=0;}return result.Append('\\',slashes*2).Append('"').ToString(); }
  static string Hash(string file) { using(var stream=File.OpenRead(file))using(var hash=SHA256.Create())return String.Concat(hash.ComputeHash(stream).Select(x=>x.ToString("x2"))); }
  static int Bound(Dictionary<string,object> values,string key,int fallback,int minimum,int maximum) { object value;if(values!=null&&values.TryGetValue(key,out value)){int parsed;if(Int32.TryParse(Convert.ToString(value),out parsed))return Math.Max(minimum,Math.Min(maximum,parsed));}return fallback; }
  static Dictionary<string,object> Map(Dictionary<string,object> value,string key) { object found;return value.TryGetValue(key,out found)?found as Dictionary<string,object>:null; }
  string ProcessPath() { var buffer=new StringBuilder(32768);uint size=32768;if(!QueryFullProcessImageName(process,0,buffer,ref size))throw new Exception("APPLICATION_PROCESS_QUERY_FAILED");return Path.GetFullPath(buffer.ToString()); }
  long ProcessCreated() { long creation,exit,kernel,user;if(!GetProcessTimes(process,out creation,out exit,out kernel,out user))throw new Exception("APPLICATION_PROCESS_QUERY_FAILED");return creation+504911232000000000L; }
  void CheckIdentity(Dictionary<string,object> expected) {
    if(expected==null||Convert.ToString(expected["session"])!=session||Convert.ToInt32(expected["pid"])!=pid||Convert.ToString(expected["startTime"])!=created.ToString()||!String.Equals(Convert.ToString(expected["executable"]),executable,StringComparison.OrdinalIgnoreCase))throw new Exception("APPLICATION_SESSION_IDENTITY_INVALID");
  }
  void Check(Dictionary<string,object> expected) {
    CheckIdentity(expected);
    if(process==IntPtr.Zero||WaitForSingleObject(process,0)!=258)throw new Exception("APPLICATION_PROCESS_EXITED");
    bool member;if(!IsProcessInJob(process,job,out member)||!member)throw new Exception("APPLICATION_JOB_IDENTITY_INVALID");
    if(ProcessCreated()!=created||!String.Equals(ProcessPath(),executable,StringComparison.OrdinalIgnoreCase))throw new Exception("APPLICATION_PROCESS_IDENTITY_INVALID");
  }
  object Identity() { return new {pid=pid,startTime=created.ToString(),executable=executable,session=session,sourceFile=sourceFile,jobName="Local\\CodexWallpaperBridge.Application."+session}; }
  public object Start(Dictionary<string,object> request) {
    if(process!=IntPtr.Zero)throw new Exception("APPLICATION_SESSION_ALREADY_STARTED");
    executable=Convert.ToString(request["executable"]);session=Convert.ToString(request["session"]);sourceFile=request.ContainsKey("sourceFile")?Convert.ToString(request["sourceFile"]):executable;preview=request.ContainsKey("preview")&&request["preview"] is bool&&(bool)request["preview"];Guid token;
    if(!Guid.TryParse(session,out token)||!Path.IsPathRooted(executable)||!File.Exists(executable)||!String.Equals(Path.GetExtension(executable),".exe",StringComparison.OrdinalIgnoreCase))throw new Exception("APPLICATION_SOURCE_INVALID");
    executable=Path.GetFullPath(executable);string expectedHash=Convert.ToString(request["executableHash"]);
    if(expectedHash.Length!=64||Hash(executable)!=expectedHash)throw new Exception("APPLICATION_SOURCE_CHANGED");
    var reviewed=Map(request,"reviewedPointer");
    if(reviewed!=null) {
      reviewedRuntime=Convert.ToString(reviewed["runtimeToken"]);Guid runtimeGuid;
      if(Convert.ToString(reviewed["profile"])!="unity-2017.2-reviewed-sheep"||!Guid.TryParseExact(reviewedRuntime,"D",out runtimeGuid)||reviewedRuntime!=runtimeGuid.ToString("D")||
        Path.GetFileName(Path.GetDirectoryName(executable))!=reviewedRuntime||Path.GetFileName(Path.GetDirectoryName(Path.GetDirectoryName(executable)))!=".bridge-application-runtime"||
        !String.Equals(Path.GetFileName(executable),"sheep.exe",StringComparison.OrdinalIgnoreCase)||String.IsNullOrEmpty(graphicsHost)||!Path.IsPathRooted(graphicsHost)||!File.Exists(graphicsHost))throw new Exception("APPLICATION_POINTER_PROFILE_INVALID");
    }
    var command=new StringBuilder(Quote(executable));var arguments=request["arguments"] as System.Collections.IList;
    if(arguments==null||arguments.Count>32)throw new Exception("APPLICATION_ARGUMENTS_INVALID");
    foreach(object value in arguments){string arg=value as string;if(arg==null||arg.Length>2048||arg.Any(c=>c<' '))throw new Exception("APPLICATION_ARGUMENTS_INVALID");command.Append(' ').Append(Quote(arg));}
    var policy=Map(request,"policy");int width=Bound(policy,"maxWidth",1280,320,1920),height=Bound(policy,"height",720,180,2160);
    job=CreateJobObject(IntPtr.Zero,"Local\\CodexWallpaperBridge.Application."+session);var limits=new Limits();limits.basic.flags=0x2000;
    if(job==IntPtr.Zero||!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))))throw new Exception("APPLICATION_JOB_CREATE_FAILED");
    var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup)),x=preview?100:-10000,y=preview?100:-10000,width=width,height=height,flags=7,show=4};ProcessInfo started;
    if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x4,IntPtr.Zero,Path.GetDirectoryName(executable),ref startup,out started))throw new Exception("APPLICATION_CREATE_FAILED");
    process=started.process;pid=(int)started.pid;
    try {
      if(!AssignProcessToJobObject(job,process)){TerminateProcess(process,1);throw new Exception("APPLICATION_JOB_ASSIGN_FAILED");}
      created=ProcessCreated();if(!String.Equals(ProcessPath(),executable,StringComparison.OrdinalIgnoreCase))throw new Exception("APPLICATION_PROCESS_IDENTITY_INVALID");
      if(Hash(executable)!=expectedHash)throw new Exception("APPLICATION_SOURCE_CHANGED");
      // This worker intentionally has no post-launch mute operation. The trusted
      // caller must establish a reviewed silent source before asking to start it.
      if(ResumeThread(started.thread)==UInt32.MaxValue)throw new Exception("APPLICATION_RESUME_FAILED");
      return Identity();
    }finally{CloseHandle(started.thread);}
  }
  IntPtr Find(Dictionary<string,object> identity,Dictionary<string,object> policy) {
    Check(identity);
    for(int attempt=0;attempt<70;attempt++) {
      Check(identity);var found=new List<IntPtr>();
      EnumWindows(delegate(IntPtr candidate,IntPtr unused){uint owner;GetWindowThreadProcessId(candidate,out owner);Rect size;if(owner==pid&&IsWindowVisible(candidate)&&GetClientRect(candidate,out size)&&size.right>=64&&size.bottom>=64)found.Add(candidate);return true;},IntPtr.Zero);
      if(found.Count>1)throw new Exception("APPLICATION_WINDOW_AMBIGUOUS");
      if(found.Count==1){window=found[0];using(var dpi=new WindowDpi(window)){if(!preview){int style=GetWindowLong(window,-20);SetWindowLong(window,-20,(style|0x08000080)&~0x00040000);}
        if(!SetWindowPos(window,IntPtr.Zero,preview?100:-10000,preview?100:-10000,0,0,0x15))throw new Exception("APPLICATION_WINDOW_PARK_FAILED");
        Check(identity);return window;}}
      Thread.Sleep(100);
    }
    throw new Exception("APPLICATION_WINDOW_NOT_FOUND");
  }
  public object Surface(Dictionary<string,object> request) {
    var expected=Map(request,"identity");var found=Find(expected,Map(request,"policy"));Rect size;
    using(var dpi=new WindowDpi(found)) {
    if(!GetClientRect(found,out size)||size.right<1||size.bottom<1)throw new Exception("APPLICATION_FRAME_SIZE_INVALID");
    if(reviewedRuntime!=null&&graphicsPointer==null) {
      var assembly=Assembly.LoadFrom(Path.GetFullPath(graphicsHost));graphicsType=assembly.GetType("CodexWallpaperBridge.GraphicsCaptureBridge",true);
      graphicsPointer=graphicsType.GetMethod("CreateReviewedApplication",BindingFlags.Static|BindingFlags.Public).Invoke(null,new object[]{found,pid,reviewedRuntime,session,sourceFile});
      Check(expected);
    }
    return new {hwnd=found.ToInt64().ToString(),pid=pid,startTime=created.ToString(),session=session,type="application",sourceFile=executable,width=size.right,height=size.bottom,backend="independent-owned-application",applicationSession=Identity()};
    }
  }
  public object Capture(Dictionary<string,object> request) {
    var expected=Map(request,"identity");Check(expected);uint owner;Rect size;
    using(var dpi=new WindowDpi(window)) {
    GetWindowThreadProcessId(window,out owner);
    if(window==IntPtr.Zero||owner!=pid||!GetClientRect(window,out size)||size.right<1||size.bottom<1||(long)size.right*size.bottom>16777216)throw new Exception("APPLICATION_FRAME_OWNER_INVALID");
    var policy=Map(request,"policy");int width=Math.Min(size.right,Bound(policy,"maxWidth",1280,320,1920)),height=Math.Max(1,(int)Math.Round((double)size.bottom*width/size.right)),quality=Bound(policy,"jpegQuality",75,30,95);
    using(var frame=new Bitmap(size.right,size.bottom,PixelFormat.Format32bppRgb)) {
      using(var graphics=Graphics.FromImage(frame)){var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,3))throw new Exception("APPLICATION_GDI_CAPTURE_UNSUPPORTED");}finally{graphics.ReleaseHdc(dc);}}
      Check(expected);GetWindowThreadProcessId(window,out owner);if(owner!=pid)throw new Exception("APPLICATION_FRAME_OWNER_INVALID");
      using(var resized=new Bitmap(width,height))using(var graphics=Graphics.FromImage(resized))using(var memory=new MemoryStream())using(var parameters=new EncoderParameters(1)){
        graphics.DrawImage(frame,0,0,width,height);parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,(long)quality);
        resized.Save(memory,ImageCodecInfo.GetImageEncoders().First(x=>x.MimeType=="image/jpeg"),parameters);
        if(memory.Length>4*1024*1024)throw new Exception("APPLICATION_FRAME_TOO_LARGE");
        bool visible=false;
        for(int y=0;y<height&&!visible;y+=Math.Max(1,height/12))for(int x=0;x<width;x+=Math.Max(1,width/12)){var color=resized.GetPixel(x,y);if(color.R>8||color.G>8||color.B>8){visible=true;break;}}
        return new {jpeg=Convert.ToBase64String(memory.ToArray()),width=width,height=height,clientWidth=size.right,clientHeight=size.bottom,visibleContent=visible,backend="independent-owned-gdi"};
      }
    }
    }
  }
  public async Task<object> Pointer(Dictionary<string,object> request) {
    Check(Map(request,"identity"));uint owner;Rect size;GetWindowThreadProcessId(window,out owner);
    var input=Map(request,"event");string kind=Convert.ToString(input["type"]);double x=Convert.ToDouble(input["x"]),y=Convert.ToDouble(input["y"]);
    if((kind!="move"&&kind!="click")||Double.IsNaN(x)||Double.IsNaN(y)||x<0||x>1||y<0||y>1)throw new Exception("APPLICATION_POINTER_INVALID");
    IntPtr position;int pointX,pointY;bool down=false,up=false;
    using(var dpi=new WindowDpi(window)) {
      if(window==IntPtr.Zero||owner!=pid||!GetClientRect(window,out size)||size.right<1||size.bottom<1)throw new Exception("APPLICATION_FRAME_OWNER_INVALID");
      pointX=(int)Math.Round(x*(size.right-1));pointY=(int)Math.Round(y*(size.bottom-1));
      if(graphicsPointer!=null)graphicsType.GetMethod("Pointer").Invoke(graphicsPointer,new object[]{x,y,kind=="click"});
      position=new IntPtr(((pointY&0xffff)<<16)|(pointX&0xffff));
      // The WM coordinates and shared polling coordinates use the same target
      // DPI context. Do not retain a thread context across the asynchronous hold.
      if(!PostMessage(window,0x0200,IntPtr.Zero,position))throw new Exception("APPLICATION_POINTER_FAILED_MOVE_"+Marshal.GetLastWin32Error());
      if(kind=="click")down=PostMessage(window,0x0201,new IntPtr(1),position);
    }
    if(kind=="click") {
      try {
        // Let the renderer observe the held button across an update. Await on
        // the pumped owner thread; sleeping here can block its input queue.
        if(down)await Task.Delay(80);
      }
      finally {
        // Always pair a queued press while this HWND is still owned.
        Check(Map(request,"identity"));GetWindowThreadProcessId(window,out owner);
        if(owner==pid)up=PostMessage(window,0x0202,IntPtr.Zero,position);
      }
      if(!down||!up)throw new Exception("APPLICATION_POINTER_FAILED");
    }
    return new {queued=true,clientWidth=size.right,clientHeight=size.bottom,messageX=pointX,messageY=pointY,privatePointer=graphicsPointer==null?null:graphicsType.GetProperty("PointerDiagnostics").GetValue(graphicsPointer,null)};
  }
  public object Stop(Dictionary<string,object> request) { if(process!=IntPtr.Zero)CheckIdentity(Map(request,"identity"));Dispose();return new {stopped=true}; }
  public void Dispose() { try{if(graphicsPointer!=null)((IDisposable)graphicsPointer).Dispose();}finally{graphicsPointer=null;if(job!=IntPtr.Zero){TerminateJobObject(job,0);if(process!=IntPtr.Zero)WaitForSingleObject(process,2500);CloseHandle(job);job=IntPtr.Zero;}if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;}window=IntPtr.Zero;} }
  public static void Run(string graphicsHost) {
    var serializer=new JavaScriptSerializer{MaxJsonLength=8*1024*1024};
    var active=new CwbApplicationSession(graphicsHost);
    using(var dispatcher=new Control()) {
      // Window parking/capture can connect Win32 input queues. The owning
      // thread must keep pumping while the protocol reader waits on stdin;
      // otherwise the target's GetKeyState/default mouse handling can block.
      var handle=dispatcher.Handle;
      var reader=new Thread(delegate(){try {
        string line;
        while((line=Console.ReadLine())!=null) {
          object id=null;
          try {
            if(line.Length>131072)throw new Exception("APPLICATION_REQUEST_TOO_LARGE");
            var request=serializer.Deserialize<Dictionary<string,object>>(line);id=request["id"];
            object result=dispatcher.Invoke(new Func<object>(delegate(){
              switch(Convert.ToString(request["operation"])) {
                case "start":return active.Start(request);case "surface":return active.Surface(request);case "capture":return active.Capture(request);
                case "pointer":return active.Pointer(request);case "stop":return active.Stop(request);default:throw new Exception("APPLICATION_OPERATION_INVALID");
              }
            }));
            var asynchronous=result as Task<object>;if(asynchronous!=null)result=asynchronous.GetAwaiter().GetResult();
            Console.WriteLine(serializer.Serialize(new{id=id,result=result}));
          } catch(Exception error) {
            while(error is System.Reflection.TargetInvocationException&&error.InnerException!=null)error=error.InnerException;
            string code=error.Message.StartsWith("APPLICATION_")?error.Message:error.Message.StartsWith("GRAPHICS_")?"APPLICATION_"+error.Message:"APPLICATION_WORKER_FAILED_"+error.GetType().Name.ToUpperInvariant();
            Console.WriteLine(serializer.Serialize(new{id=id,error=code}));
          }
          Console.Out.Flush();
        }
      } finally { if(!dispatcher.IsDisposed)dispatcher.BeginInvoke(new Action(delegate(){active.Dispose();Application.ExitThread();})); }});
      reader.IsBackground=true;reader.SetApartmentState(ApartmentState.MTA);reader.Start();
      try { Application.Run(); } finally { active.Dispose();reader.Join(1000); }
    }
  }
}
'@ -ReferencedAssemblies 'System.Drawing.dll','System.Web.Extensions.dll','System.Core.dll','System.Windows.Forms.dll'
[CwbApplicationSession]::Run($GraphicsHost)
