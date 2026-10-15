using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace CodexWallpaperBridge {
  // Exact-HWND D3D11 presentation capture. No audio APIs, monitor capture, or source asset writes.
  internal sealed class GraphicsCaptureBridge : IDisposable {
    const int Capacity = 64 * 1024 * 1024;
    readonly MemoryMappedFile map; readonly MemoryMappedViewAccessor view;
    readonly IntPtr process; IntPtr remoteThread, remoteBase; bool disposed;
    public IntPtr Window { get; private set; }
    public bool IsPaused { get; private set; }
    public int Sequence { get { return view.ReadInt32(52); } }
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
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    public GraphicsCaptureBridge(IntPtr window,int pid) {
      Window=window;string name="Local\\CodexWallpaperBridge.Graphics."+Guid.NewGuid().ToString("N");
      try {
        map=MemoryMappedFile.CreateNew(name,256L+Capacity,MemoryMappedFileAccess.ReadWrite);view=map.CreateViewAccessor();
        view.Write(0,0x31425743);view.Write(4,pid);view.Write(8,window.ToInt64());view.Write(16,Process.GetCurrentProcess().Id);view.Write(28,15);view.Write(32,960);
        process=OpenProcess(0x0010043a,false,pid);if(process==IntPtr.Zero)throw new Exception("GRAPHICS_PROCESS_ACCESS_FAILED");
        string file=Path.Combine(Path.GetDirectoryName(Program.Executable),"BridgeGraphicsHook.dll");if(!File.Exists(file))throw new Exception("GRAPHICS_HOOK_NOT_INSTALLED");
        IntPtr remoteModule=IntPtr.Zero;
        using(var target=Process.GetProcessById(pid))foreach(ProcessModule module in target.Modules)
          if(String.Equals(module.FileName,file,StringComparison.OrdinalIgnoreCase)){remoteModule=module.BaseAddress;break;}
        if(remoteModule==IntPtr.Zero) {
          IntPtr argument=RemoteString(file);IntPtr thread=Start(GetProcAddress(GetModuleHandle("kernel32.dll"),"LoadLibraryW"),argument);
          bool loaded=false;
          try {loaded=WaitForSingleObject(thread,5000)==0;if(!loaded)throw new Exception("GRAPHICS_LOAD_TIMEOUT");}finally{CloseHandle(thread);if(loaded)VirtualFreeEx(process,argument,UIntPtr.Zero,0x8000);}
          using(var target=Process.GetProcessById(pid))foreach(ProcessModule module in target.Modules)
            if(String.Equals(module.FileName,file,StringComparison.OrdinalIgnoreCase)){remoteModule=module.BaseAddress;break;}
        }
        if(remoteModule==IntPtr.Zero)throw new Exception("GRAPHICS_LOAD_FAILED");
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
    IntPtr RemoteString(string value) {var bytes=Encoding.Unicode.GetBytes(value+"\0");var address=VirtualAllocEx(process,IntPtr.Zero,(UIntPtr)bytes.Length,0x3000,4);UIntPtr written;
      if(address==IntPtr.Zero || !WriteProcessMemory(process,address,bytes,(UIntPtr)bytes.Length,out written))throw new Exception("GRAPHICS_ARGUMENT_FAILED");return address;}
    IntPtr Start(IntPtr entry,IntPtr argument){uint id;var thread=CreateRemoteThread(process,IntPtr.Zero,UIntPtr.Zero,entry,argument,0,out id);if(thread==IntPtr.Zero)throw new Exception("GRAPHICS_THREAD_FAILED");return thread;}
    public Bitmap Next(int width,int fps) {
      view.Write(28,Math.Max(1,Math.Min(60,fps)));view.Write(32,width);
      for(int attempt=0;attempt<80;attempt++) {
        int before=view.ReadInt32(52);if(before==0 || (before&1)!=0){Thread.Sleep(25);continue;}
        int w=view.ReadInt32(36),h=view.ReadInt32(40),bytes=view.ReadInt32(48);
        if(w<1 || h<1 || (long)w*h*4!=bytes || bytes>Capacity)throw new Exception("GRAPHICS_FRAME_INVALID");
        var pixels=new byte[bytes];view.ReadArray(256,pixels,0,bytes);Thread.MemoryBarrier();
        if(view.ReadInt32(52)!=before)continue;
        if(before!=lastSequence){lastSequence=before;lastFrameAt=DateTime.UtcNow;}
        IsPaused=(DateTime.UtcNow-lastFrameAt).TotalMilliseconds>1500;
        var bitmap=new Bitmap(w,h,PixelFormat.Format32bppRgb);var data=bitmap.LockBits(new Rectangle(0,0,w,h),ImageLockMode.WriteOnly,PixelFormat.Format32bppRgb);
        try{for(int y=0;y<h;y++)Marshal.Copy(pixels,y*w*4,IntPtr.Add(data.Scan0,y*data.Stride),w*4);}finally{bitmap.UnlockBits(data);}return bitmap;
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
