using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
// Test-only geometry helper. Operates solely on an explicitly identified official
// Codex PID; callers additionally fence it to their newly launched test instance.
static class CodexWindowProbe {
  delegate bool WindowVisitor(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")]static extern bool EnumWindows(WindowVisitor visitor,IntPtr parameter);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr window,StringBuilder name,int capacity);
  [DllImport("user32.dll",EntryPoint="GetWindowTextW",ExactSpelling=true,CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr window,StringBuilder name,int capacity);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
  [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out Rect rectangle);
  [DllImport("user32.dll")]static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr window,int mode);
  [DllImport("user32.dll",EntryPoint="PostMessageW",ExactSpelling=true,SetLastError=true)]static extern bool PostMessage(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
  [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")]static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")]static extern bool AttachThreadInput(uint source,uint target,bool attach);
  [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref int length);
  [StructLayout(LayoutKind.Sequential)]struct FileTime {public uint low,high;}
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr process,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct ProcessEntry {public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string executable;}
  [DllImport("kernel32.dll")]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32First(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32Next(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("user32.dll",ExactSpelling=true,SetLastError=true)]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll",ExactSpelling=true,SetLastError=true)]static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetUserObjectInformation(IntPtr desktop,int index,StringBuilder name,int capacity,out int needed);
  static string Quote(string value){return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n")+"\"";}
  static string DesktopState(out bool available){var desktop=OpenInputDesktop(0,false,1);int openError=desktop==IntPtr.Zero?Marshal.GetLastWin32Error():0;available=false;if(desktop==IntPtr.Zero)return "{\"interactiveDesktopAvailable\":false,\"openError\":"+openError+"}";try{int needed;var name=new StringBuilder(128);bool queried=GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed);int nameError=queried?0:Marshal.GetLastWin32Error();available=queried&&name.ToString()=="Default";return "{\"interactiveDesktopAvailable\":"+(available?"true":"false")+",\"name\":"+Quote(name.ToString())+",\"queried\":"+(queried?"true":"false")+",\"openError\":"+openError+",\"nameError\":"+nameError+",\"neededBytes\":"+needed+"}";}finally{CloseDesktop(desktop);}}
  static bool ActiveOrdinaryDesktop(){bool available;DesktopState(out available);return available;}
  sealed class OwnedProcess : IDisposable {
    public IntPtr handle;public uint pid;public long started;public string executable;public bool terminateAllowed=true;
    public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
  }
  static OwnedProcess OpenOwned(uint pid){
    var handle=OpenProcess(0x00101001,false,pid);if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)return null;throw new Exception("OWNED_PROCESS_OPEN_FAILED");}
    try{var name=new StringBuilder(32768);int length=name.Capacity;FileTime created,exited,kernel,user;
      if(!QueryFullProcessImageName(handle,0,name,ref length)||!GetProcessTimes(handle,out created,out exited,out kernel,out user))throw new Exception("OWNED_PROCESS_QUERY_FAILED");
      return new OwnedProcess{handle=handle,pid=pid,started=DateTime.FromFileTimeUtc(unchecked((long)(((ulong)created.high<<32)|created.low))).Ticks,executable=name.ToString()};
    }catch{CloseHandle(handle);throw;}
  }
  static int TerminateOwnedTree(uint pid,string expectedStart,string expectedFile){
    if(!Path.IsPathRooted(expectedFile)||!expectedFile.EndsWith(@"\app\ChatGPT.exe",StringComparison.OrdinalIgnoreCase)||expectedFile.IndexOf(@"\WindowsApps\OpenAI.Codex_",StringComparison.OrdinalIgnoreCase)<0)throw new Exception("OWNED_PROCESS_PATH_INVALID");
    var opened=new List<OwnedProcess>();var rows=new List<string>();var skipped=new List<string>();var observedOutside=new List<string>();
    try{
      var root=OpenOwned(pid);if(root==null){Console.WriteLine("{\"pid\":"+pid+",\"alreadyExited\":true}");return 0;}opened.Add(root);
      if(root.started.ToString()!=expectedStart||!String.Equals(Path.GetFullPath(root.executable),Path.GetFullPath(expectedFile),StringComparison.OrdinalIgnoreCase)) {
        Console.WriteLine("{\"code\":\"OWNED_PROCESS_IDENTITY_INVALID\",\"pid\":"+pid+",\"expected\":{\"nativeStarted\":"+Quote(expectedStart)+",\"nativeExecutable\":"+Quote(expectedFile)+"},\"actual\":{\"nativeStarted\":"+Quote(root.started.ToString())+",\"nativeExecutable\":"+Quote(root.executable)+"}}");
        throw new Exception("OWNED_PROCESS_IDENTITY_INVALID");
      }
      if(WaitForSingleObject(root.handle,0)!=258){Console.WriteLine("{\"pid\":"+pid+",\"alreadyExited\":true}");return 0;}
      var snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))throw new Exception("OWNED_PROCESS_SNAPSHOT_FAILED");
      var entries=new List<ProcessEntry>();
      try{var entry=new ProcessEntry{size=(uint)Marshal.SizeOf(typeof(ProcessEntry))};if(Process32First(snapshot,ref entry))do{entries.Add(entry);}while(entries.Count<8192&&Process32Next(snapshot,ref entry));}finally{CloseHandle(snapshot);}
      var byPid=new Dictionary<uint,OwnedProcess>();var rejected=new HashSet<uint>();byPid[root.pid]=root;string codeDirectory=Path.GetDirectoryName(Path.GetFullPath(expectedFile))+Path.DirectorySeparatorChar;
      for(int depth=0;depth<32;depth++){
        bool changed=false;
        foreach(var entry in entries){OwnedProcess parent;if(byPid.ContainsKey(entry.pid)||rejected.Contains(entry.pid)||!byPid.TryGetValue(entry.parent,out parent)||WaitForSingleObject(root.handle,0)!=258||WaitForSingleObject(parent.handle,0)!=258)continue;
          OwnedProcess child;
          try{child=OpenOwned(entry.pid);}catch(Exception error){rejected.Add(entry.pid);skipped.Add("{\"pid\":"+entry.pid+",\"parentPid\":"+entry.parent+",\"reason\":\"identity-unavailable\",\"error\":"+Quote(error.Message)+"}");continue;}
          if(child==null)continue;
          // Parent IDs can survive their original process. Creation ordering,
          // held parent handles and the exact owned package directory fence them.
          if(child.started<parent.started){
            rejected.Add(child.pid);skipped.Add("{\"pid\":"+child.pid+",\"parentPid\":"+entry.parent+",\"started\":"+Quote(child.started.ToString())+",\"executable\":"+Quote(child.executable)+",\"parentStarted\":"+Quote(parent.started.ToString())+",\"parentExecutable\":"+Quote(parent.executable)+",\"expectedDirectory\":"+Quote(codeDirectory)+",\"creationOrdered\":"+(child.started>=parent.started?"true":"false")+",\"reason\":\"outside-owned-identity\"}");child.Dispose();continue;
          }
          // Runtime helpers can live outside the MSIX package. They never gain
          // termination authority: retain the exact handle and audit natural
          // exit after the package root closes, including their descendants.
          child.terminateAllowed=parent.terminateAllowed&&Path.GetFullPath(child.executable).StartsWith(codeDirectory,StringComparison.OrdinalIgnoreCase);
          if(!child.terminateAllowed)observedOutside.Add("{\"pid\":"+child.pid+",\"parentPid\":"+entry.parent+",\"started\":"+Quote(child.started.ToString())+",\"executable\":"+Quote(child.executable)+",\"parentStarted\":"+Quote(parent.started.ToString())+",\"parentExecutable\":"+Quote(parent.executable)+",\"action\":\"observe-natural-exit-only\"}");
          opened.Add(child);byPid[child.pid]=child;changed=true;
        }
        if(!changed)break;
      }
      bool failed=skipped.Count>0;
      for(int index=opened.Count-1;index>=0;index--){var process=opened[index];bool exited=WaitForSingleObject(process.handle,0)!=258;
        if(!process.terminateAllowed)continue;
        if(!exited){if(!TerminateProcess(process.handle,1)&&WaitForSingleObject(process.handle,0)==258)failed=true;exited=WaitForSingleObject(process.handle,1500)!=258;}
        rows.Add("{\"pid\":"+process.pid+",\"started\":\""+process.started+"\",\"executable\":"+Quote(process.executable)+",\"action\":\"package-terminate\",\"exited\":"+(exited?"true":"false")+"}");if(!exited)failed=true;
      }
      var naturalExitDeadline=DateTime.UtcNow.AddSeconds(6);
      foreach(var process in opened){if(process.terminateAllowed)continue;uint remaining=(uint)Math.Max(0,(naturalExitDeadline-DateTime.UtcNow).TotalMilliseconds);
        bool exited=WaitForSingleObject(process.handle,remaining)!=258;
        rows.Add("{\"pid\":"+process.pid+",\"started\":\""+process.started+"\",\"executable\":"+Quote(process.executable)+",\"action\":\"observe-natural-exit-only\",\"exited\":"+(exited?"true":"false")+"}");if(!exited)failed=true;
      }
      Console.WriteLine("{\"pid\":"+pid+",\"identityVerified\":true,\"processes\":["+String.Join(",",rows.ToArray())+"],\"observedOutside\":["+String.Join(",",observedOutside.ToArray())+"],\"skipped\":["+String.Join(",",skipped.ToArray())+"]}");return failed?8:0;
    }finally{foreach(var process in opened)process.Dispose();}
  }
  [StructLayout(LayoutKind.Sequential)]struct Point {public int x,y;}
  [StructLayout(LayoutKind.Sequential)]struct Rect {public int left,top,right,bottom;}
  [StructLayout(LayoutKind.Sequential)]struct Placement {public int size,flags,show;public Point min,max;public Rect normal;}
  [DllImport("user32.dll")]static extern bool GetWindowPlacement(IntPtr window,ref Placement placement);
  [DllImport("user32.dll")]static extern bool IsIconic(IntPtr window);
  static int Main(string[] args) {
    SetProcessDPIAware();
    if(args.Length==1&&args[0]=="--desktop-state"){bool available;Console.WriteLine(DesktopState(out available));return 0;}
    if(args.Length==4&&args[1]=="--owned-terminate-tree"){
      try{return TerminateOwnedTree(UInt32.Parse(args[0]),args[2],args[3]);}catch(Exception failure){Console.Error.WriteLine(failure.Message);return 7;}
    }
    // Explicitly selected HWNDs are tied to the fresh process start time. This
    // avoids accidentally showing/minimizing Electron's hidden preload shell.
    IntPtr selectedWindow=IntPtr.Zero;string expectedStart=null;
    if(args.Length>=5&&args[1]=="--owned-window"){
      selectedWindow=new IntPtr(Int64.Parse(args[2]));expectedStart=args[3];var action=new string[args.Length-3];action[0]=args[0];Array.Copy(args,4,action,1,args.Length-4);args=action;
    }
    bool stampOnly=args.Length==2&&args[1]=="--owned-stamp";
    bool windowsOnly=args.Length==3&&args[1]=="--owned-windows";
    bool titleOnly=args.Length==4&&args[1]=="--find-owned-title";
    bool showOwnedAll=args.Length==7&&args[1]=="--show-owned-all";
    bool focusOwned=args.Length==4&&args[1]=="--focus-owned";
    bool focusOnly=(args.Length==2&&args[1]=="--focus")||focusOwned;
    bool visibleOnly=args.Length==2&&args[1]=="--visible";
    bool stateOnly=args.Length==2&&args[1]=="--state",minimize=args.Length==2&&args[1]=="--minimize",maximize=args.Length==2&&args[1]=="--maximize",restore=args.Length==5&&args[1]=="--restore";
    if(args.Length!=5&&!focusOnly&&!visibleOnly&&!stateOnly&&!minimize&&!maximize&&!stampOnly&&!showOwnedAll&&!windowsOnly&&!titleOnly)return 2;int pid=Int32.Parse(args[0]),x=0,y=0,width=0,height=0;
    if(!focusOnly&&!visibleOnly&&!stateOnly&&!minimize&&!maximize&&!restore&&!stampOnly&&!windowsOnly&&!titleOnly){int offset=showOwnedAll?2:1;x=Int32.Parse(args[offset]);y=Int32.Parse(args[offset+1]);width=Int32.Parse(args[offset+2]);height=Int32.Parse(args[offset+3]);
      if(width<400||width>8192||height<300||height>8192||x<0||y<0)return 2;}
    using(var process=Process.GetProcessById(pid)) {
      string file=process.MainModule.FileName;
      if(!file.EndsWith(@"\app\ChatGPT.exe",StringComparison.OrdinalIgnoreCase)||file.IndexOf(@"\WindowsApps\OpenAI.Codex_",StringComparison.OrdinalIgnoreCase)<0)return 3;
      string started=process.StartTime.ToUniversalTime().Ticks.ToString();
      if(expectedStart!=null&&started!=expectedStart)return 7;
      if(stampOnly){using(var native=OpenOwned((uint)pid)){
        if(native==null||WaitForSingleObject(native.handle,0)!=258)throw new Exception("OWNED_PROCESS_EXITED");
        // Window commands use the managed stamp above. Tree cleanup must use
        // the native stamp recorded now, never refreshed at termination time.
        Console.WriteLine("{\"pid\":"+pid+",\"started\":\""+started+"\",\"executable\":"+Quote(file)+",\"nativeStarted\":"+Quote(native.started.ToString())+",\"nativeExecutable\":"+Quote(native.executable)+"}");return 0;
      }}
      if(windowsOnly||titleOnly){
        if(started!=args[titleOnly?3:2])return 7;var rows=new List<string>();int matched=0;
        EnumWindows(delegate(IntPtr candidate,IntPtr parameter){uint candidateOwner;GetWindowThreadProcessId(candidate,out candidateOwner);if(candidateOwner!=pid)return true;
          var name=new StringBuilder(256);GetClassName(candidate,name,name.Capacity);if(name.ToString()!="Chrome_WidgetWin_1")return true;
          if(titleOnly){var title=new StringBuilder(1024);GetWindowText(candidate,title,title.Capacity);if(title.ToString()!=args[2])return true;matched++;}
          Rect bounds,client;GetWindowRect(candidate,out bounds);GetClientRect(candidate,out client);rows.Add("{\"hwnd\":\""+candidate.ToInt64()+"\",\"visible\":"+(IsWindowVisible(candidate)?"true":"false")+",\"iconic\":"+(IsIconic(candidate)?"true":"false")+",\"x\":"+bounds.left+",\"y\":"+bounds.top+",\"width\":"+(bounds.right-bounds.left)+",\"height\":"+(bounds.bottom-bounds.top)+",\"clientWidth\":"+(client.right-client.left)+",\"clientHeight\":"+(client.bottom-client.top)+"}");return true;
        },IntPtr.Zero);
        Console.WriteLine("{\"pid\":"+pid+",\"started\":\""+started+"\",\"windows\":["+String.Join(",",rows.ToArray())+"]}");return titleOnly&&matched!=1?4:0;
      }
      // Never manipulate a window while a secure or screen-saver desktop is
      // active. Read-only diagnostics above remain available for attribution.
      if(!stateOnly&&!ActiveOrdinaryDesktop()){bool available;Console.WriteLine(DesktopState(out available));return 6;}
      if(showOwnedAll){
        if(started!=args[6])return 7;SetProcessDPIAware();int failed=0;var ownedWindows=new List<IntPtr>();
        EnumWindows(delegate(IntPtr candidate,IntPtr parameter){uint candidateOwner;GetWindowThreadProcessId(candidate,out candidateOwner);if(candidateOwner==pid){
          var name=new StringBuilder(256);GetClassName(candidate,name,name.Capacity);if(name.ToString()=="Chrome_WidgetWin_1"){
            ownedWindows.Add(candidate);
          }}return true;},IntPtr.Zero);
        int count=ownedWindows.Count,cellWidth=Math.Max(400,width/Math.Max(1,count));
        for(int index=0;index<count;index++){ShowWindow(ownedWindows[index],9);if(!SetWindowPos(ownedWindows[index],new IntPtr(-1),x+index*cellWidth,y,cellWidth,height,0x0050))failed++;}
        var handles=new List<string>();foreach(var ownedWindow in ownedWindows)handles.Add("\""+ownedWindow.ToInt64()+"\"");
        Console.WriteLine("{\"pid\":"+pid+",\"started\":\""+started+"\",\"shown\":"+count+",\"handles\":["+String.Join(",",handles.ToArray())+"],\"cellWidth\":"+cellWidth+",\"failed\":"+failed+"}");return count>0&&failed==0?0:4;
      }
      IntPtr window=selectedWindow!=IntPtr.Zero?selectedWindow:restore?new IntPtr(Int64.Parse(args[3])):focusOwned?new IntPtr(Int64.Parse(args[2])):process.MainWindowHandle;
      if(selectedWindow!=IntPtr.Zero){var selectedClass=new StringBuilder(256);GetClassName(window,selectedClass,selectedClass.Capacity);if(selectedClass.ToString()!="Chrome_WidgetWin_1")return 7;}
      if(focusOwned){var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);if(started!=args[3]||name.ToString()!="Chrome_WidgetWin_1")return 7;}
      // windowsHide on the test launcher can consume Electron's initial ShowWindow.
      // .NET MainWindowHandle ignores hidden windows. Recover only the unique
      // native shell of this explicitly owned PID, never another Codex instance.
      if(window==IntPtr.Zero&&!restore){int count=0;EnumWindows(delegate(IntPtr candidate,IntPtr parameter){uint candidateOwner;GetWindowThreadProcessId(candidate,out candidateOwner);
        if(candidateOwner==pid){var name=new StringBuilder(256);GetClassName(candidate,name,name.Capacity);if(name.ToString()=="Chrome_WidgetWin_1"){window=candidate;count++;}}return true;},IntPtr.Zero);if(count!=1){Console.WriteLine("{\"code\":\"OWNED_WINDOW_COUNT\",\"count\":"+count+"}");return 4;}}
      uint owner;GetWindowThreadProcessId(window,out owner);if(window==IntPtr.Zero||owner!=pid){Console.WriteLine("{\"code\":\"OWNED_WINDOW_OWNER\",\"pid\":"+pid+",\"owner\":"+owner+",\"hwnd\":\""+window.ToInt64()+"\"}");return 4;}
      if(restore){if(started!=args[4])return 7;int mode=Int32.Parse(args[2]);if(mode!=1&&mode!=3&&mode!=9)return 7;if(IsIconic(window))ShowWindow(window,mode);return 0;}
      if(maximize){if(selectedWindow==IntPtr.Zero||expectedStart==null||!ActiveOrdinaryDesktop())return 7;return PostMessage(window,0x0112,new IntPtr(0xF030),IntPtr.Zero)?0:5;}
      if(stateOnly||minimize){SetProcessDPIAware();var placement=new Placement{size=Marshal.SizeOf(typeof(Placement))};Rect bounds,client;if(!GetWindowPlacement(window,ref placement)||!GetWindowRect(window,out bounds)||!GetClientRect(window,out client))return 6;
        Console.WriteLine("{\"pid\":"+pid+",\"hwnd\":\""+window.ToInt64()+"\",\"started\":\""+started+"\",\"show\":"+placement.show+",\"width\":"+(bounds.right-bounds.left)+",\"height\":"+(bounds.bottom-bounds.top)+",\"clientWidth\":"+(client.right-client.left)+",\"clientHeight\":"+(client.bottom-client.top)+"}");if(minimize)ShowWindow(window,6);return 0;}
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
