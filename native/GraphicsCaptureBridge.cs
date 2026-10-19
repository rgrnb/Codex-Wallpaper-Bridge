using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
namespace CodexWallpaperBridge {
  // Exact-HWND D3D11 presentation capture. No audio APIs, monitor capture, or source asset writes.
  internal sealed class GraphicsCaptureBridge : IDisposable {
    const int Capacity = 64 * 1024 * 1024;
    readonly MemoryMappedFile map; readonly MemoryMappedViewAccessor view;
    readonly IntPtr process; IntPtr remoteThread, remoteBase; bool disposed;
    readonly bool privatePointer;
    public IntPtr Window { get; private set; }
    public bool IsPaused { get; private set; }
    public int Sequence { get { return lastSequence; } }
    public object PointerDiagnostics { get { return new { enabled=view.ReadInt32(168),profile=view.ReadInt32(84),cursorReads=view.ReadInt32(212),buttonReads=view.ReadInt32(216),x=view.ReadInt32(92),y=view.ReadInt32(96),clientWidth=view.ReadInt32(224),clientHeight=view.ReadInt32(228),presentReads=view.ReadInt32(72),sequence=view.ReadInt32(52) }; } }
    byte[] readBuffer;
    int lastSequence; DateTime lastFrameAt=DateTime.UtcNow;
    [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")]static extern IntPtr VirtualAllocEx(IntPtr process,IntPtr address,UIntPtr size,uint type,uint protection);
    [DllImport("kernel32.dll")]static extern bool VirtualFreeEx(IntPtr process,IntPtr address,UIntPtr size,uint type);
    [DllImport("kernel32.dll")]static extern bool WriteProcessMemory(IntPtr process,IntPtr address,byte[] bytes,UIntPtr size,out UIntPtr written);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll",CharSet=CharSet.Ansi)]static extern IntPtr GetProcAddress(IntPtr module,string name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr LoadLibraryEx(string file,IntPtr reserved,uint flags);
    [DllImport("kernel32.dll")]static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll")]static extern IntPtr CreateRemoteThread(IntPtr process,IntPtr attributes,UIntPtr stack,IntPtr start,IntPtr parameter,uint flags,out uint id);
    [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll")]static extern bool GetExitCodeThread(IntPtr thread,out uint code);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]static extern ulong GetTickCount64();
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
    [DllImport("kernel32.dll")]static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out Native.Rect rect);
    public GraphicsCaptureBridge(IntPtr window,int pid,string privateToken=null):this(window,pid,privateToken,null,null) { }
    static bool SamePath(string first,string second) { return String.Equals(Path.GetFullPath(first),Path.GetFullPath(second),StringComparison.OrdinalIgnoreCase); }
    static string FileHash(string file) { using(var hash=SHA256.Create())using(var stream=File.OpenRead(file))return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
    static void ReviewedTree(string root) {
      var files=new List<string>();var pending=new Stack<string>();pending.Push(root);long bytes=0;int directories=0;
      while(pending.Count>0) {
        string folder=pending.Pop();if(++directories>256)throw new Exception("GRAPHICS_APPLICATION_SOURCE_INVALID");
        if((File.GetAttributes(folder)&FileAttributes.ReparsePoint)!=0)throw new Exception("GRAPHICS_APPLICATION_SOURCE_INVALID");
        foreach(string entry in Directory.GetFileSystemEntries(folder)) {
          var attributes=File.GetAttributes(entry);if((attributes&FileAttributes.ReparsePoint)!=0)throw new Exception("GRAPHICS_APPLICATION_SOURCE_INVALID");
          if((attributes&FileAttributes.Directory)!=0)pending.Push(entry);else {files.Add(entry);bytes+=new FileInfo(entry).Length;if(files.Count>256||bytes>64*1024*1024)throw new Exception("GRAPHICS_APPLICATION_SOURCE_INVALID");}
        }
      }
      files.Sort(delegate(string first,string second){return String.CompareOrdinal(first.Substring(root.Length+1).Replace('\\','/'),second.Substring(root.Length+1).Replace('\\','/'));});
      using(var hash=SHA256.Create()) {
        foreach(string file in files){var name=Encoding.UTF8.GetBytes(file.Substring(root.Length+1).Replace('\\','/')+"\0");hash.TransformBlock(name,0,name.Length,name,0);var data=File.ReadAllBytes(file);hash.TransformBlock(data,0,data.Length,data,0);}
        hash.TransformFinalBlock(new byte[0],0,0);
        if(BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant()!="e09a40b06aafadf8e5d9603a5ca0884ce953b1ad550724044ef3a52e3b414d4a")throw new Exception("GRAPHICS_APPLICATION_SOURCE_CHANGED");
      }
    }
    // This is deliberately a separate, closed factory. A caller-provided flag
    // cannot turn the ordinary capture constructor into an arbitrary App hook.
    public static GraphicsCaptureBridge CreateReviewedApplication(IntPtr window,int pid,string runtimeToken,string session,string sourceFile) {
      if(IntPtr.Size!=4)throw new Exception("GRAPHICS_APPLICATION_ARCHITECTURE_INVALID");
      Guid runtimeGuid,sessionGuid;
      if(!Guid.TryParseExact(runtimeToken,"D",out runtimeGuid)||runtimeToken!=runtimeGuid.ToString("D")||!Guid.TryParseExact(session,"D",out sessionGuid)||session!=sessionGuid.ToString("D"))throw new Exception("GRAPHICS_APPLICATION_TOKEN_INVALID");
      string actual;using(var target=Process.GetProcessById(pid))actual=Path.GetFullPath(target.MainModule.FileName);
      string root=Path.GetDirectoryName(actual),baseFolder=Path.GetDirectoryName(root),installed=Path.GetDirectoryName(baseFolder);
      if(Path.GetFileName(root)!=runtimeToken||Path.GetFileName(baseFolder)!=".bridge-application-runtime"||!SamePath(actual,Path.Combine(root,"sheep.exe"))||
        !SamePath(sourceFile,Path.Combine(installed,"projects","defaultprojects","sheep","sheep.exe"))||
        (File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0||(File.GetAttributes(baseFolder)&FileAttributes.ReparsePoint)!=0)throw new Exception("GRAPHICS_APPLICATION_PATH_INVALID");
      string markerFile=Path.Combine(root,".bridge-application.json");if(new FileInfo(markerFile).Length>65536)throw new Exception("GRAPHICS_APPLICATION_MARKER_INVALID");
      var marker=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(markerFile));
      if(Convert.ToString(marker["token"])!=runtimeToken||Convert.ToString(marker["profile"])!="unity-2017.2-reviewed-sheep"||Convert.ToString(marker["originalTree"])!="e09a40b06aafadf8e5d9603a5ca0884ce953b1ad550724044ef3a52e3b414d4a"||
        !SamePath(Convert.ToString(marker["sourceFile"]),sourceFile)||!SamePath(Convert.ToString(marker["sourceRoot"]),Path.GetDirectoryName(sourceFile)))throw new Exception("GRAPHICS_APPLICATION_MARKER_INVALID");
      ReviewedTree(Path.GetDirectoryName(sourceFile));
      if(FileHash(actual)!="ca6df88664e1f4088ec7632584ba9486eedec3e800d3fcc2c749a7d019440d64"||FileHash(Path.Combine(root,"UnityPlayer.dll"))!="30a16cbb616ffee4d430e948f484f5689379caccdd070bfb213efd629f581b60"||
        FileHash(Path.Combine(root,"sheep_Data","globalgamemanagers"))!="581fb0d10cfdccd925e7b7b43813ce98c1bc7a2b17c249279f9f9f5f2b3985f7"||
        FileHash(Path.Combine(root,"sheep_Data","Managed","Assembly-CSharp.dll"))!="4b342c65a75118fce25d4bfa143a7089e02a6dc0db11f2348ae4520d8d40fee5")throw new Exception("GRAPHICS_APPLICATION_COPY_CHANGED");
      IntPtr job=OpenJobObject(4,false,"Local\\CodexWallpaperBridge.Application."+session),targetProcess=OpenProcess(0x1000,false,pid);bool member;
      try {if(job==IntPtr.Zero||targetProcess==IntPtr.Zero||!IsProcessInJob(targetProcess,job,out member)||!member)throw new Exception("GRAPHICS_APPLICATION_JOB_INVALID");}
      finally {if(job!=IntPtr.Zero)CloseHandle(job);if(targetProcess!=IntPtr.Zero)CloseHandle(targetProcess);}
      string hook=Path.Combine(Path.GetDirectoryName(typeof(GraphicsCaptureBridge).Assembly.Location),"BridgeApplicationInputHook32.dll");
      return new GraphicsCaptureBridge(window,pid,runtimeToken,session,hook);
    }
    GraphicsCaptureBridge(IntPtr window,int pid,string privateToken,string applicationSession,string explicitHook) {
      Window=window;string name="Local\\CodexWallpaperBridge.Graphics."+Guid.NewGuid().ToString("N");
      try {
        map=MemoryMappedFile.CreateNew(name,256L+Capacity,MemoryMappedFileAccess.ReadWrite);view=map.CreateViewAccessor();
        view.Write(0,0x32425743);view.Write(4,pid);view.Write(8,window.ToInt64());view.Write(16,Process.GetCurrentProcess().Id);view.Write(28,15);view.Write(32,960);
        if(privateToken!=null){
          Guid parsed;if(!Guid.TryParseExact(privateToken,"D",out parsed))throw new Exception("GRAPHICS_PRIVATE_TOKEN_INVALID");
          // The caller must first validate the isolated surface proof. The DLL
          // independently checks the exact private executable and named Job.
          privatePointer=true;view.WriteArray(128,Encoding.ASCII.GetBytes(privateToken+"\0"),0,37);view.Write(84,applicationSession==null?0x31505743:0x32505743);
          if(applicationSession!=null)view.WriteArray(172,Encoding.ASCII.GetBytes(applicationSession+"\0"),0,37);
        }
        process=OpenProcess(0x0010043a,false,pid);if(process==IntPtr.Zero)throw new Exception("GRAPHICS_PROCESS_ACCESS_FAILED");
        string file=explicitHook??Path.Combine(Path.GetDirectoryName(Program.Executable),"BridgeGraphicsHook.dll");if(!File.Exists(file))throw new Exception("GRAPHICS_HOOK_NOT_INSTALLED");
        IntPtr remoteModule=IntPtr.Zero;
        using(var target=Process.GetProcessById(pid))foreach(ProcessModule module in target.Modules)
          if(String.Equals(module.FileName,file,StringComparison.OrdinalIgnoreCase)){remoteModule=module.BaseAddress;break;}
        uint loadResult=0;
        if(remoteModule==IntPtr.Zero) {
          IntPtr argument=RemoteString(file);IntPtr thread=Start(GetProcAddress(GetModuleHandle("kernel32.dll"),"LoadLibraryW"),argument);
          bool loaded=false;
          try {loaded=WaitForSingleObject(thread,5000)==0;if(!loaded)throw new Exception("GRAPHICS_LOAD_TIMEOUT");GetExitCodeThread(thread,out loadResult);}finally{CloseHandle(thread);if(loaded)VirtualFreeEx(process,argument,UIntPtr.Zero,0x8000);}
          using(var target=Process.GetProcessById(pid))foreach(ProcessModule module in target.Modules)
            if(String.Equals(module.FileName,file,StringComparison.OrdinalIgnoreCase)){remoteModule=module.BaseAddress;break;}
        }
        if(remoteModule==IntPtr.Zero)throw new Exception("GRAPHICS_LOAD_FAILED_"+loadResult.ToString("x8"));
        remoteBase=remoteModule;
        var local=LoadLibraryEx(file,IntPtr.Zero,1);if(local==IntPtr.Zero)throw new Exception("GRAPHICS_EXPORT_FAILED");
        IntPtr entry;
        try {var exported=GetProcAddress(local,"CwbStart");if(exported==IntPtr.Zero)throw new Exception("GRAPHICS_EXPORT_FAILED");entry=new IntPtr(remoteModule.ToInt64()+exported.ToInt64()-local.ToInt64());}finally{FreeLibrary(local);}
        IntPtr mappingArgument=RemoteString(name);remoteThread=Start(entry,mappingArgument);
        // The argument is consumed immediately by OpenFileMapping. Free it after readiness.
        try {for(int n=0;n<100 && view.ReadInt32(24)==0;n++)Thread.Sleep(50);
          if(view.ReadInt32(24)!=1 && view.ReadInt32(24)!=2)throw new Exception("GRAPHICS_INITIALIZATION_FAILED");}
        finally{if(view.ReadInt32(24)!=0 || WaitForSingleObject(remoteThread,0)==0)VirtualFreeEx(process,mappingArgument,UIntPtr.Zero,0x8000);}
      }catch{Dispose();throw;}
    }
    public void Pointer(double x,double y,bool click) {
      if(disposed||!privatePointer||view.ReadInt32(168)!=1)throw new Exception("GRAPHICS_PRIVATE_POINTER_UNAVAILABLE");
      if(Double.IsNaN(x)||Double.IsInfinity(x)||Double.IsNaN(y)||Double.IsInfinity(y)||x<0||x>1||y<0||y>1)throw new Exception("GRAPHICS_POINTER_INVALID");
      Native.Rect rect;if(!GetClientRect(Window,out rect)||rect.Right<1||rect.Bottom<1)throw new Exception("GRAPHICS_POINTER_WINDOW_INVALID");
      if(view.ReadInt32(84)==0x32505743){view.Write(224,rect.Right);view.Write(228,rect.Bottom);}
      int sequence=view.ReadInt32(88);view.Write(88,sequence+1);Thread.MemoryBarrier();
      view.Write(92,(int)Math.Round(x*(rect.Right-1)));view.Write(96,(int)Math.Round(y*(rect.Bottom-1)));view.Write(100,1);
      if(click)view.Write(112,(long)(GetTickCount64()+120));
      Thread.MemoryBarrier();view.Write(88,sequence+2);
    }
    IntPtr RemoteString(string value) {var bytes=Encoding.Unicode.GetBytes(value+"\0");var address=VirtualAllocEx(process,IntPtr.Zero,(UIntPtr)bytes.Length,0x3000,4);UIntPtr written;
      if(address==IntPtr.Zero || !WriteProcessMemory(process,address,bytes,(UIntPtr)bytes.Length,out written))throw new Exception("GRAPHICS_ARGUMENT_FAILED");return address;}
    IntPtr Start(IntPtr entry,IntPtr argument){uint id;var thread=CreateRemoteThread(process,IntPtr.Zero,UIntPtr.Zero,entry,argument,0,out id);if(thread==IntPtr.Zero)throw new Exception("GRAPHICS_THREAD_FAILED");return thread;}
    public Bitmap Next(int width,int fps) {
      view.Write(28,Math.Max(1,Math.Min(120,fps)));view.Write(32,width);
      var wait=Stopwatch.StartNew();
      while(wait.ElapsedMilliseconds<2000) {
        int before=view.ReadInt32(52);if(before==0 || (before&1)!=0){Thread.Sleep(1);continue;}
        int w=view.ReadInt32(36),h=view.ReadInt32(40),bytes=view.ReadInt32(48);
        Thread.MemoryBarrier();if(view.ReadInt32(52)!=before)continue;
        if(w<1 || h<1 || (long)w*h*4!=bytes || bytes>Capacity)throw new Exception("GRAPHICS_FRAME_INVALID");
        if(readBuffer==null || readBuffer.Length!=bytes)readBuffer=new byte[bytes];
        var pixels=readBuffer;bool held=false;
        try {
          view.SafeMemoryMappedViewHandle.DangerousAddRef(ref held);
          var address=new IntPtr(view.SafeMemoryMappedViewHandle.DangerousGetHandle().ToInt64()+view.PointerOffset+256);
          Marshal.Copy(address,pixels,0,bytes);
        } finally {if(held)view.SafeMemoryMappedViewHandle.DangerousRelease();}
        Thread.MemoryBarrier();
        if(view.ReadInt32(52)!=before)continue;
        if(before!=lastSequence){lastSequence=before;lastFrameAt=DateTime.UtcNow;}
        // Release exactly the snapshot we copied. The producer keeps at most
        // one unread frame, so a faster source cannot starve this read or build
        // a queue while JPEG encoding and multiple clients catch up.
        view.Write(80,before);
        IsPaused=(DateTime.UtcNow-lastFrameAt).TotalMilliseconds>1500;
        var bitmap=new Bitmap(w,h,PixelFormat.Format32bppRgb);var data=bitmap.LockBits(new Rectangle(0,0,w,h),ImageLockMode.WriteOnly,PixelFormat.Format32bppRgb);
        try{if(data.Stride==w*4)Marshal.Copy(pixels,0,data.Scan0,bytes);else for(int y=0;y<h;y++)Marshal.Copy(pixels,y*w*4,IntPtr.Add(data.Scan0,y*data.Stride),w*4);}finally{bitmap.UnlockBits(data);}return bitmap;
      }
      if(view.ReadInt32(72)==0){IsPaused=true;return null;}
      throw new Exception(view.ReadInt32(64)==10?"GRAPHICS_FORMAT_UNSUPPORTED_"+view.ReadInt32(76):"GRAPHICS_FRAME_TIMEOUT_PRESENT_"+view.ReadInt32(72));
    }
    public void Dispose(){if(disposed)return;disposed=true;if(view!=null)view.Write(20,1);
      bool complete=false;
      if(remoteThread!=IntPtr.Zero){complete=WaitForSingleObject(remoteThread,5000)==0;CloseHandle(remoteThread);remoteThread=IntPtr.Zero;}
      if(complete && view!=null && view.ReadInt32(24)!=0 && remoteBase!=IntPtr.Zero) {
        // The capture thread has disabled its detours and completed its rundown before exiting.
        try {var unload=Start(GetProcAddress(GetModuleHandle("kernel32.dll"),"FreeLibrary"),remoteBase);WaitForSingleObject(unload,5000);CloseHandle(unload);}catch { }
      }
      if(view!=null)view.Dispose();if(map!=null)map.Dispose();if(process!=IntPtr.Zero)CloseHandle(process);}
  }
}
