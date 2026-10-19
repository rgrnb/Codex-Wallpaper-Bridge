using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Collections.Generic;
public static class ApplicationDpiCaptureProbe {
  [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
  [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
  [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]static extern bool GetPhysicalCursorPos(out Point point);
  [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")]static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")]static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")]static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")]static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll")]static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  public static int Main(string[] args) {
    if(args.Length==1&&args[0]=="--input-state") {Point point;if(!GetPhysicalCursorPos(out point))throw new Exception("Physical cursor observation unavailable");Console.WriteLine(new JavaScriptSerializer().Serialize(new{foreground=GetForegroundWindow().ToInt64().ToString(),cursor=point}));return 0;}
    int pid=Int32.Parse(args[0]);long created=Int64.Parse(args[1]);string executable=Path.GetFullPath(args[2]),session=args[3],output=Path.GetFullPath(args[5]);
    IntPtr window=new IntPtr(Int64.Parse(args[4])),job=OpenJobObject(4,false,"Local\\CodexWallpaperBridge.Application."+session);
    try {using(var process=Process.GetProcessById(pid)) {
      bool member;uint owner;GetWindowThreadProcessId(window,out owner);
      if(job==IntPtr.Zero||!IsProcessInJob(process.Handle,job,out member)||!member||owner!=pid||process.StartTime.ToUniversalTime().Ticks!=created||!String.Equals(process.MainModule.FileName,executable,StringComparison.OrdinalIgnoreCase))throw new Exception("Owned App identity mismatch");
      Directory.CreateDirectory(output);var rows=new List<object>();IntPtr target=GetWindowDpiAwarenessContext(window);
      foreach(var entry in new[]{new{label="initial",context=GetThreadDpiAwarenessContext()},new{label="unaware",context=new IntPtr(-1)},new{label="system",context=new IntPtr(-2)},new{label="pm",context=new IntPtr(-3)},new{label="pmv2",context=new IntPtr(-4)},new{label="target",context=target}}) {
        var previous=SetThreadDpiAwarenessContext(entry.context);
        try {
          Rect client,bounds;if(!GetClientRect(window,out client)||!GetWindowRect(window,out bounds)||client.right<1||client.bottom<1||(long)client.right*client.bottom>16777216)throw new Exception("Invalid owned App rectangle");
          bool printed;long visible=0;
          using(var bitmap=new Bitmap(client.right,client.bottom,PixelFormat.Format32bppRgb)) {
            using(var graphics=Graphics.FromImage(bitmap)){var dc=graphics.GetHdc();try{printed=PrintWindow(window,dc,3);}finally{graphics.ReleaseHdc(dc);}}
            for(int y=0;y<bitmap.Height;y+=8)for(int x=0;x<bitmap.Width;x+=8){var pixel=bitmap.GetPixel(x,y);if(pixel.R>8||pixel.G>8||pixel.B>8)visible++;}
            bitmap.Save(Path.Combine(output,entry.label+".png"),ImageFormat.Png);
          }
          rows.Add(new{entry.label,context=GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()),targetContext=GetAwarenessFromDpiAwarenessContext(target),dpi=GetDpiForWindow(window),clientWidth=client.right,clientHeight=client.bottom,bounds,printed,visibleSamples=visible});
        }finally{if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
      }
      string json=new JavaScriptSerializer().Serialize(rows);File.WriteAllText(Path.Combine(output,"result.json"),json);Console.WriteLine(json);
    }}finally{if(job!=IntPtr.Zero)CloseHandle(job);}
    return 0;
  }
}
