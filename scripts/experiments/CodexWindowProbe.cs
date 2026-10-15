using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
// Test-only geometry helper. Operates solely on an explicitly identified official
// Codex PID; callers additionally fence it to their newly launched test instance.
static class CodexWindowProbe {
  [DllImport("user32.dll")]static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr window,int mode);
  [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")]static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")]static extern bool AttachThreadInput(uint source,uint target,bool attach);
  [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr desktop,int index,StringBuilder name,int capacity,out int needed);
  static bool ActiveOrdinaryDesktop(){var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;try{int needed;var name=new StringBuilder(128);return GetUserObjectInformation(desktop,2,name,256,out needed)&&name.ToString()=="Default";}finally{CloseDesktop(desktop);}}
  [StructLayout(LayoutKind.Sequential)]struct Point {public int x,y;}
  [StructLayout(LayoutKind.Sequential)]struct Rect {public int left,top,right,bottom;}
  [StructLayout(LayoutKind.Sequential)]struct Placement {public int size,flags,show;public Point min,max;public Rect normal;}
  [DllImport("user32.dll")]static extern bool GetWindowPlacement(IntPtr window,ref Placement placement);
  [DllImport("user32.dll")]static extern bool IsIconic(IntPtr window);
  static int Main(string[] args) {
    bool focusOnly=args.Length==2&&args[1]=="--focus";
    bool visibleOnly=args.Length==2&&args[1]=="--visible";
    bool stateOnly=args.Length==2&&args[1]=="--state",minimize=args.Length==2&&args[1]=="--minimize",restore=args.Length==5&&args[1]=="--restore";
    if(args.Length!=5&&!focusOnly&&!visibleOnly&&!stateOnly&&!minimize)return 2;int pid=Int32.Parse(args[0]),x=0,y=0,width=0,height=0;
    if(!focusOnly&&!visibleOnly&&!stateOnly&&!minimize&&!restore){x=Int32.Parse(args[1]);y=Int32.Parse(args[2]);width=Int32.Parse(args[3]);height=Int32.Parse(args[4]);
      if(width<400||width>8192||height<300||height>8192||x<0||y<0)return 2;}
    using(var process=Process.GetProcessById(pid)) {
      string file=process.MainModule.FileName;
      if(!file.EndsWith(@"\app\ChatGPT.exe",StringComparison.OrdinalIgnoreCase)||file.IndexOf(@"\WindowsApps\OpenAI.Codex_",StringComparison.OrdinalIgnoreCase)<0)return 3;
      IntPtr window=restore?new IntPtr(Int64.Parse(args[3])):process.MainWindowHandle;uint owner;GetWindowThreadProcessId(window,out owner);if(window==IntPtr.Zero||owner!=pid)return 4;
      string started=process.StartTime.ToUniversalTime().Ticks.ToString();
      if(restore){if(started!=args[4])return 7;int mode=Int32.Parse(args[2]);if(mode!=1&&mode!=3&&mode!=9)return 7;if(IsIconic(window))ShowWindow(window,mode);return 0;}
      if(stateOnly||minimize){var placement=new Placement{size=Marshal.SizeOf(typeof(Placement))};if(!GetWindowPlacement(window,ref placement))return 6;
        Console.WriteLine("{\"pid\":"+pid+",\"hwnd\":\""+window.ToInt64()+"\",\"started\":\""+started+"\",\"show\":"+placement.show+"}");if(minimize)ShowWindow(window,6);return 0;}
      if(visibleOnly){if(!ActiveOrdinaryDesktop())return 6;ShowWindow(window,4);return SetWindowPos(window,new IntPtr(-1),0,0,0,0,0x0013)?0:5;}
      SetProcessDPIAware();ShowWindow(window,9);
      if(!focusOnly&&!SetWindowPos(window,IntPtr.Zero,x,y,width,height,0x0040))return 5;
      if(focusOnly){
        var foreground=GetForegroundWindow();if(foreground==IntPtr.Zero)return 6;
        uint ignored;uint current=GetCurrentThreadId(),front=GetWindowThreadProcessId(foreground,out ignored),target=GetWindowThreadProcessId(window,out ignored);
        bool joinedFront=false,joinedTarget=false;
        try{if(front!=current)joinedFront=AttachThreadInput(current,front,true);if(target!=current&&target!=front)joinedTarget=AttachThreadInput(current,target,true);
          BringWindowToTop(window);SetForegroundWindow(window);
        }finally{if(joinedTarget)AttachThreadInput(current,target,false);if(joinedFront)AttachThreadInput(current,front,false);}
        GetWindowThreadProcessId(GetForegroundWindow(),out owner);if(owner!=pid)return 8;
      }
      return 0;
    }
  }
}
