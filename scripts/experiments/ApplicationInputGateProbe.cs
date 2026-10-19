using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
public static class ApplicationInputGateProbe {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr LoadLibrary(string file);
  [DllImport("kernel32.dll",CharSet=CharSet.Ansi)]static extern IntPtr GetProcAddress(IntPtr module,string name);
  [DllImport("kernel32.dll")]static extern bool FreeLibrary(IntPtr module);
  [UnmanagedFunctionPointer(CallingConvention.StdCall,CharSet=CharSet.Unicode)]delegate uint Start([MarshalAs(UnmanagedType.LPWStr)]string mapping);
  [STAThread]public static int Main(string[] args) {
    string token=Guid.NewGuid().ToString("D"),session=Guid.NewGuid().ToString("D");int pid=Process.GetCurrentProcess().Id;
    using(var window=new Form{Location=new Point(-10000,-10000),Size=new Size(96,96),ShowInTaskbar=false}) {
      var hwnd=window.Handle;var type=Assembly.LoadFrom(args[0]).GetType("CodexWallpaperBridge.GraphicsCaptureBridge",true);string factoryFailure=null;
      try{var unexpected=type.GetMethod("CreateReviewedApplication",BindingFlags.Static|BindingFlags.Public).Invoke(null,new object[]{hwnd,pid,token,session,typeof(ApplicationInputGateProbe).Assembly.Location});if(unexpected!=null)((IDisposable)unexpected).Dispose();}
      catch(TargetInvocationException failure){factoryFailure=failure.InnerException.Message;}
      if(factoryFailure!="GRAPHICS_APPLICATION_PATH_INVALID")throw new Exception("Unreviewed App factory was not rejected: "+factoryFailure);
      IntPtr module=LoadLibrary(args[1]);if(module==IntPtr.Zero)throw new Exception("Gate DLL load failed");
      try {
        var start=(Start)Marshal.GetDelegateForFunctionPointer(GetProcAddress(module,"CwbStart"),typeof(Start));
        var rows=new System.Collections.Generic.List<object>();
        foreach(int profile in new[]{0x31505743,0x32505743}) {
          string name="Local\\CodexWallpaperBridge.Graphics.GateTest."+Guid.NewGuid().ToString("N");
          using(var map=MemoryMappedFile.CreateNew(name,256L+64*1024*1024))using(var view=map.CreateViewAccessor()) {
            view.Write(0,0x32425743);view.Write(4,pid);view.Write(8,hwnd.ToInt64());view.Write(16,pid);view.Write(28,15);view.Write(32,320);view.Write(84,profile);
            var bytes=Encoding.ASCII.GetBytes(token+"\0");view.WriteArray(128,bytes,0,bytes.Length);bytes=Encoding.ASCII.GetBytes(session+"\0");view.WriteArray(172,bytes,0,bytes.Length);
            uint code=start(name);int enabled=view.ReadInt32(168),status=view.ReadInt32(24);
            if(enabled!=2||status!=3)throw new Exception("Native unknown-process gate failed, profile="+profile+", enabled="+enabled+", status="+status);
            rows.Add(new{profile,enabled,status,code});
          }
        }
        var result=new{success=true,factoryFailure,nativeRejections=rows,scope="Authored unknown x86 fixture, own HWND/process only; neither Scene nor reviewed App private input gate may enable."};
        string json=new JavaScriptSerializer().Serialize(result);File.WriteAllText(args[2],json);Console.WriteLine(json);
      }finally{FreeLibrary(module);}
    }
    return 0;
  }
}
