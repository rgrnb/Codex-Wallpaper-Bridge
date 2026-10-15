using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CodexWallpaperBridge {
  internal static class Program {
    public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    public static string Executable { get { return Application.ExecutablePath; } }
    [STAThread] public static int Main(string[] args) {
      try {
        if (args.Length == 2 && args[0] == "--start-update") { WeConsole.StartUpdate(args[1]); return 0; }
        if (args.Length == 4 && args[0] == "--start-codex") { SetPipes(); Console.WriteLine(Json.Serialize(new { pid=WeConsole.StartCodex(args[1],args[2],Int32.Parse(args[3])) })); return 0; }
        if (args.Length == 2 && args[0] == "--metrics") { SetPipes(); Console.WriteLine(Json.Serialize(ProcessMetrics.Collect(args[1]))); return 0; }
        if (args.Length == 3 && args[0] == "--we-current") { SetPipes(); Console.WriteLine(Json.Serialize(new { file = WeConsole.Current(args[1], Int32.Parse(args[2])) })); return 0; }
        if (args.Length == 3 && (args[0] == "--application-surfaces" || args[0] == "--fixture-surfaces")) { SetPipes(); Console.WriteLine(Json.Serialize(Native.ApplicationSurfaces(args[1],Int32.Parse(args[2]),args[0]=="--fixture-surfaces"))); return 0; }
        if (args.Contains("--signal-stop")) {
          try { using (var signal = EventWaitHandle.OpenExisting("Local\\CodexWallpaperBridge.Stop-" + Environment.UserName)) signal.Set(); } catch (WaitHandleCannotBeOpenedException) { }
          return 0;
        }
        if (args.Contains("--probe")) { SetPipes(); Console.WriteLine(Json.Serialize(Native.Probe())); return 0; }
        if (args.Contains("--frames")) { Native.Frames(); return 0; }
        if (args.Contains("--selftest-ui")) {
          Application.EnableVisualStyles(); using (var form = new SettingsForm(null)) {
            form.CreateControl(); if (form.Controls.Count < 1 || form.ClientSize.Width < 600) return 1;
          } return 0;
        }
        if (args.Length == 2 && args[0] == "--startup") { Startup(args[1] == "enable"); return 0; }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        using (var mutex = new Mutex(false, "Local\\CodexWallpaperBridge-" + Environment.UserName)) {
          bool acquired; try { acquired = mutex.WaitOne(0, false); } catch (AbandonedMutexException) { acquired = true; }
          if (!acquired) return 0;
          try { Application.Run(new BridgeContext()); } finally { mutex.ReleaseMutex(); }
        }
        return 0;
      } catch (Exception failure) {
        var updateNonce=Environment.GetEnvironmentVariable("BRIDGE_UPDATE_NONCE");
        if (updateNonce!=null && System.Text.RegularExpressions.Regex.IsMatch(updateNonce,"^[a-f0-9]{32}$")) {
          try {
            var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexWallpaperBridge","updates");Directory.CreateDirectory(root);
            string code=System.Text.RegularExpressions.Regex.IsMatch(failure.Message,"^[A-Z][A-Z0-9_]+$")?failure.Message:"NATIVE_STARTUP_FAILED";
            File.WriteAllText(Path.Combine(root,"health-"+updateNonce+".json"),Json.Serialize(new{nonce=updateNonce,healthy=false,code=code}));
          }catch{ } return 1;
        }
        if (args.Length > 0) { Console.Error.WriteLine("NATIVE_OPERATION_FAILED:" + failure.GetType().Name + ":" + failure.HResult);
          if (System.Text.RegularExpressions.Regex.IsMatch(failure.Message, "^[A-Z][A-Z0-9_:]+$")) Console.Error.WriteLine(failure.Message);
          return 1; }
        MessageBox.Show("启动失败。请运行 scripts/build.ps1 重新构建，或检查应用目录是否完整。", "Codex Wallpaper Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
      }
    }
    public static void SetPipes() {
      Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
      Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
    }
    public static void Startup(bool enabled) {
      using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) {
        if (enabled) key.SetValue("CodexWallpaperBridge", "\"" + StartupExecutable + "\" --background");
        else {
          var existing = key.GetValue("CodexWallpaperBridge") as string;
          if (existing != null && (existing.StartsWith("\"" + Executable + "\"", StringComparison.OrdinalIgnoreCase) || existing.StartsWith("\"" + StartupExecutable + "\"", StringComparison.OrdinalIgnoreCase))) key.DeleteValue("CodexWallpaperBridge", false);
        }
      }
    }
    public static string StartupExecutable {
      get {
        string root = Path.GetDirectoryName(Executable), marker = Path.Combine(root, ".bridge-owned");
        string launcher = Path.Combine(Path.GetDirectoryName(root), "CodexWallpaperBridge.Launcher.exe");
        if (File.Exists(marker) && File.ReadAllText(marker) == "CodexWallpaperBridge/1" && File.Exists(launcher) && FileVersionInfo.GetVersionInfo(launcher).ProductName == "CodexWallpaperBridge.Launcher/1") return launcher;
        return Executable;
      }
    }
  }
  internal static class Native {
    internal delegate bool EnumCallback(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumCallback cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("iphlpapi.dll", SetLastError = true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct TcpRow { public uint State, LocalAddr, LocalPort, RemoteAddr, RemotePort, Pid; }
    static readonly Dictionary<string, string> SurfaceTypes = new Dictionary<string, string> {
      { "WPEVideoWallpaper", "video" }, { "WPEScene", "scene" }, { "WPESceneWallpaper", "scene" },
      { "WPEWebWallpaper", "web" }, { "WPEApplicationWallpaper", "application" }
      , { "WPEDesktopDX11Window", "scene" }, { "WPEDesktopCEFWindow", "web" }
    };
    static string ClassOf(IntPtr h) { var text = new StringBuilder(256); GetClassName(h, text, 256); return text.ToString(); }
    static bool WallpaperPath(string file) { return File.Exists(file) &&
      (Path.GetFileName(file).Equals("wallpaper64.exe", StringComparison.OrdinalIgnoreCase) || Path.GetFileName(file).Equals("wallpaper32.exe", StringComparison.OrdinalIgnoreCase)); }
    internal static bool CodexPath(string file) { return File.Exists(file) && Path.GetFileName(file).Equals("ChatGPT.exe", StringComparison.OrdinalIgnoreCase) &&
      (file.IndexOf(@"\WindowsApps\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0 || file.IndexOf(@"\OpenAI\Codex\", StringComparison.OrdinalIgnoreCase) >= 0); }
    static string VersionOf(string file) { try { return FileVersionInfo.GetVersionInfo(file).ProductVersion ?? "unavailable"; } catch { return "unavailable"; } }
    public static object ApplicationSurfaces(string executable,int owner,bool fixture) {
      if (!Path.IsPathRooted(executable) || !File.Exists(executable) || !Path.GetExtension(executable).Equals(".exe", StringComparison.OrdinalIgnoreCase)) throw new Exception("APPLICATION_SOURCE_INVALID");
      var source = Path.GetFullPath(executable); var results = new List<object>();
      var parents=ProcessMetrics.ParentMap();uint helperParent;
      if(fixture){if(!parents.TryGetValue((uint)Process.GetCurrentProcess().Id,out helperParent)||helperParent!=owner||Path.GetFileName(source)!="BridgeGraphicsFixture.exe")throw new Exception("APPLICATION_FIXTURE_OWNER_INVALID");}
      else using(var creator=Process.GetProcessById(owner))if(!WallpaperPath(creator.MainModule.FileName))throw new Exception("APPLICATION_OWNER_INVALID");
      // Exact selected EXE AND a process launched by the current WE instance.
      // An unrelated user application using the same EXE is never a source.
      foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(source))) using (process) {
        try {
          if (!String.Equals(Path.GetFullPath(process.MainModule.FileName), source, StringComparison.OrdinalIgnoreCase)) continue;
          if(!ProcessMetrics.Descends((uint)process.Id,(uint)owner,parents))continue;
          EnumCallback visit = delegate(IntPtr hwnd, IntPtr p) {
            uint pid; GetWindowThreadProcessId(hwnd, out pid); Rect rect;
            string cls = ClassOf(hwnd);
            if (pid == process.Id && (!fixture||cls=="CodexBridgeGraphicsFixture") && IsWindowVisible(hwnd) && cls != "IME" && cls != "MSCTFIME UI" && GetClientRect(hwnd, out rect) && rect.Right >= 64 && rect.Bottom >= 64)
              results.Add(new { hwnd = hwnd.ToInt64().ToString(), pid = process.Id, type = "application", sourceFile = source, className = cls, width = rect.Right, height = rect.Bottom,
                wePid=fixture?0:owner,fixtureOwnerPid=fixture?owner:0 });
            return true;
          };
          var visited = new HashSet<long>();
          EnumWindows(delegate(IntPtr hwnd, IntPtr p) {
            if (visited.Add(hwnd.ToInt64())) visit(hwnd, p);
            EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr unused) { if (visited.Add(child.ToInt64())) visit(child, unused); return true; }, p);
            return true;
          }, IntPtr.Zero);
        } catch { }
      }
      return results.ToArray();
    }
    static Dictionary<uint, List<int>> Listeners() {
      var result = new Dictionary<uint, List<int>>(); int size = 0;
      GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
      if (size <= 0 || size > 16 * 1024 * 1024) return result;
      var memory = Marshal.AllocHGlobal(size);
      try {
        if (GetExtendedTcpTable(memory, ref size, false, 2, 3, 0) != 0) return result;
        int count = Marshal.ReadInt32(memory), stride = Marshal.SizeOf(typeof(TcpRow));
        if (count < 0 || 4L + count * (long)stride > size) return result;
        for (int i = 0; i < count; i++) {
          var row = (TcpRow)Marshal.PtrToStructure(IntPtr.Add(memory, 4 + i * stride), typeof(TcpRow));
          if (row.State != 2 || new IPAddress(row.LocalAddr).ToString() != "127.0.0.1") continue;
          int port = (int)(((row.LocalPort & 255) << 8) | ((row.LocalPort >> 8) & 255));
          if (port < 1024) continue;
          if (!result.ContainsKey(row.Pid)) result[row.Pid] = new List<int>(); result[row.Pid].Add(port);
        }
      } finally { Marshal.FreeHGlobal(memory); }
      return result;
    }
    public static object Probe() {
      var codex = new List<object>(); object wallpaper = null; string install = null;
      var listeners = Listeners();
      foreach (var proc in Process.GetProcessesByName("ChatGPT")) using (proc) {
        try {
          string file = proc.MainModule.FileName; if (!CodexPath(file)) continue;
          install = file;
          // Metadata only. Window titles, command lines, DOM text and profiles are never read.
          var package = System.Text.RegularExpressions.Regex.Match(file, @"OpenAI\.Codex_([0-9.]+)_");
          string appVersion = package.Success ? package.Groups[1].Value : "unavailable";
          if (listeners.ContainsKey((uint)proc.Id)) codex.Add(new { pid = proc.Id, path = file, version = appVersion, versionKind = "msix-package", runtimeVersion = VersionOf(file), endpoints = listeners[(uint)proc.Id].ToArray() });
          else if (proc.MainWindowHandle != IntPtr.Zero) codex.Add(new { pid = proc.Id, path = file, version = appVersion, versionKind = "msix-package", runtimeVersion = VersionOf(file), endpoints = new int[0] });
        } catch { }
      }
      foreach (var name in new[] { "wallpaper64", "wallpaper32" }) {
        foreach (var proc in Process.GetProcessesByName(name)) using (proc) {
          try {
            string file = proc.MainModule.FileName; if (!WallpaperPath(file)) continue;
            var surfaces = new List<object>(); var visited = new HashSet<long>(); bool hasTray = false;
            EnumCallback visit = delegate(IntPtr h, IntPtr p) {
              uint pid; GetWindowThreadProcessId(h, out pid); string kind;
              if (pid == proc.Id && ClassOf(h) == "WPETrayWindow") hasTray = true;
              if (pid == proc.Id && visited.Add(h.ToInt64()) && SurfaceTypes.TryGetValue(ClassOf(h), out kind)) {
                Rect r; if (GetClientRect(h, out r) && r.Right > 0 && r.Bottom > 0)
                  surfaces.Add(new { hwnd = h.ToInt64().ToString(), pid = proc.Id, type = kind, className=ClassOf(h), width = r.Right, height = r.Bottom });
              }
              return true;
            };
            EnumWindows(delegate(IntPtr h, IntPtr p) { visit(h, p); EnumChildWindows(h, visit, p); return true; }, IntPtr.Zero);
            if (!hasTray && surfaces.Count == 0) continue;
            wallpaper = new { running = true, pid = proc.Id, path = file, version = VersionOf(file), surfaces = surfaces.ToArray() };
            break;
          } catch { }
        }
        if (wallpaper != null) break;
      }
      if (install == null) {
        // Read package identity without touching protected application files or configuration.
        try {
          using (var ps = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation\"") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })) {
            var read = ps.StandardOutput.ReadToEndAsync();
            if (!ps.WaitForExit(5000)) ps.Kill();
            else { var candidate = Path.Combine(read.Result.Trim(), "app", "ChatGPT.exe"); if (CodexPath(candidate)) install = candidate; }
          }
        } catch { }
      }
      bool startupEnabled = false;
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) {
        var entry = key == null ? null : key.GetValue("CodexWallpaperBridge") as string;
        startupEnabled = entry != null && (entry.StartsWith("\"" + Program.Executable + "\"", StringComparison.OrdinalIgnoreCase) || entry.StartsWith("\"" + Program.StartupExecutable + "\"", StringComparison.OrdinalIgnoreCase));
      }
      return new { schemaVersion = 1, os = Environment.OSVersion.VersionString, startupEnabled = startupEnabled, codex = codex.ToArray(), codexInstall = install, wallpaperEngine = wallpaper };
    }
    public static void Frames() {
      Program.SetPipes();
      string line; WgcCapture capture = null; GraphicsCaptureBridge graphicsCapture = null; IntPtr gdiWindow = IntPtr.Zero;
      var applicationOwners=new Dictionary<string,DateTime>();
      while ((line = Console.ReadLine()) != null) {
        if (line.Length > 4096) { Console.WriteLine("{\"error\":\"FRAME_REQUEST_TOO_LARGE\"}"); continue; }
        try {
          var row = Program.Json.Deserialize<Dictionary<string, object>>(line);
          long value; if (!Int64.TryParse(Convert.ToString(row["hwnd"]), out value) || value <= 0) throw new Exception("FRAME_WINDOW_INVALID");
          var handle = new IntPtr(value); uint pid; GetWindowThreadProcessId(handle, out pid);
          if (pid != Convert.ToInt32(row["pid"])) throw new Exception("FRAME_OWNER_INVALID");
          bool applicationSource = false;
          using (var proc = Process.GetProcessById((int)pid)) {
            object expected;
            if (row.TryGetValue("sourceFile", out expected)) {
              applicationSource = true;
              string file = Convert.ToString(expected);
              if (!Path.IsPathRooted(file) || !Path.GetExtension(file).Equals(".exe", StringComparison.OrdinalIgnoreCase) ||
                  !String.Equals(Path.GetFullPath(file), Path.GetFullPath(proc.MainModule.FileName), StringComparison.OrdinalIgnoreCase)) throw new Exception("FRAME_OWNER_INVALID");
            } else if (!WallpaperPath(proc.MainModule.FileName) || !SurfaceTypes.ContainsKey(ClassOf(handle))) throw new Exception("FRAME_OWNER_INVALID");
          }
          int width = Math.Max(320, Math.Min(1920, Convert.ToInt32(row["maxWidth"]))), quality = Math.Max(30, Math.Min(95, Convert.ToInt32(row["quality"])));
          Rect rect; if (!GetClientRect(handle, out rect) || rect.Right < 1 || rect.Bottom < 1 || (long)rect.Right * rect.Bottom > 16777216) throw new Exception("FRAME_SIZE_INVALID");
          object graphicsFlag;
          bool sceneGraphics = ClassOf(handle) == "WPEDesktopDX11Window" && !applicationSource;
          bool fixtureGraphics = applicationSource && row.ContainsKey("fixtureOwnerPid") && Convert.ToInt32(row["fixtureOwnerPid"])>0 && ClassOf(handle) == "CodexBridgeGraphicsFixture" &&
            Path.GetFileName(Convert.ToString(row["sourceFile"])) == "BridgeGraphicsFixture.exe";
          if(applicationSource) {
            object supplied;int owner=row.TryGetValue(fixtureGraphics?"fixtureOwnerPid":"wePid",out supplied)?Convert.ToInt32(supplied):0;
            if(owner<1)throw new Exception("FRAME_OWNER_INVALID");
            string ownerKey=pid+":"+owner+":"+Convert.ToString(row["sourceFile"]);DateTime checkedAt;
            if(!applicationOwners.TryGetValue(ownerKey,out checkedAt)||(DateTime.UtcNow-checkedAt).TotalSeconds>2) {
              var parents=ProcessMetrics.ParentMap();
              if(!ProcessMetrics.Descends(pid,(uint)owner,parents))throw new Exception("FRAME_OWNER_INVALID");
              if(fixtureGraphics){uint helperParent;if(!parents.TryGetValue((uint)Process.GetCurrentProcess().Id,out helperParent)||helperParent!=owner)throw new Exception("FRAME_OWNER_INVALID");}
              else using(var creator=Process.GetProcessById(owner))if(!WallpaperPath(creator.MainModule.FileName))throw new Exception("FRAME_OWNER_INVALID");
              applicationOwners.Clear();applicationOwners[ownerKey]=DateTime.UtcNow;
            }
          }
          bool graphicsMode = row.TryGetValue("graphics", out graphicsFlag) && Convert.ToBoolean(graphicsFlag) && (sceneGraphics || fixtureGraphics);
          if(graphicsMode && capture!=null){capture.Dispose();capture=null;gdiWindow=IntPtr.Zero;}
          if(!graphicsMode && graphicsCapture!=null){graphicsCapture.Dispose();graphicsCapture=null;}
          if (graphicsMode && (graphicsCapture == null || graphicsCapture.Window != handle)) {
            if (graphicsCapture != null) graphicsCapture.Dispose(); graphicsCapture = new GraphicsCaptureBridge(handle, (int)pid);
          }
          if (!graphicsMode && (capture == null || capture.Window != handle) && gdiWindow != handle) {
            if (capture != null) { capture.Dispose(); capture = null; }
            gdiWindow = IntPtr.Zero;
            try { capture = new WgcCapture(handle); }
            catch (Exception failure) {
              string kind; bool sceneSource = SurfaceTypes.TryGetValue(ClassOf(handle), out kind) && kind == "scene";
              if ((!applicationSource && !sceneSource) || !failure.Message.Contains("ITEM_ARGUMENTEXCEPTION_80070057")) throw;
              gdiWindow = handle;
            }
          }
          int fps = row.ContainsKey("fps") ? Convert.ToInt32(row["fps"]) : 15;
          using (var source = graphicsMode ? graphicsCapture.Next(width, fps) : gdiWindow == handle ? GdiApplicationFrame(handle, rect.Right, rect.Bottom) : capture.Next()) {
            if(source==null){Console.WriteLine("{\"paused\":true,\"code\":\"SOURCE_RENDER_PAUSED\"}");continue;}
            int targetWidth = Math.Min(width, source.Width), targetHeight = Math.Max(1, (int)Math.Round(source.Height * (double)targetWidth / source.Width));
            using (var resized = new Bitmap(targetWidth, targetHeight)) {
              using (var graphics = Graphics.FromImage(resized)) graphics.DrawImage(source, 0, 0, targetWidth, targetHeight);
              using (var memory = new MemoryStream()) using (var parameters = new EncoderParameters(1)) {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                resized.Save(memory, ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg"), parameters);
                if (memory.Length > 4 * 1024 * 1024) throw new Exception("FRAME_ENCODE_TOO_LARGE");
                Console.WriteLine(Program.Json.Serialize(new { jpeg = Convert.ToBase64String(memory.ToArray()), width = targetWidth, height = targetHeight,
                  sourcePaused = graphicsMode && graphicsCapture.IsPaused, sequence = graphicsMode ? graphicsCapture.Sequence : 0 }));
              }
            }
          }
        } catch (Exception error) {
          if (capture != null) { capture.Dispose(); capture = null; }
          if (graphicsCapture != null) { graphicsCapture.Dispose(); graphicsCapture = null; }
          string code = System.Text.RegularExpressions.Regex.IsMatch(error.Message, "^(FRAME|GRAPHICS|APPLICATION)_[A-Z0-9_]+$") ? error.Message : "FRAME_OPERATION_FAILED_" + error.GetType().Name.ToUpperInvariant() + "_" + unchecked((uint)error.HResult).ToString("X8");
          Console.WriteLine(Program.Json.Serialize(new { error = code }));
        }
        Console.Out.Flush();
      }
      if (capture != null) capture.Dispose();
      if (graphicsCapture != null) graphicsCapture.Dispose();
    }
    static Bitmap GdiApplicationFrame(IntPtr window, int width, int height) {
      var frame = new Bitmap(width, height, PixelFormat.Format32bppRgb);
      using (var graphics = Graphics.FromImage(frame)) {
        var dc = graphics.GetHdc();
        try { if (!PrintWindow(window, dc, 3)) { frame.Dispose(); throw new Exception("APPLICATION_PRINT_UNSUPPORTED"); } }
        finally { graphics.ReleaseHdc(dc); }
      }
      return frame;
    }
  }
  internal sealed class BridgeContext : ApplicationContext {
    readonly NotifyIcon tray; readonly Process engine; readonly string token; readonly System.Windows.Forms.Timer timer;
    readonly SettingsForm form; readonly EventWaitHandle stopEvent; readonly RegisteredWaitHandle stopWait;
    int port; bool exiting; bool polling; string notifiedVersion; readonly IntPtr processJob;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public BridgeContext() {
      var requestedToken=Environment.GetEnvironmentVariable("BRIDGE_CONTROL_TOKEN");
      token = requestedToken != null && System.Text.RegularExpressions.Regex.IsMatch(requestedToken,"^[a-f0-9]{64}$") ? requestedToken : RandomToken(); string baseDir = AppDomain.CurrentDomain.BaseDirectory;
      string root = File.Exists(Path.Combine(baseDir, "src", "main.mjs")) ? baseDir : Path.GetFullPath(Path.Combine(baseDir, ".."));
      string node = Path.Combine(baseDir, "node.exe"); if (!File.Exists(node)) node = FindNode();
      var start = new ProcessStartInfo(node, "\"" + Path.Combine(root, "src", "main.mjs") + "\"") {
        UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
        WorkingDirectory = root, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
      };
      start.EnvironmentVariables["BRIDGE_CONTROL_TOKEN"] = token;
      start.EnvironmentVariables["BRIDGE_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
      start.EnvironmentVariables["BRIDGE_NATIVE_HOST"] = Program.Executable;
      engine = new Process { StartInfo = start, EnableRaisingEvents = true };
      engine.Start();
      processJob = CreateJobObject(IntPtr.Zero, null);
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64). KILL_ON_JOB_CLOSE includes browser/helper descendants.
      var jobLimits = Marshal.AllocHGlobal(144);
      try {
        for (int i = 0; i < 144; i++) Marshal.WriteByte(jobLimits, i, 0);
        Marshal.WriteInt32(jobLimits, 16, 0x2800); // Kill-on-close; explicit updater/official Codex launches may break away.
        if (processJob == IntPtr.Zero || !SetInformationJobObject(processJob, 9, jobLimits, 144) || !AssignProcessToJobObject(processJob, engine.Handle)) {
          try { engine.Kill(); } catch { } if (processJob != IntPtr.Zero) CloseHandle(processJob); throw new Exception("PROCESS_JOB_FAILED");
        }
      } finally { Marshal.FreeHGlobal(jobLimits); }
      // Drain errors without exposing private paths or keeping unbounded process output.
      string startupFailure="UNKNOWN";
      engine.ErrorDataReceived += delegate(object sender,DataReceivedEventArgs args) {
        if(args.Data==null)return;
        var code=System.Text.RegularExpressions.Regex.Match(args.Data,"\\b(EPERM|EACCES|ENOENT|SyntaxError|TypeError|ReferenceError)\\b");
        if(code.Success)startupFailure=code.Value.ToUpperInvariant();
      }; engine.BeginErrorReadLine();
      var ready = engine.StandardOutput.ReadLineAsync();
      if (!ready.Wait(30000) || ready.Result == null) { bool ended=engine.HasExited;if(ended)engine.WaitForExit();int exitCode=ended?engine.ExitCode:0;try { engine.Kill(); } catch { } throw new Exception(ended?"ENGINE_START_FAILED_"+startupFailure+"_"+unchecked((uint)exitCode).ToString("X8"):"ENGINE_START_TIMEOUT"); }
      var row = Program.Json.Deserialize<Dictionary<string, object>>(ready.Result); port = Convert.ToInt32(row["port"]);
      form = new SettingsForm(this);
      stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CodexWallpaperBridge.Stop-" + Environment.UserName);
      var handle = form.Handle;
      stopWait = ThreadPool.RegisterWaitForSingleObject(stopEvent, delegate {
        try { form.BeginInvoke(new Action(async delegate { await Quit(); })); } catch { }
      }, null, -1, false);
      var menu = new ContextMenuStrip();
      var trayStatus = menu.Items.Add("正在检测应用…"); trayStatus.Enabled = false;
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("设置与状态", null, delegate { ShowSettings(); });
      menu.Items.Add("启用背景", null, async delegate { await ChangeEnabled(true); });
      menu.Items.Add("恢复官方外观", null, async delegate { await Action("/restore", new object()); });
      menu.Items.Add("导出诊断", null, async delegate { await Action("/export", new object()); });
      menu.Items.Add(new ToolStripSeparator()); menu.Items.Add("退出并恢复", null, async delegate { await Quit(); });
      tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Codex Wallpaper Bridge", ContextMenuStrip = menu, Visible = true };
      tray.DoubleClick += delegate { ShowSettings(); };
      timer = new System.Windows.Forms.Timer { Interval = 2000 };
      timer.Tick += async delegate { if (polling || exiting) return; polling = true;
        try {
          var current = await Request("GET", "/status", null); form.SetStatus(current);
          trayStatus.Text = form.StatusText; tray.Text = "Bridge · " + form.StatusText;
          var update = current["updates"] as Dictionary<string, object>;
          if (update != null && Convert.ToString(update["status"]) == "AwaitingConfirmation" && Convert.ToString(update["version"]) != notifiedVersion) {
            notifiedVersion = Convert.ToString(update["version"]); tray.BalloonTipTitle = "Bridge 有可用更新";
            tray.BalloonTipText = "版本 " + notifiedVersion + " 已可用。请打开设置确认安装。"; tray.ShowBalloonTip(8000);
          }
        }
        catch { form.ShowError("连接中断，背景会自动恢复。请退出后重新启动 Bridge。"); }
        finally { polling = false; }
      }; timer.Start();
      Application.ApplicationExit += delegate { tray.Visible = false; tray.Dispose(); };
      if (!Environment.GetCommandLineArgs().Contains("--background")) ShowSettings();
    }
    static string RandomToken() { using (var rng = RandomNumberGenerator.Create()) { var bytes = new byte[32]; rng.GetBytes(bytes); return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); } }
    static string FindNode() {
      foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
        try { string file = Path.Combine(directory.Trim('"'), "node.exe"); if (File.Exists(file)) return file; } catch { }
      }
      throw new Exception("NODE_NOT_FOUND");
    }
    void ShowSettings() { form.Show(); form.WindowState = FormWindowState.Normal; form.Activate(); }
    public async Task<Dictionary<string, object>> Request(string method, string route, object body) {
      var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + route);
      request.Proxy = null; request.Method = method; request.Timeout = 10000; request.ReadWriteTimeout = 10000;
      request.Headers["X-Bridge-Token"] = token;
      if (body != null) { var bytes = Encoding.UTF8.GetBytes(Program.Json.Serialize(body)); request.ContentType = "application/json"; request.ContentLength = bytes.Length;
        using (var stream = await request.GetRequestStreamAsync()) await stream.WriteAsync(bytes, 0, bytes.Length); }
      using (var response = await request.GetResponseAsync()) using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        return Program.Json.Deserialize<Dictionary<string, object>>(await reader.ReadToEndAsync());
    }
    public async Task Action(string route, object body) {
      try { await Request("POST", route, body); form.RefreshSettings(await Request("GET", "/status", null)); }
      catch (WebException error) {
        string message = "操作失败，请查看诊断状态。";
        if (error.Response != null) using (var reader = new StreamReader(error.Response.GetResponseStream())) {
          try { var row = Program.Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd()); message += "\n" + Convert.ToString(row["error"]); } catch { }
        }
        form.ShowError(message);
      } catch { form.ShowError("操作失败，请检查 Bridge 是否仍在运行。"); }
    }
    async Task ChangeEnabled(bool enabled) {
      try { var row = await Request("GET", "/status", null); var settings = (Dictionary<string, object>)row["settings"]; settings["enabled"] = enabled; await Action("/settings", settings); }
      catch { form.ShowError("无法读取设置。"); }
    }
    async Task Quit() {
      if (exiting) return; exiting = true; timer.Stop();
      try { await Request("POST", "/exit", new object()); } catch { }
      await Task.Run(delegate { if (!engine.WaitForExit(9000)) { try { engine.Kill(); } catch { } } });
      tray.Visible = false; tray.Dispose(); form.AllowClose = true; form.Close(); engine.Dispose(); ExitThread();
      CloseHandle(processJob);
      stopWait.Unregister(null); stopEvent.Dispose();
    }
  }
  internal sealed class SettingsForm : Form {
    readonly BridgeContext owner; Dictionary<string, object> settings;
    readonly Label status = new Label(), details = new Label(), error = new Label(), updates = new Label(), diagnostics = new Label();
    string updateVersion; Button installUpdate;
    readonly CheckBox enabled = new CheckBox(), startup = new CheckBox(), adjust = new CheckBox(), debug = new CheckBox(), candidate = new CheckBox(), frames = new CheckBox();
    readonly ComboBox mode = new ComboBox(); readonly NumericUpDown fps = new NumericUpDown(), monitor = new NumericUpDown();
    readonly TrackBar opacity = new TrackBar(), blur = new TrackBar(), brightness = new TrackBar(), contrast = new TrackBar();
    bool initialized; public bool AllowClose;
    public SettingsForm(BridgeContext context) {
      owner = context; Text = "Codex Wallpaper Bridge"; ClientSize = new Size(740, 760); MinimumSize = new Size(660, 680);
      Font = new Font("Microsoft YaHei UI", 10); BackColor = Color.FromArgb(246, 248, 251); AutoScaleMode = AutoScaleMode.Dpi;
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(24), ColumnCount = 2 };
      layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 165)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); Controls.Add(layout);
      status.AutoSize = true; status.Font = new Font(Font.FontFamily, 17, FontStyle.Bold); status.Text = "正在检测应用…";
      AddWide(layout, status); details.AutoSize = true; details.MaximumSize = new Size(640, 0); details.ForeColor = Color.DimGray; AddWide(layout, details);
      enabled.Text = "启用动态背景"; startup.Text = "随 Windows 登录启动（仅当前用户）";
      Add(layout, "常规", enabled); Add(layout, "", startup);
      ConfigureSlider(opacity, 0, 100, 60); ConfigureSlider(blur, 0, 30, 0); ConfigureSlider(brightness, 10, 200, 100); ConfigureSlider(contrast, 10, 200, 100);
      Add(layout, "壁纸不透明度 %", opacity); Add(layout, "模糊 px", blur); Add(layout, "亮度 %", brightness); Add(layout, "对比度 %", contrast);
      mode.DropDownStyle = ComboBoxStyle.DropDownList; mode.Items.AddRange(new object[] { "性能模式", "平衡模式", "画质模式" }); mode.SelectedIndex = 1;
      fps.Minimum = 1; fps.Maximum = 60; fps.Value = 60; monitor.Minimum = 0; monitor.Maximum = 31;
      Add(layout, "性能策略", mode); Add(layout, "FPS 上限", fps); adjust.Text = "根据实际负载自动调整帧率"; Add(layout, "", adjust);
      Add(layout, "来源显示器（从 0 起）", monitor); debug.Text = "Debug 诊断（默认关闭）"; Add(layout, "高级", debug);
      candidate.Text = "允许候选 Codex 适配器（尚未通过实机验收）"; Add(layout, "", candidate);
      frames.Text = "允许实验性渲染适配（未验证的 Wallpaper Engine 版本）"; Add(layout, "", frames);
      var note = new Label { AutoSize = true, MaximumSize = new Size(640, 0), ForeColor = Color.DimGray,
        Text = "自动跟随 Wallpaper Engine；所有 Codex 窗口共用来源，居中 Cover，始终静音。\n四类壁纸均已接入；当前项目或版本不兼容时恢复官方外观。\n可在设置中配置可信更新源；完整兼容与稳定性验收仍在进行。" }; AddWide(layout, note);
      var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
      Button apply = Button("保存并应用", async delegate { await Save(); });
      buttons.Controls.Add(apply); buttons.Controls.Add(Button("重置效果", delegate { opacity.Value = 60; blur.Value = 0; brightness.Value = 100; contrast.Value = 100; }));
      buttons.Controls.Add(Button("恢复官方外观", async delegate { await owner.Action("/restore", new object()); }));
      buttons.Controls.Add(Button("导出诊断", async delegate { await owner.Action("/export", new object());
        MessageBox.Show("诊断文件位置：\n" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexWallpaperBridge", "diagnostics.json"), Text); }));
      buttons.Controls.Add(Button("以连接模式启动 Codex", async delegate { await owner.Action("/launch", new object()); }));
      buttons.Controls.Add(Button("检查更新", async delegate { await owner.Action("/updates/check", new object()); }));
      buttons.Controls.Add(Button("配置发布源", delegate {
        using (var dialog = new Form { Text = "配置更新发布源", ClientSize = new Size(620, 330), StartPosition = FormStartPosition.CenterParent, Font = Font }) {
          var address = new TextBox { Left = 20, Top = 45, Width = 580 };
          var key = new TextBox { Left = 20, Top = 110, Width = 580, Height = 145, Multiline = true, ScrollBars = ScrollBars.Vertical };
          dialog.Controls.Add(new Label { Left = 20, Top = 20, Width = 580, Text = "HTTPS 发布清单地址" }); dialog.Controls.Add(address);
          dialog.Controls.Add(new Label { Left = 20, Top = 82, Width = 580, Text = "发行者 Ed25519 公钥（PEM）；请只配置你信任的发行源。" }); dialog.Controls.Add(key);
          var save = Button("信任此来源并保存", async delegate { await owner.Action("/updates/configure", new { confirmed = true, manifestUrl = address.Text.Trim(), publicKeyPem = key.Text.Trim() }); dialog.Close(); });
          save.Location = new Point(390, 275); dialog.Controls.Add(save); dialog.ShowDialog(this);
        }
      }));
      installUpdate = Button("安装更新", async delegate {
        if (String.IsNullOrEmpty(updateVersion)) return;
        if (MessageBox.Show("安装 Bridge " + updateVersion + " 并重新启动？\n设置会保留；失败时自动回滚并关闭背景。", Text, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
          await owner.Action("/updates/install", new { confirmed = true, version = updateVersion });
      }); installUpdate.Enabled = false; buttons.Controls.Add(installUpdate);
      updates.AutoSize = diagnostics.AutoSize = true; updates.MaximumSize = diagnostics.MaximumSize = new Size(640, 0);
      AddWide(layout, updates); AddWide(layout, diagnostics);
      AddWide(layout, buttons); error.AutoSize = true; error.MaximumSize = new Size(640, 0); error.ForeColor = Color.Firebrick; AddWide(layout, error);
      FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!AllowClose) { e.Cancel = true; Hide(); } };
    }
    static Button Button(string text, EventHandler action) { var b = new Button { Text = text, AutoSize = true, Padding = new Padding(7, 3, 7, 3), Margin = new Padding(0, 5, 8, 5) }; b.Click += action; return b; }
    static void ConfigureSlider(TrackBar slider, int min, int max, int value) { slider.Minimum = min; slider.Maximum = max; slider.Value = value; slider.TickStyle = TickStyle.None; slider.Dock = DockStyle.Fill; slider.Height = 34; }
    static void Add(TableLayoutPanel layout, string text, Control control) { int row = layout.RowCount++; layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      layout.Controls.Add(new Label { Text = text, AutoSize = true, Padding = new Padding(0, 8, 0, 0) }, 0, row); control.AutoSize = true; control.Margin = new Padding(0, 5, 0, 5); layout.Controls.Add(control, 1, row); }
    static void AddWide(TableLayoutPanel layout, Control control) { int row = layout.RowCount++; layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); control.Margin = new Padding(0, 0, 0, 14); layout.Controls.Add(control, 0, row); layout.SetColumnSpan(control, 2); }
    public void ShowError(string text) { error.Text = text; }
    public string StatusText { get { return status.Text; } }
    public void RefreshSettings(Dictionary<string, object> row) { initialized = false; SetStatus(row); }
    public void SetStatus(Dictionary<string, object> row) {
      var state = Convert.ToString(row["state"]);
      var names = new Dictionary<string, string> { { "Disabled", "背景已关闭" }, { "Active", "壁纸已同步" }, { "WaitingForApps", "正在等待应用连接" },
        { "LoadingWallpaper", "正在准备新壁纸" }, { "Recovering", "已恢复官方外观，正在重连" }, { "Incompatible", "当前适配尚未验证或不兼容" }, { "Paused", "背景已暂停" } };
      status.Text = names.ContainsKey(state) ? names[state] : state;
      var source = row["source"] as Dictionary<string, object>; var policy = row["policy"] as Dictionary<string, object>;
      string code = Convert.ToString(row["code"]), explanation = "";
      if (code == "CODEX_CONNECTION_REQUIRED") explanation = "点击“以连接模式启动 Codex”打开独立窗口；首次可能需要登录。现有 Codex 窗口可以保留。";
      else if (code == "WAITING_FOR_WALLPAPER_ENGINE") explanation = "请先启动 Wallpaper Engine，Bridge 会自动连接。";
      else if (code == "CODEX_ADAPTER_UNVERIFIED") explanation = "当前 Codex 版本尚未完成实机验收，可在高级选项中启用候选适配器进行开发验证。";
      else if (code.Contains("NEEDS_RENDERER") || code.Contains("RENDER_SURFACE")) explanation = "当前壁纸类型的动态画面接入尚未验证，已保留官方外观。";
      else if (state == "Incompatible" && code.StartsWith("WEB_")) explanation = "当前 Web 项目需要尚未支持的 Wallpaper Engine 接口或私有属性。请选择兼容项目，Bridge 会自动重新检测。";
      else if (state == "Incompatible" && code.StartsWith("GRAPHICS_FORMAT_UNSUPPORTED")) explanation = "当前壁纸输出的图像格式尚未支持。已恢复官方外观；更换壁纸后自动重新检测。";
      else if (state == "Recovering") explanation = "背景暂时无法加载，正在尝试恢复连接；可导出诊断查看原因。";
      if (debug.Checked && code != "") explanation += "\n" + code;
      details.Text = "来源：" + (source == null ? "等待 Wallpaper Engine" : Convert.ToString(source["type"]) + " · " + Convert.ToString(source["id"])) +
        "     窗口：" + row["windowCount"] + "     有效 FPS 上限：" + policy["fps"] + "\n" + explanation;
      var update = row["updates"] as Dictionary<string, object>;
      updateVersion = update == null ? null : Convert.ToString(update["version"]);
      string updateState = update == null ? "NotConfigured" : Convert.ToString(update["status"]);
      var updateNames = new Dictionary<string, string> { { "NotConfigured", "尚未配置发布源" }, { "Idle", "自动检查已开启" },
        { "AwaitingConfirmation", "有可用更新 " + updateVersion }, { "UpToDate", "当前已是最新版本" }, { "Downloading", "正在校验下载" }, { "CheckFailed", "暂时无法检查，请稍后重试" }, { "Installing", "正在安装，Bridge 将重新启动" }, { "Staged", "更新已下载" } };
      updates.Text = "Bridge " + row["version"] + " · " + (updateNames.ContainsKey(updateState) ? updateNames[updateState] : updateState);
      installUpdate.Enabled = updateState == "AwaitingConfirmation";
      var metrics = row["metrics"] as Dictionary<string, object>;
      diagnostics.Visible = debug.Checked;
      diagnostics.Text = debug.Checked ? "诊断：\n" + Program.Json.Serialize(new { apps = row["apps"], metrics = metrics, adapter = row["adapter"], retry = row["retry"], source = row["source"],
        windows=row.ContainsKey("windows")?row["windows"]:null,modules=row.ContainsKey("modules")?row["modules"]:null }) : "";
      if (initialized) return;
      settings = (Dictionary<string, object>)row["settings"]; var effects = (Dictionary<string, object>)settings["effects"];
      enabled.Checked = (bool)settings["enabled"]; startup.Checked = (bool)settings["startup"]; adjust.Checked = (bool)settings["autoAdjust"];
      debug.Checked = (bool)settings["debug"]; candidate.Checked = (bool)settings["allowCandidateAdapter"]; frames.Checked = (bool)settings["experimentalWindowFrames"];
      mode.SelectedIndex = Array.IndexOf(new[] { "performance", "balanced", "quality" }, Convert.ToString(settings["performance"]));
      fps.Value = Convert.ToDecimal(settings["fpsLimit"]); monitor.Value = Convert.ToDecimal(settings["monitor"]);
      opacity.Value = (int)Math.Round(Convert.ToDouble(effects["opacity"]) * 100); blur.Value = Convert.ToInt32(effects["blur"]);
      brightness.Value = (int)Math.Round(Convert.ToDouble(effects["brightness"]) * 100); contrast.Value = (int)Math.Round(Convert.ToDouble(effects["contrast"]) * 100);
      initialized = true;
    }
    async Task Save() {
      if (settings == null) return; error.Text = "";
      settings["enabled"] = enabled.Checked; settings["startup"] = startup.Checked; settings["autoAdjust"] = adjust.Checked;
      settings["debug"] = debug.Checked; settings["allowCandidateAdapter"] = candidate.Checked; settings["experimentalWindowFrames"] = frames.Checked;
      settings["performance"] = new[] { "performance", "balanced", "quality" }[mode.SelectedIndex]; settings["fpsLimit"] = (int)fps.Value; settings["monitor"] = (int)monitor.Value;
      settings["effects"] = new { opacity = opacity.Value / 100.0, blur = blur.Value, brightness = brightness.Value / 100.0, contrast = contrast.Value / 100.0 };
      await owner.Action("/settings", settings);
    }
  }
}
