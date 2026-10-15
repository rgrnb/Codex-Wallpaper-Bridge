using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace CodexWallpaperBridge {
  // WE writes getWallpaper to CONOUT$, not its redirected stdout. ConPTY has no visible window.
  static class WeConsole {
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
      public int cb; public string reserved, desktop, title; public int x, y, cx, cy, charsX, charsY, fill, flags;
      public short show, reservedSize; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr security, int size);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool ReadFile(IntPtr handle, byte[] data, int size, out int read, IntPtr overlapped);
    public static int StartCodex(string executable,string profile,int port) {
      if(!Native.CodexPath(executable) || port<1024 || port>65535)throw new Exception("CODEX_LAUNCH_ARGUMENT_INVALID");
      string configured=Environment.GetEnvironmentVariable("BRIDGE_DATA_DIR");
      string data=BridgeShared.KnownPaths.Directory(String.IsNullOrEmpty(configured)?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexWallpaperBridge"):configured);
      if(!String.Equals(Path.GetFullPath(profile),Path.Combine(data,"codex-profile"),StringComparison.OrdinalIgnoreCase))throw new Exception("CODEX_PROFILE_INVALID");
      Directory.CreateDirectory(profile);
      var names=new[]{"SystemRoot","WINDIR","TEMP","TMP","LOCALAPPDATA","APPDATA","USERPROFILE","ProgramFiles","ProgramFiles(x86)","ProgramW6432","PATH","PATHEXT","COMSPEC","SYSTEMDRIVE","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","USERNAME","USERDOMAIN","HOMEDRIVE","HOMEPATH","OS"};
      Array.Sort(names,StringComparer.OrdinalIgnoreCase);var environment=new StringBuilder();
      foreach(string name in names){string value=Environment.GetEnvironmentVariable(name);if(value!=null)environment.Append(name).Append('=').Append(value).Append('\0');}
      environment.Append('\0');IntPtr block=Marshal.StringToHGlobalUni(environment.ToString());
      try {
        var startup=new StartupEx{startup=new Startup{cb=Marshal.SizeOf(typeof(Startup))}};ProcessInfo process;
        var command=new StringBuilder("\""+executable+"\" --remote-debugging-address=127.0.0.1 --remote-debugging-port="+port+" \"--user-data-dir="+profile+"\"");
        // This is an interactive official app, independent of Bridge's helper kill job.
        if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x01000600,block,Path.GetDirectoryName(executable),ref startup,out process))throw new Exception("CODEX_BREAKAWAY_LAUNCH_FAILED");
        CloseHandle(process.thread);CloseHandle(process.process);return (int)process.pid;
      }finally{Marshal.FreeHGlobal(block);}
    }
    public static void StartUpdate(string job) {
      string root=BridgeShared.KnownPaths.Directory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexWallpaperBridge","updates"));
      if(!String.Equals(Path.GetDirectoryName(Path.GetFullPath(job)),root,StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(Path.GetFileName(job),"^job-[a-f0-9]{32}\\.json$"))throw new Exception("UPDATE_JOB_INVALID");
      string node=Path.Combine(root,"worker-node.exe"), script=Path.Combine(root,"update-worker.mjs");
      if(!File.Exists(job)||!File.Exists(node)||!File.Exists(script))throw new Exception("UPDATE_WORKER_MISSING");
      Environment.SetEnvironmentVariable("BRIDGE_CONTROL_TOKEN",null);Environment.SetEnvironmentVariable("BRIDGE_PARENT_PID",null);
      var startup=new StartupEx{startup=new Startup{cb=Marshal.SizeOf(typeof(Startup))}};ProcessInfo process;
      if(!CreateProcess(node,new StringBuilder("\""+node+"\" \""+script+"\" \""+job+"\""),IntPtr.Zero,IntPtr.Zero,false,0x09000200,IntPtr.Zero,root,ref startup,out process))throw new Exception("UPDATE_BREAKAWAY_FAILED");
      CloseHandle(process.thread);CloseHandle(process.process);
    }
    public static string Current(string executable, int monitor) {
      if (!File.Exists(executable) || !Regex.IsMatch(Path.GetFileName(executable), "^wallpaper(32|64)\\.exe$", RegexOptions.IgnoreCase) || monitor < 0 || monitor > 31) throw new Exception("WE_QUERY_ARGUMENT_INVALID");
      IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, console = IntPtr.Zero, list = IntPtr.Zero;
      ProcessInfo process = new ProcessInfo(); Task<string> reader = null;
      try {
        if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0) || !CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) throw new Exception("WE_QUERY_PIPE_FAILED");
        Marshal.ThrowExceptionForHR(CreatePseudoConsole(new Coord { X = 4096, Y = 4 }, inputRead, outputWrite, 0, out console));
        CloseHandle(inputRead); inputRead = IntPtr.Zero; CloseHandle(outputWrite); outputWrite = IntPtr.Zero;
        var output = outputRead;
        reader = Task.Run(delegate { var bytes = new byte[4096]; int count; using (var memory = new MemoryStream()) {
          while (ReadFile(output, bytes, bytes.Length, out count, IntPtr.Zero) && count > 0) {
            if (memory.Length + count <= 32768) memory.Write(bytes, 0, count);
          } return Encoding.UTF8.GetString(memory.ToArray());
        } });
        IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size); list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref size) || !UpdateProcThreadAttribute(list, 0, new IntPtr(0x20016), console, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Exception("WE_QUERY_ATTRIBUTES_FAILED");
        var startup = new StartupEx { startup = new Startup { cb = Marshal.SizeOf(typeof(StartupEx)) }, attributes = list };
        // The WE control executable attaches to its parent's console; keep a console parent inside the PTY.
        var shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var script = "& '" + executable.Replace("'", "''") + "' '-control' 'getWallpaper' '-monitor' '" + monitor + "' | Out-Null";
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        if (!CreateProcess(shell, new StringBuilder("\"" + shell + "\" -NoProfile -NonInteractive -EncodedCommand " + encoded), IntPtr.Zero, IntPtr.Zero, false, 0x80000, IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out process)) throw new Exception("WE_QUERY_START_FAILED");
        if (WaitForSingleObject(process.process, 4000) != 0) { TerminateProcess(process.process, 1); throw new Exception("WE_QUERY_TIMEOUT"); }
        ClosePseudoConsole(console); console = IntPtr.Zero;
        if (!reader.Wait(2000)) throw new Exception("WE_QUERY_READ_TIMEOUT");
        string text = Regex.Replace(reader.Result, "\u001b\\][^\u0007]*(?:\u0007|\u001b\\\\)", "");
        text = Regex.Replace(text, "\u001b\\[[0-?]*[ -/]*[@-~]", "").Trim();
        foreach (string line in text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) {
          var value = line.Trim().Trim('"'); if (Path.IsPathRooted(value) && File.Exists(value)) return value;
        }
        throw new Exception("WE_QUERY_EMPTY");
      } finally {
        if (console != IntPtr.Zero) ClosePseudoConsole(console);
        if (reader != null) reader.Wait(2000);
        if (list != IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
        foreach (var handle in new[] { inputRead, inputWrite, outputRead, outputWrite, process.thread, process.process }) if (handle != IntPtr.Zero) CloseHandle(handle);
      }
    }
  }
}
