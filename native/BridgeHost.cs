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
        if (args.Length == 1 && args[0] == "--isolated-we") return IsolatedWallpaperHost.Run();
        if (args.Length == 2 && args[0] == "--start-we") { SetPipes(); Console.WriteLine(Json.Serialize(new { pid=WeConsole.StartWallpaperEngine(args[1]) })); return 0; }
        if (args.Length == 5 && args[0] == "--start-native-lease") { SetPipes(); Console.WriteLine(Json.Serialize(new { pid=WeConsole.StartNativeLease(Int32.Parse(args[1]),Int32.Parse(args[2]),args[3],args[4]) })); return 0; }
        if (args.Length == 7 && args[0] == "--native-lease") { WeConsole.NativeLease(Int32.Parse(args[1]),Int64.Parse(args[2]),Int32.Parse(args[3]),Int64.Parse(args[4]),args[5],args[6]); return 0; }
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
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("iphlpapi.dll", SetLastError = true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Explicit,Size=220)] struct DisplayMode { [FieldOffset(68)] public ushort Size; [FieldOffset(184)] public uint Frequency; }
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplaySettings(string device,int mode,ref DisplayMode settings);
    static int DisplayRefreshRate() {
      int maximum=60;
      foreach(var screen in Screen.AllScreens) { var mode=new DisplayMode{Size=220}; if(EnumDisplaySettings(screen.DeviceName,-1,ref mode)&&mode.Frequency>=30&&mode.Frequency<=1000)maximum=Math.Max(maximum,(int)mode.Frequency); }
      return maximum;
    }
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
    internal static Dictionary<uint, List<int>> Listeners() {
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
            string file = proc.MainModule.FileName; if (!WallpaperPath(file) || File.Exists(Path.Combine(Path.GetDirectoryName(file), ".bridge-isolated.json"))) continue;
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
      return new { schemaVersion = 1, os = Environment.OSVersion.VersionString, displayRefreshHz = DisplayRefreshRate(), startupEnabled = startupEnabled, codex = codex.ToArray(), codexInstall = install, wallpaperEngine = wallpaper };
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
          object isolatedValue;
          bool isolatedSource = row.TryGetValue("isolated",out isolatedValue);
          if (isolatedSource) IsolatedWallpaperHost.ValidateSurface(isolatedValue as Dictionary<string,object>,handle,(int)pid);
          using (var proc = Process.GetProcessById((int)pid)) {
            object expected;
            if (isolatedSource) { /* Exact host, process, creation time and named Job were checked above. */ }
            else if (row.TryGetValue("sourceFile", out expected)) {
              applicationSource = true;
              string file = Convert.ToString(expected);
              if (!Path.IsPathRooted(file) || !Path.GetExtension(file).Equals(".exe", StringComparison.OrdinalIgnoreCase) ||
                  !String.Equals(Path.GetFullPath(file), Path.GetFullPath(proc.MainModule.FileName), StringComparison.OrdinalIgnoreCase)) throw new Exception("FRAME_OWNER_INVALID");
            } else {
              bool nativePopout = false; object nativeTitle;
              if (row.TryGetValue("nativeTitle", out nativeTitle)) {
                string expectedTitle = Convert.ToString(nativeTitle); var actualTitle = new StringBuilder(512); GetWindowText(handle, actualTitle, actualTitle.Capacity);
                nativePopout = System.Text.RegularExpressions.Regex.IsMatch(expectedTitle, "^CodexBridgeNative-[a-f0-9-]{36}$") &&
                  actualTitle.ToString() == expectedTitle && ClassOf(handle) == "WPEOverlappedWallpaper";
              }
              if (!WallpaperPath(proc.MainModule.FileName) || (!nativePopout && !SurfaceTypes.ContainsKey(ClassOf(handle)))) throw new Exception("FRAME_OWNER_INVALID");
            }
          }
          object action;
          if(row.TryGetValue("action",out action)) {
            var proof=isolatedValue as Dictionary<string,object>;
            if(Convert.ToString(action)!="pointer"||!isolatedSource||proof==null||Convert.ToString(proof["type"])!="scene"||graphicsCapture==null||graphicsCapture.Window!=handle)throw new Exception("FRAME_POINTER_UNAVAILABLE");
            double x=Convert.ToDouble(row["x"]),y=Convert.ToDouble(row["y"]);
            if(Double.IsNaN(x)||Double.IsInfinity(x)||Double.IsNaN(y)||Double.IsInfinity(y)||x<0||x>1||y<0||y>1)throw new Exception("FRAME_POINTER_INVALID");
            graphicsCapture.Pointer(x,y,Convert.ToBoolean(row["click"]));Console.WriteLine(Program.Json.Serialize(new{sent=true,diagnostics=graphicsCapture.PointerDiagnostics}));Console.Out.Flush();continue;
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
            if (graphicsCapture != null) graphicsCapture.Dispose(); graphicsCapture = new GraphicsCaptureBridge(handle, (int)pid,
              isolatedSource ? Convert.ToString(((Dictionary<string,object>)isolatedValue)["token"]) : null);
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
            // Graphics capture already delivers opaque RGB at the requested
            // dimensions. Encode those pixels directly instead of redrawing a
            // second bitmap. WGC/other paths retain their existing conversion.
            bool direct = graphicsMode && source.Width == targetWidth && source.Height == targetHeight;
            using (var resized = direct ? null : new Bitmap(targetWidth, targetHeight)) {
              if (!direct) using (var graphics = Graphics.FromImage(resized)) graphics.DrawImage(source, 0, 0, targetWidth, targetHeight);
              using (var memory = new MemoryStream()) using (var parameters = new EncoderParameters(1)) {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                (direct ? source : resized).Save(memory, ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg"), parameters);
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
      tray = new NotifyIcon { Icon = SettingsForm.ApplicationIcon(), Text = "Codex Wallpaper Bridge", ContextMenuStrip = menu, Visible = true };
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
    static readonly Color Ink = Color.FromArgb(28, 41, 59), Muted = Color.FromArgb(102, 117, 137), Accent = Color.FromArgb(36, 105, 225), Line = Color.FromArgb(224, 230, 239);
    readonly TabControl tabs = new BridgePages(); readonly List<Button> navigation = new List<Button>(); readonly ToolTip hints = new ToolTip(); readonly Label connections = new Label();
    readonly BridgeContext owner; Dictionary<string, object> settings, selectedItem;
    readonly Label status = new Label(), details = new Label(), error = new Label(), updates = new Label(), diagnostics = new Label(), libraryStatus = new Label(), currentWallpaper = new Label();
    readonly CheckBox enabled = new CheckBox(), startup = new CheckBox(), adjust = new CheckBox(), debug = new CheckBox(), candidate = new CheckBox(), frames = new CheckBox();
    readonly ComboBox mode = new ComboBox(), fps = new ComboBox(), libraryType = new ComboBox();
    readonly TrackBar opacity = new TrackBar(), blur = new TrackBar(), brightness = new TrackBar(), contrast = new TrackBar();
    readonly NumericUpDown zoom = new NumericUpDown(), positionX = new NumericUpDown(), positionY = new NumericUpDown();
    readonly TextBox search = new TextBox(); readonly ListView library = new ListView();
    readonly Panel selectionPanel = new Panel(); readonly ImageList covers = new ImageList();
    readonly Dictionary<string, Func<object>> propertyEditors = new Dictionary<string, Func<object>>();
    readonly System.Windows.Forms.Timer searchDelay = new System.Windows.Forms.Timer { Interval = 320 };
    Button installUpdate, refreshLibrary, selectWallpaper, previewWallpaper, closePreview, saveWallpaper, previousPage, nextPage;
    readonly Label pageStatus = new Label(); Dictionary<string, object>[] libraryItems = new Dictionary<string, object>[0];
    const int LibraryPageSize = 120; string libraryWarnings = "", updateVersion; int libraryGeneration, libraryPage; float uiScale = 1; bool initialized, loadingLibrary, previewOpen; public bool AllowClose;

    public SettingsForm(BridgeContext context) {
      owner = context; Text = "Codex Wallpaper Bridge"; Icon = ApplicationIcon(); ClientSize = new Size(1200, 800); MinimumSize = new Size(1040, 720);
      Font = new Font("Microsoft YaHei UI", 10); ForeColor = Ink; BackColor = Color.FromArgb(244, 247, 251); AutoScaleMode = AutoScaleMode.Dpi;
      var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
      shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 172)); shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); Controls.Add(shell);
      var rail = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(18, 29, 46), Padding = new Padding(16, 28, 16, 20), ColumnCount = 1, RowCount = 3, Margin = Padding.Empty };
      rail.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); rail.RowStyles.Add(new RowStyle(SizeType.Absolute, 154)); rail.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); rail.RowStyles.Add(new RowStyle(SizeType.Absolute, 70)); shell.Controls.Add(rail, 0, 0);
      var branding = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = Padding.Empty };
      branding.Controls.Add(new PictureBox { Name = "BrandIcon", Image = Icon.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(44, 44), Margin = new Padding(0, 0, 0, 12) });
      branding.Controls.Add(new Label { Text = "Wallpaper Bridge", AutoSize = true, Font = new Font("Segoe UI", 11, FontStyle.Bold), ForeColor = Color.White, Margin = new Padding(0, 0, 0, 6) });
      branding.Controls.Add(new Label { Text = "你的 Codex，\n你的动态背景。", AutoSize = true, ForeColor = Color.FromArgb(148, 166, 190) }); rail.Controls.Add(branding, 0, 0);
      var nav = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = Padding.Empty }; rail.Controls.Add(nav, 0, 1);
      string[] labels = { "壁纸库", "显示与性能", "状态与维护" };
      for (int index = 0; index < labels.Length; index++) {
        int destination = index; var button = new BridgeButton { Text = labels[index], Size = new Size(140, 46), AutoSize = false, Margin = new Padding(0, 0, 0, 8), Navigation = true, AccessibleName = labels[index] };
        button.Click += delegate { tabs.SelectedIndex = destination; }; nav.Controls.Add(button); navigation.Add(button);
      }
      rail.Controls.Add(new Label { Text = "独立选择 · 始终静音\n版本 " + BridgeShared.BuildInfo.Version, Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomLeft, ForeColor = Color.FromArgb(148, 166, 190), Font = new Font(Font.FontFamily, 9) }, 0, 2);
      var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24, 25, 24, 20), ColumnCount = 1, RowCount = 5, Margin = Padding.Empty }; shell.Controls.Add(root, 1, 0);
      root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
      root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      status.AutoSize = true; status.Font = new Font(Font.FontFamily, 17, FontStyle.Bold); status.Text = "正在检测应用…"; status.Margin = new Padding(0, 0, 0, 7); root.Controls.Add(status, 0, 0);
      details.AutoSize = true; details.MaximumSize = new Size(1000, 0); details.ForeColor = Muted; details.Margin = new Padding(0, 0, 0, 9); root.Controls.Add(details, 0, 1);
      currentWallpaper.AutoSize = true; currentWallpaper.MaximumSize = new Size(1000, 0); currentWallpaper.Margin = new Padding(0, 0, 0, 12); currentWallpaper.Text = "尚未选择 Codex 专用壁纸"; root.Controls.Add(currentWallpaper, 0, 2);
      tabs.Dock = DockStyle.Fill; tabs.Appearance = TabAppearance.FlatButtons; tabs.SizeMode = TabSizeMode.Fixed; tabs.ItemSize = new Size(1, 1); tabs.Padding = Point.Empty; tabs.Margin = Padding.Empty; root.Controls.Add(tabs, 0, 3);
      var libraryTab = new TabPage("壁纸库"); var displayTab = new TabPage("显示与性能"); var maintenanceTab = new TabPage("状态与维护");
      tabs.TabPages.AddRange(new[] { libraryTab, displayTab, maintenanceTab });
      foreach (TabPage page in tabs.TabPages) { page.BackColor = Color.White; page.Padding = new Padding(2); }
      tabs.SelectedIndexChanged += delegate { for (int i = 0; i < navigation.Count; i++) { ((BridgeButton)navigation[i]).Selected = i == tabs.SelectedIndex; navigation[i].Invalidate(); } };
      ((BridgeButton)navigation[0]).Selected = true;
      BuildLibrary(libraryTab); BuildDisplay(displayTab); BuildMaintenance(maintenanceTab);
      error.AutoSize = true; error.MaximumSize = new Size(1000, 0); error.ForeColor = Color.Firebrick; error.Margin = new Padding(0, 10, 0, 0); root.Controls.Add(error, 0, 4);
      root.SizeChanged += delegate { int width = Math.Max(300, root.ClientSize.Width - root.Padding.Horizontal); details.MaximumSize = currentWallpaper.MaximumSize = error.MaximumSize = new Size(width, 0); };
      Shown += async delegate { if (owner != null && library.Items.Count == 0) await LoadLibrary(false); };
      FormClosing += async delegate(object sender, FormClosingEventArgs e) {
        if (!AllowClose) { e.Cancel = true; Hide(); }
        searchDelay.Stop();
        if (previewOpen && owner != null) await ClosePreview();
      };
      float initialScale = CurrentAutoScaleDimensions.Width / 96f; uiScale = initialScale;
      AutoScaleDimensions = new SizeF(96, 96); PerformAutoScale();
      if (Math.Abs(initialScale - 1) > .01) {
        ClientSize = new Size((int)Math.Round(1200 * initialScale), (int)Math.Round(800 * initialScale));
        MinimumSize = new Size((int)Math.Round(1040 * initialScale), (int)Math.Round(720 * initialScale));
      }
      // WinForms can collapse fixed-width combo boxes on an initially hidden DPI-scaled page.
      // Establish their final width after the initial layout has been scaled.
      foreach (var choice in new[] { mode, fps }) {
        choice.MinimumSize = new Size((int)Math.Round(230 * initialScale), 0);
        choice.Width = choice.MinimumSize.Width;
      }
    }

    void BuildLibrary(TabPage page) {
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(12), ColumnCount = 2, RowCount = 5 };
      layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 61)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 39));
      layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
      layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); page.Controls.Add(layout);
      var toolbar = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 4 };
      toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
      toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130)); toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
      toolbar.Controls.Add(new Label { Text = "搜索", AutoSize = true, Padding = new Padding(0, 9, 8, 0) }, 0, 0);
      search.Dock = DockStyle.Fill; search.Margin = new Padding(0, 5, 10, 7); search.MaxLength = 200; toolbar.Controls.Add(search, 1, 0);
      search.AccessibleName = "搜索壁纸"; hints.SetToolTip(search, "按壁纸名称或创意工坊 ID 搜索");
      libraryType.DropDownStyle = ComboBoxStyle.DropDownList; libraryType.Dock = DockStyle.Fill; libraryType.Items.AddRange(new object[] { "全部类型", "视频", "网页", "场景", "应用" }); libraryType.SelectedIndex = 0; libraryType.Margin = new Padding(0, 5, 10, 7); toolbar.Controls.Add(libraryType, 2, 0);
      refreshLibrary = Button("刷新壁纸库", async delegate { await LoadLibrary(true); }); toolbar.Controls.Add(refreshLibrary, 3, 0);
      layout.Controls.Add(toolbar, 0, 0); layout.SetColumnSpan(toolbar, 2);
      covers.ImageSize = new Size(152, 88); covers.ColorDepth = ColorDepth.Depth32Bit;
      library.Dock = DockStyle.Fill; library.View = View.LargeIcon; library.LargeImageList = covers; library.MultiSelect = false; library.HideSelection = false; library.ShowItemToolTips = true; library.Margin = new Padding(0, 0, 18, 0); library.BorderStyle = BorderStyle.None; library.BackColor = Color.White; library.ForeColor = Ink;
      library.SelectedIndexChanged += delegate { if (!loadingLibrary) ShowSelection(); };
      library.HandleCreated += delegate { using (var graphics = library.CreateGraphics()) { int x = (int)Math.Round(176 * graphics.DpiX / 96), y = (int)Math.Round(132 * graphics.DpiY / 96); double coverScale = Math.Min(256.0 / 152, graphics.DpiX / 96); covers.ImageSize = new Size((int)Math.Round(152 * coverScale), (int)Math.Round(88 * coverScale)); SetIconSpacing(library.Handle, 0x1035, IntPtr.Zero, new IntPtr((y << 16) | x)); } };
      library.DoubleClick += async delegate { await SelectWallpaper(); }; layout.Controls.Add(library, 0, 1);
      selectionPanel.Dock = DockStyle.Fill; selectionPanel.AutoScroll = true; selectionPanel.SizeChanged += delegate { ResizeSelection(); }; layout.Controls.Add(selectionPanel, 1, 1);
      var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
      selectWallpaper = Button("设为 Codex 壁纸", async delegate { await SelectWallpaper(); }); previewWallpaper = Button("动态预览", async delegate { await StartPreview(); });
      closePreview = Button("关闭预览", async delegate { await ClosePreview(); }); closePreview.Enabled = false;
      selectWallpaper.Enabled = previewWallpaper.Enabled = false; actions.Controls.AddRange(new Control[] { selectWallpaper, previewWallpaper, closePreview }); layout.Controls.Add(actions, 0, 3);
      ((BridgeButton)selectWallpaper).Primary = true;
      saveWallpaper = Button("保存此壁纸配置", async delegate { await SaveWallpaper(); }); saveWallpaper.Enabled = false; layout.Controls.Add(saveWallpaper, 1, 3);
      ((BridgeButton)saveWallpaper).Primary = true;
      var navigation = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
      previousPage = Button("上一页", async delegate { await ChangeLibraryPage(-1); }); nextPage = Button("下一页", async delegate { await ChangeLibraryPage(1); }); previousPage.Enabled = nextPage.Enabled = false;
      pageStatus.AutoSize = true; pageStatus.Padding = new Padding(0, 12, 8, 0); navigation.Controls.AddRange(new Control[] { previousPage, pageStatus, nextPage }); layout.Controls.Add(navigation, 0, 2);
      libraryStatus.AutoSize = true; libraryStatus.MaximumSize = new Size(980, 0); libraryStatus.ForeColor = Color.DimGray; libraryStatus.Text = "扫描已下载的 Wallpaper Engine 项目，封面仅作静态展示。"; layout.Controls.Add(libraryStatus, 0, 4); layout.SetColumnSpan(libraryStatus, 2);
      search.TextChanged += delegate { searchDelay.Stop(); searchDelay.Start(); };
      search.KeyDown += async delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; searchDelay.Stop(); await LoadLibrary(false); } };
      searchDelay.Tick += async delegate { searchDelay.Stop(); await LoadLibrary(false); };
      libraryType.SelectedIndexChanged += async delegate { searchDelay.Stop(); await LoadLibrary(false); };
      ShowSelection();
    }

    void BuildDisplay(TabPage page) {
      var layout = SettingsLayout(); var host = PageHost(page, layout);
      AddWide(layout, new Label { Text = "背景与效果", AutoSize = true, Font = new Font(Font.FontFamily, 14, FontStyle.Bold) });
      enabled.Text = "启用动态背景"; startup.Text = "随 Windows 登录启动（仅当前用户）"; Add(layout, "常规", enabled); Add(layout, "", startup);
      ConfigureSlider(opacity, 0, 100, 100); ConfigureSlider(blur, 0, 30, 0); ConfigureSlider(brightness, 10, 200, 100); ConfigureSlider(contrast, 10, 200, 100);
      Add(layout, "壁纸不透明度 %", opacity); Add(layout, "模糊 px", blur); Add(layout, "亮度 %", brightness); Add(layout, "对比度 %", contrast);
      mode.DropDownStyle = ComboBoxStyle.DropDownList; mode.Width = 230; mode.Items.AddRange(new object[] { "性能模式", "平衡模式", "画质模式" }); mode.SelectedIndex = 1;
      fps.DropDownStyle = ComboBoxStyle.DropDownList; fps.Width = 230; fps.Items.AddRange(new object[] { "30 FPS", "60 FPS", "120 FPS", "自动" }); fps.SelectedIndex = 1;
      AddWide(layout, new Label { Text = "播放性能", AutoSize = true, Font = new Font(Font.FontFamily, 14, FontStyle.Bold), Padding = new Padding(0, 16, 0, 0) });
      Add(layout, "性能策略", mode); Add(layout, "帧率上限", fps); adjust.Text = "根据实际负载自动调整帧率"; Add(layout, "", adjust);
      AddWide(layout, Note("所有 Codex 窗口使用同一张专用壁纸，始终静音。帧率为同步上限，实际流畅度取决于原生渲染、捕获和系统负载。\n缩放与位置按壁纸分别保存在“壁纸库”中。"));
      var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(18, 0, 18, 12) };
      var apply = Button("保存并应用", async delegate { await Save(); }); ((BridgeButton)apply).Primary = true; buttons.Controls.Add(apply);
      buttons.Controls.Add(Button("重置效果", delegate { opacity.Value = 100; blur.Value = 0; brightness.Value = 100; contrast.Value = 100; }));
      host.Controls.Add(buttons, 0, 1);
    }

    void BuildMaintenance(TabPage page) {
      var layout = SettingsLayout(); var host = PageHost(page, layout);
      AddWide(layout, new Label { Text = "应用连接", AutoSize = true, Font = new Font(Font.FontFamily, 14, FontStyle.Bold) });
      connections.AutoSize = true; connections.ForeColor = Muted; AddWide(layout, connections);
      AddWide(layout, new Label { Text = "高级选项", AutoSize = true, Font = new Font(Font.FontFamily, 12, FontStyle.Bold), Padding = new Padding(0, 14, 0, 0) });
      debug.Text = "Debug 诊断（默认关闭）"; candidate.Text = "允许候选 Codex 适配器（尚未通过实机验收）"; frames.Text = "允许实验性渲染适配（未验证的 Wallpaper Engine 版本）";
      Add(layout, "高级", debug); Add(layout, "", candidate); Add(layout, "", frames);
      var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(18, 0, 18, 12) };
      buttons.Controls.Add(Button("保存高级设置", async delegate { await Save(); }));
      buttons.Controls.Add(Button("恢复官方外观", async delegate { await Post("/restore", new object()); }));
      buttons.Controls.Add(Button("导出诊断", async delegate { if (await Post("/export", new object())) MessageBox.Show("诊断文件位置：\n" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexWallpaperBridge", "diagnostics.json"), Text); }));
      buttons.Controls.Add(Button("以连接模式启动 Codex", async delegate { await Post("/launch", new object()); }));
      buttons.Controls.Add(Button("检查更新", async delegate { await Post("/updates/check", new object()); }));
      buttons.Controls.Add(Button("配置发布源", delegate {
        using (var dialog = new Form { Text = "配置更新发布源", ClientSize = new Size(620, 330), StartPosition = FormStartPosition.CenterParent, Font = Font }) {
          var address = new TextBox { Left = 20, Top = 45, Width = 580 }; var key = new TextBox { Left = 20, Top = 110, Width = 580, Height = 145, Multiline = true, ScrollBars = ScrollBars.Vertical };
          dialog.Controls.Add(new Label { Left = 20, Top = 20, Width = 580, Text = "HTTPS 发布清单地址" }); dialog.Controls.Add(address);
          dialog.Controls.Add(new Label { Left = 20, Top = 82, Width = 580, Text = "发行者 Ed25519 公钥（PEM）；请只配置你信任的发行源。" }); dialog.Controls.Add(key);
          var save = Button("信任此来源并保存", async delegate { if (await Post("/updates/configure", new { confirmed = true, manifestUrl = address.Text.Trim(), publicKeyPem = key.Text.Trim() })) dialog.Close(); });
          save.Location = new Point(390, 275); dialog.Controls.Add(save); dialog.ShowDialog(this);
        }
      }));
      installUpdate = Button("安装更新", async delegate {
        if (String.IsNullOrEmpty(updateVersion)) return;
        if (MessageBox.Show("安装 Bridge " + updateVersion + " 并重新启动？\n设置会保留；失败时自动回滚并关闭背景。", Text, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK) await Post("/updates/install", new { confirmed = true, version = updateVersion });
      }); installUpdate.Enabled = false; buttons.Controls.Add(installUpdate);
      AddWide(layout, new Label { Text = "软件更新", AutoSize = true, Font = new Font(Font.FontFamily, 12, FontStyle.Bold), Padding = new Padding(0, 14, 0, 0) });
      updates.AutoSize = diagnostics.AutoSize = true; updates.MaximumSize = diagnostics.MaximumSize = new Size(930, 0); AddWide(layout, updates); AddWide(layout, diagnostics); host.Controls.Add(buttons, 0, 1);
      AddWide(layout, Note("壁纸库从现有项目读取元数据和封面，原始壁纸资源保持原位。原生属性能否生效取决于项目及 Wallpaper Engine 独立播放接口；不兼容状态会显示在上方。"));
    }

    async Task LoadLibrary(bool rescan) {
      if (owner == null || IsDisposed) return;
      int generation = ++libraryGeneration; refreshLibrary.Enabled = false; libraryStatus.Text = rescan ? "正在重新扫描壁纸库…" : "正在读取壁纸库…";
      string route = "/library?search=" + Uri.EscapeDataString(search.Text.Trim()) + "&type=" + new[] { "", "video", "web", "scene", "application" }[Math.Max(0, libraryType.SelectedIndex)];
      try {
        if (rescan) await owner.Request("POST", "/library/refresh", new object());
        var result = await owner.Request("GET", route, null);
        if (generation != libraryGeneration || IsDisposed) return;
        libraryItems = Rows(Get(result, "items")).OfType<Dictionary<string, object>>().ToArray();
        var scanErrors = Rows(Get(result, "errors")).OfType<Dictionary<string, object>>().Select(item => TextValue(item, "code"));
        libraryWarnings = String.Join("；", Rows(Get(result, "warnings")).Select(Convert.ToString).Concat(scanErrors).Distinct().ToArray());
        await RenderLibraryPage(0, generation);
      } catch (Exception failure) { if (generation == libraryGeneration) { libraryStatus.Text = "壁纸库读取失败，可重新刷新。"; ShowFailure(failure); } }
      finally { if (generation == libraryGeneration && !IsDisposed) refreshLibrary.Enabled = true; }
    }

    async Task ChangeLibraryPage(int direction) {
      if (loadingLibrary) return; int generation = ++libraryGeneration;
      try { await RenderLibraryPage(libraryPage + direction, generation); }
      catch (Exception failure) { ShowFailure(failure); }
      finally { if (generation == libraryGeneration && !IsDisposed) refreshLibrary.Enabled = true; }
    }

    async Task RenderLibraryPage(int page, int generation) {
      int totalPages = Math.Max(1, (libraryItems.Length + LibraryPageSize - 1) / LibraryPageSize);
      libraryPage = Math.Max(0, Math.Min(totalPages - 1, page)); previousPage.Enabled = nextPage.Enabled = false;
      var items = libraryItems.Skip(libraryPage * LibraryPageSize).Take(LibraryPageSize).ToArray();
      var coverSize = covers.ImageSize;
      var thumbnails = await Task.Run(delegate { return items.Select(item => CreateCover(item, coverSize.Width, coverSize.Height)).ToArray(); });
      if (generation != libraryGeneration || IsDisposed) { foreach (var image in thumbnails) image.Dispose(); return; }
        string previous = TextValue(selectedItem, "id"); loadingLibrary = true; library.BeginUpdate();
        try {
          library.Items.Clear(); covers.Images.Clear();
          for (int i = 0; i < items.Length; i++) {
            covers.Images.Add(thumbnails[i]);
            string title = TextValue(items[i], "title"); if (String.IsNullOrEmpty(title)) title = TextValue(items[i], "id");
            var item = new ListViewItem(title + "\n" + TypeName(TextValue(items[i], "type")), i) { Tag = items[i], ToolTipText = title + "\n" + TextValue(items[i], "project") };
            library.Items.Add(item);
            if (TextValue(items[i], "id") == previous || (String.IsNullOrEmpty(previous) && IsCurrent(items[i]))) item.Selected = true;
          }
          // Materialize the native image list before releasing its temporary source bitmaps.
          var imageListHandle = covers.Handle;
        } finally { foreach (var image in thumbnails) image.Dispose(); library.EndUpdate(); loadingLibrary = false; }
        ShowSelection();
        previousPage.Enabled = libraryPage > 0; nextPage.Enabled = libraryPage + 1 < totalPages;
        pageStatus.Text = (libraryPage + 1) + " / " + totalPages;
        libraryStatus.Text = "找到 " + libraryItems.Length + " 张壁纸。" + (libraryItems.Length == 0 ? "可检查 Wallpaper Engine / Steam 安装位置后刷新，或清空搜索与筛选。" : "点击封面查看构图与参数；动态预览独立运行。") + (libraryWarnings == "" ? "" : "\n扫描提示：" + libraryWarnings);
    }

    static Bitmap CreateCover(Dictionary<string, object> item, int coverWidth, int coverHeight) {
      var bitmap = new Bitmap(coverWidth, coverHeight);
      using (var graphics = Graphics.FromImage(bitmap)) {
        graphics.Clear(Color.FromArgb(40, 49, 63));
        try {
          string path = TextValue(item, "preview");
          if (Path.IsPathRooted(path) && File.Exists(path) && new FileInfo(path).Length <= 16 * 1024 * 1024) using (var stream = File.OpenRead(path)) using (var image = Image.FromStream(stream)) {
            if ((long)image.Width * image.Height <= 40000000) {
              double scale = Math.Max((double)coverWidth / image.Width, (double)coverHeight / image.Height); float width = (float)(image.Width * scale), height = (float)(image.Height * scale);
              graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; graphics.DrawImage(image, (coverWidth - width) / 2, (coverHeight - height) / 2, width, height); return bitmap;
            }
          }
        } catch { }
        using (var font = new Font("Microsoft YaHei UI", 13)) using (var brush = new SolidBrush(Color.WhiteSmoke)) using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) graphics.DrawString(TypeName(TextValue(item, "type")), font, brush, new RectangleF(0, 0, coverWidth, coverHeight), format);
      }
      return bitmap;
    }

    void ShowSelection() {
      selectedItem = library.SelectedItems.Count == 0 ? null : library.SelectedItems[0].Tag as Dictionary<string, object>;
      selectWallpaper.Enabled = CanApplySelection(); previewWallpaper.Enabled = CanPreviewSelection(); saveWallpaper.Enabled = selectedItem != null;
      selectionPanel.SuspendLayout();
      try {
        // These three controls persist between selected items; detach them before the old panel is disposed.
        foreach (var control in new Control[] { zoom, positionX, positionY }) if (control.Parent != null) control.Parent.Controls.Remove(control);
        while (selectionPanel.Controls.Count > 0) selectionPanel.Controls[0].Dispose(); propertyEditors.Clear();
        var layout = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Padding = new Padding(0, 0, 7, 0) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, (float)Math.Round(116 * uiScale))); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); selectionPanel.Controls.Add(layout);
        if (selectedItem == null) { AddWide(layout, Note("请选择壁纸。\n默认仅加载封面，点击“动态预览”后才启动原生预览。")); return; }
        var heading = Note(TextValue(selectedItem, "title")); heading.Font = new Font(Font, FontStyle.Bold); heading.ForeColor = ForeColor; AddWide(layout, heading);
        AddWide(layout, Note(TypeName(TextValue(selectedItem, "type")) + " · " + (IsCurrent(selectedItem) ? "正在使用" : "未应用")));
        hints.SetToolTip(heading, TextValue(selectedItem, "project"));
        var nativePlayback = Get(selectedItem, "nativePlayback") as Dictionary<string, object>; string playbackCode = TextValue(nativePlayback, "code");
        string backend = TextValue(selectedItem, "backend");
        if (backend == "wallpaper-engine-isolated" && Get(nativePlayback, "safe") is bool && (bool)nativePlayback["safe"]) AddWide(layout, Note("独立原生渲染 · 静音播放\n保留场景和网页效果，桌面壁纸保持原来的选择与声音设置。"));
        else if (backend == "independent-owned-application") AddWide(layout, Note("独立应用壁纸 · 静音播放\n此版本已验证启动前禁用声音，原始素材保持不变。"));
        else if (backend == "wallpaper-engine-window" && Get(nativePlayback, "safe") is bool && (bool)nativePlayback["safe"]) AddWide(layout, Note("播放方式：Wallpaper Engine 原生渲染 · 已验证无音频输出。"));
        else if (backend == "chromium-muted-video") AddWide(layout, Note("原画质视频 · 静音播放\n直接读取原始文件，保留视频分辨率。"));
        else if (backend == "isolated-muted-web") AddWide(layout, Note("播放方式：兼容网页渲染。需要原生私有接口的项目可能无法显示全部效果。"));
        else if (playbackCode != "") AddWide(layout, Note(PlaybackExplanation(playbackCode) + "\n" + playbackCode));
        if (!CanPreviewSelection() && CanApplySelection()) AddWide(layout, Note("可设为背景；此项目暂不支持独立静音的动态预览。"));
        var profile = Profile(TextValue(selectedItem, "id")); var display = Get(profile, "display") as Dictionary<string, object>;
        ConfigureNumber(zoom, 1, 4, 2, 0.05m, Number(display, "zoom", 1));
        ConfigureNumber(positionX, 0, 100, 1, 1, Number(display, "positionX", 0.5m) * 100);
        ConfigureNumber(positionY, 0, 100, 1, 1, Number(display, "positionY", 0.5m) * 100);
        Add(layout, "额外缩放 ×", zoom); Add(layout, "水平位置 %", positionX); Add(layout, "垂直位置 %", positionY);
        AddWide(layout, Note("默认等比铺满整窗。位置 0% 对齐左 / 上，50% 居中，100% 对齐右 / 下。"));
        var reset = Button("重置构图", delegate { zoom.Value = 1; positionX.Value = positionY.Value = 50; }); AddWide(layout, reset);
        AddWide(layout, new Label { Text = "原生属性", AutoSize = true, Font = new Font(Font, FontStyle.Bold) });
        var saved = Get(profile, "properties") as Dictionary<string, object>; var properties = Rows(Get(selectedItem, "properties")).OfType<Dictionary<string, object>>().ToArray();
        if (properties.Length == 0) AddWide(layout, Note("此项目未提供可调属性。"));
        foreach (var property in properties) AddProperty(layout, property, saved);
        AddWide(layout, Note("配置按壁纸保存。未支持的属性会明确标注；原生项目和播放接口决定可用效果。"));
      } finally { ResizeSelection(); selectionPanel.ResumeLayout(true); }
    }

    void ResizeSelection() {
      if (selectionPanel.Controls.Count == 0) return; var layout = selectionPanel.Controls[0] as TableLayoutPanel; if (layout == null) return;
      int width = Math.Max(180, selectionPanel.ClientSize.Width - SystemInformation.VerticalScrollBarWidth - 10);
      foreach (Control control in layout.Controls) { var label = control as Label; if (label != null) label.MaximumSize = new Size(layout.GetColumnSpan(label) == 2 ? width : Math.Max(80, width - 105), 0); }
    }

    static string PlaybackExplanation(string code) {
      if (code == "ISOLATED_ENGINE_VERSION_UNVERIFIED") return "当前 Wallpaper Engine 版本尚未通过独立原生播放验证。可以使用视频壁纸或兼容网页。";
      if (code == "ISOLATED_ENGINE_UNAVAILABLE") return "尚未找到支持独立原生播放的 Wallpaper Engine 安装。";
      if (code == "SCENE_VIEW_CROSS_VOLUME_UNSUPPORTED") return "当前场景与 Wallpaper Engine 位于不同磁盘，暂无法建立保护原素材的独立运行目录。";
      if (code.Contains("MUTE_UNAVAILABLE")) return "当前原生播放接口尚不能保证独立静音，因此此播放方式不可用。";
      if (code.Contains("SCENE")) return "此场景项目的原生独立播放或捕获能力尚未通过验证。";
      return "此项目的原生独立播放能力尚未通过验证。";
    }

    void AddProperty(TableLayoutPanel layout, Dictionary<string, object> property, Dictionary<string, object> saved) {
      string key = TextValue(property, "key"), label = TextValue(property, "label"), type = TextValue(property, "type").ToLowerInvariant(); if (key == "") return; if (label == "") label = key;
      object value = saved != null && saved.ContainsKey(key) ? saved[key] : Get(property, "value");
      if (Get(property, "supported") is bool && !(bool)property["supported"]) { Add(layout, label, Note("暂不支持此属性")); return; }
      if (type == "file" || type == "directory") {
        var control = new PathPropertyEditor(label, type == "directory", TextValue(property, "filetype"), Convert.ToString(value), saved != null && saved.ContainsKey(key),
          delegate(string selected) { propertyEditors[key] = delegate { return selected; }; }, this, uiScale);
        control.Name = "property-path-" + key; control.PathBox.AccessibleName = label + "路径";
        hints.SetToolTip(control.PathBox, "仅在选择并保存后使用自选路径；未选择时保留项目默认。");
        if (saved != null && saved.ContainsKey(key)) propertyEditors[key] = delegate { return control.PathBox.Text; };
        Add(layout, label, control);
      } else if (type == "bool" || type == "boolean" || type == "checkbox") {
        var control = new CheckBox { Checked = value is bool && (bool)value, AutoSize = true }; Add(layout, label, control); propertyEditors[key] = delegate { return control.Checked; };
      } else if (type == "slider" || type == "number") {
        decimal number = DecimalValue(value, 0), min = Number(property, "min", Math.Min(0, number)), max = Number(property, "max", Math.Max(100, number)); if (max < min) max = min;
        int precision = (int)Math.Max(0, Math.Min(6, Number(property, "precision", 6))); decimal step = Number(property, "step", 0.1m); if (step <= 0) step = 0.1m;
        var control = new NumericUpDown(); ConfigureNumber(control, min, max, precision, step, number); Add(layout, label, control); propertyEditors[key] = delegate { return (double)control.Value; };
      } else if (type == "combo" || type == "select") {
        var control = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
        foreach (var raw in Rows(Get(property, "options"))) {
          var option = raw as Dictionary<string, object>; object optionValue = option == null ? raw : Get(option, "value");
          var choice = new PropertyChoice { Value = optionValue, Text = option == null ? Convert.ToString(raw) : TextValue(option, "label") };
          if (choice.Text == "") choice.Text = Convert.ToString(optionValue); control.Items.Add(choice);
          if (Program.Json.Serialize(optionValue) == Program.Json.Serialize(value)) control.SelectedItem = choice;
        }
        if (control.SelectedIndex < 0) { var choice = new PropertyChoice { Value = value, Text = "当前：" + Convert.ToString(value) }; control.Items.Add(choice); control.SelectedItem = choice; }
        Add(layout, label, control); propertyEditors[key] = delegate { return ((PropertyChoice)control.SelectedItem).Value; };
      } else if (type == "text" || type == "string" || type == "textinput") {
        var control = new TextBox { Text = Convert.ToString(value), Dock = DockStyle.Fill, MaxLength = 4096 }; Add(layout, label, control); propertyEditors[key] = delegate { return control.Text; };
      } else if (type == "color" || type == "colour") {
        var control = new Button { Text = "选择颜色", AutoSize = true, Tag = Convert.ToString(value), UseVisualStyleBackColor = false };
        control.BackColor = ParseColor(Convert.ToString(value)); control.ForeColor = control.BackColor.GetBrightness() < 0.5 ? Color.White : Color.Black;
        control.Click += delegate { using (var dialog = new ColorDialog { Color = control.BackColor, FullOpen = true }) if (dialog.ShowDialog(this) == DialogResult.OK) {
          control.BackColor = dialog.Color; control.ForeColor = dialog.Color.GetBrightness() < 0.5 ? Color.White : Color.Black;
          control.Tag = String.Join(" ", new[] { dialog.Color.R / 255.0, dialog.Color.G / 255.0, dialog.Color.B / 255.0 }.Select(v => v.ToString("0.######", System.Globalization.CultureInfo.InvariantCulture)).ToArray());
        } }; Add(layout, label, control); propertyEditors[key] = delegate { return control.Tag; };
      } else Add(layout, label, Note("暂不支持：" + type));
    }

    // BEGIN PATH_PROPERTY_EDITOR: also compiled in isolation by its own smoke test.
    sealed class PathPropertyEditor : TableLayoutPanel {
      public readonly TextBox PathBox = new TextBox();
      public readonly Button BrowseButton = new Button(), ClearButton = new Button();
      public bool ExplicitSelection { get; private set; }
      readonly Action<string> changed;
      public PathPropertyEditor(string label, bool directory, string fileType, string value, bool saved, Action<string> onChanged, IWin32Window owner, float scale) {
        changed = onChanged; ExplicitSelection = saved; AutoSize = true; Dock = DockStyle.Fill; ColumnCount = 1; RowCount = 2;
        ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); RowStyles.Add(new RowStyle(SizeType.AutoSize)); RowStyles.Add(new RowStyle(SizeType.AutoSize));
        PathBox.Text = value ?? ""; PathBox.ReadOnly = true; PathBox.Dock = DockStyle.Fill; PathBox.BackColor = SystemColors.Window;
        PathBox.Margin = new Padding(0, 0, 0, 3); Controls.Add(PathBox, 0, 0);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Margin = Padding.Empty };
        BrowseButton.Text = directory ? "选择文件夹" : "选择文件"; BrowseButton.AutoSize = true;
        ClearButton.Text = "清除"; ClearButton.AutoSize = true; ClearButton.Enabled = PathBox.Text.Length > 0;
        foreach (Button button in new[] { BrowseButton, ClearButton }) { button.MinimumSize = new Size((int)Math.Round(66 * scale), (int)Math.Round(32 * scale)); button.Margin = new Padding(0, 0, 6, 0); }
        actions.Controls.AddRange(new Control[] { BrowseButton, ClearButton }); Controls.Add(actions, 0, 1);
        BrowseButton.Click += delegate {
          if (directory) {
            using (var dialog = new FolderBrowserDialog { Description = label, ShowNewFolderButton = false }) {
              if (ExplicitSelection && Directory.Exists(PathBox.Text)) dialog.SelectedPath = PathBox.Text;
              if (dialog.ShowDialog(owner) == DialogResult.OK) AcceptSelection(dialog.SelectedPath);
            }
          } else {
            using (var dialog = new OpenFileDialog { Title = label, CheckFileExists = true, CheckPathExists = true, Multiselect = false, RestoreDirectory = true,
              Filter = fileType == "video" ? "视频|*.mp4;*.m4v;*.webm;*.ogg;*.ogv" : fileType == "image" ? "图片|*.jpeg;*.jpg;*.png;*.pnga;*.bmp;*.gif;*.svg;*.webp" :
                "图片和视频|*.jpeg;*.jpg;*.png;*.pnga;*.bmp;*.gif;*.svg;*.webp;*.mp4;*.m4v;*.webm;*.ogg;*.ogv" }) {
              if (ExplicitSelection && File.Exists(PathBox.Text)) dialog.FileName = PathBox.Text;
              if (dialog.ShowDialog(owner) == DialogResult.OK) AcceptSelection(dialog.FileName);
            }
          }
        };
        ClearButton.Click += delegate { AcceptSelection(""); };
      }
      public void AcceptSelection(string value) {
        if (value == null || value.Length > 4096 || value.Any(c => c < 32)) return;
        PathBox.Text = value; ExplicitSelection = true; ClearButton.Enabled = value.Length > 0;
        if (changed != null) changed(value);
      }
    }
    // END PATH_PROPERTY_EDITOR

    static Color ParseColor(string value) {
      try {
        var values = value.Split(new[] { ' ', ',' }, StringSplitOptions.RemoveEmptyEntries).Select(v => Double.Parse(v, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        if (values.Length >= 3) return Color.FromArgb((int)Math.Round(Math.Max(0, Math.Min(1, values[0])) * 255), (int)Math.Round(Math.Max(0, Math.Min(1, values[1])) * 255), (int)Math.Round(Math.Max(0, Math.Min(1, values[2])) * 255));
      } catch { } return Color.White;
    }

    async Task SelectWallpaper() {
      if (selectedItem == null) return; selectWallpaper.Enabled = false;
      try { await Post("/wallpaper/select", new { id = TextValue(selectedItem, "id") }); } finally { if (!IsDisposed) selectWallpaper.Enabled = CanApplySelection(); }
    }
    async Task StartPreview() {
      if (selectedItem == null || owner == null) return; previewWallpaper.Enabled = false;
      try { error.Text = ""; await owner.Request("POST", "/wallpaper/preview", new { id = TextValue(selectedItem, "id") }); previewOpen = true; closePreview.Enabled = true; }
      catch (Exception failure) { ShowFailure(failure); } finally { if (!IsDisposed) previewWallpaper.Enabled = CanPreviewSelection(); }
    }
    async Task ClosePreview() {
      if (owner == null) return;
      try { await owner.Request("POST", "/wallpaper/preview/close", new object()); previewOpen = false; if (!IsDisposed) closePreview.Enabled = false; }
      catch (Exception failure) { if (!IsDisposed) ShowFailure(failure); }
    }
    bool CanApplySelection() { return selectedItem != null && new[] { "chromium-muted-video", "wallpaper-engine-window", "wallpaper-engine-isolated", "isolated-muted-web", "independent-owned-application" }.Contains(TextValue(selectedItem, "backend")); }
    bool CanPreviewSelection() { var native = Get(selectedItem, "nativePlayback") as Dictionary<string, object>; return Get(native, "safe") is bool && (bool)native["safe"]; }
    async Task SaveWallpaper() {
      if (selectedItem == null || settings == null) return; saveWallpaper.Enabled = false;
      var values = new Dictionary<string, object>(); var profile = Profile(TextValue(selectedItem, "id")); var previous = Get(profile, "properties") as Dictionary<string, object>;
      if (previous != null) foreach (var item in previous) values[item.Key] = item.Value;
      foreach (var editor in propertyEditors) values[editor.Key] = editor.Value();
      try { await Post("/wallpaper/configure", new { id = TextValue(selectedItem, "id"), display = new { zoom = (double)zoom.Value, positionX = (double)positionX.Value / 100, positionY = (double)positionY.Value / 100 }, properties = values }); }
      finally { if (!IsDisposed) saveWallpaper.Enabled = selectedItem != null; }
    }

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true)] static extern IntPtr SetIconSpacing(IntPtr window, int message, IntPtr parameter, IntPtr value);
    sealed class BridgePages : TabControl { public override Rectangle DisplayRectangle { get { return ClientRectangle; } } }
    sealed class BridgeButton : Button {
      public bool Primary, Navigation, Selected; bool hover;
      public BridgeButton() { FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand; SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true); }
      protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
      protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
      protected override void OnPaint(PaintEventArgs e) {
        if (SystemInformation.HighContrast) { base.OnPaint(e); return; }
        e.Graphics.Clear(Parent == null ? Color.White : Parent.BackColor); e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        Color fill = Navigation ? (Selected ? Color.FromArgb(38, 62, 96) : hover ? Color.FromArgb(27, 43, 65) : Color.FromArgb(18, 29, 46)) : Primary ? (hover ? Color.FromArgb(25, 88, 201) : Accent) : hover ? Color.FromArgb(239, 245, 255) : Color.White;
        Color ink = Navigation ? (Selected ? Color.White : Color.FromArgb(181, 196, 215)) : Primary ? Color.White : Ink;
        if (!Enabled) { fill = Color.FromArgb(241, 244, 248); ink = Color.FromArgb(157, 168, 184); }
        var box = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1)); int curve = Math.Max(6, Math.Min(16, Height / 3));
        using (var shape = new System.Drawing.Drawing2D.GraphicsPath()) {
          shape.AddArc(box.Left, box.Top, curve, curve, 180, 90); shape.AddArc(box.Right - curve, box.Top, curve, curve, 270, 90);
          shape.AddArc(box.Right - curve, box.Bottom - curve, curve, curve, 0, 90); shape.AddArc(box.Left, box.Bottom - curve, curve, curve, 90, 90); shape.CloseFigure();
          using (var brush = new SolidBrush(fill)) e.Graphics.FillPath(brush, shape);
          if (!Navigation && !Primary) using (var pen = new Pen(Line)) e.Graphics.DrawPath(pen, shape);
        }
        var textBox = new Rectangle(Navigation ? 16 : 5, 0, Math.Max(1, Width - (Navigation ? 24 : 10)), Height);
        TextRenderer.DrawText(e.Graphics, Text, Font, textBox, ink, TextFormatFlags.VerticalCenter | (Navigation ? TextFormatFlags.Left : TextFormatFlags.HorizontalCenter) | TextFormatFlags.EndEllipsis);
        if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(box, -5, -5), ink, fill);
      }
    }
    Button Button(string text, EventHandler action) { var b = new BridgeButton { Text = text, AutoSize = true, MinimumSize = new Size((int)Math.Round(70 * uiScale), (int)Math.Round(36 * uiScale)), Padding = new Padding((int)Math.Round(10 * uiScale), (int)Math.Round(6 * uiScale), (int)Math.Round(10 * uiScale), (int)Math.Round(6 * uiScale)), Margin = new Padding(0, 5, 8, 5) }; b.Click += action; return b; }
    static Label Note(string text) { return new Label { Text = text, AutoSize = true, MaximumSize = new Size(850, 0), ForeColor = Muted, Dock = DockStyle.Fill }; }
    static TableLayoutPanel PageHost(TabPage page, Control content) {
      var host = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
      host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); host.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); host.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      page.Controls.Add(host); host.Controls.Add(content, 0, 0); return host;
    }
    static TableLayoutPanel SettingsLayout() {
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(18), ColumnCount = 2 };
      layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 165)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
      layout.SizeChanged += delegate { int width = Math.Max(300, layout.ClientSize.Width - layout.Padding.Horizontal - SystemInformation.VerticalScrollBarWidth); foreach (Control control in layout.Controls) { var label = control as Label; if (label != null && layout.GetColumnSpan(label) == 2) label.MaximumSize = new Size(width, 0); } };
      return layout;
    }
    static void ConfigureSlider(TrackBar slider, int min, int max, int value) { slider.Minimum = min; slider.Maximum = max; slider.Value = value; slider.TickStyle = TickStyle.None; slider.AutoSize = false; slider.Dock = DockStyle.Fill; slider.Height = 34; }
    void ConfigureNumber(NumericUpDown control, decimal min, decimal max, int decimals, decimal increment, decimal value) { control.Minimum = min; control.Maximum = max; control.DecimalPlaces = decimals; control.Increment = increment; control.Value = Math.Max(min, Math.Min(max, value)); control.Width = (int)Math.Round(130 * uiScale); }
    static void Add(TableLayoutPanel layout, string text, Control control) {
      int row = layout.RowCount++; layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.Controls.Add(new Label { Text = text, AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(0, 11, 7, 0) }, 0, row);
      if (control is CheckBox || control is Label) control.AutoSize = true; control.Margin = new Padding(0, 6, 0, 6);
      var slider = control as TrackBar;
      if (slider != null) {
        var group = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2, Margin = Padding.Empty };
        group.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); group.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        string unit = text.Contains("%") ? "%" : text.Contains("px") ? " px" : "";
        var value = new Label { Text = slider.Value + unit, AutoSize = true, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight, ForeColor = Accent };
        slider.ValueChanged += delegate { value.Text = slider.Value + unit; }; group.Controls.Add(slider, 0, 0); group.Controls.Add(value, 1, 0); layout.Controls.Add(group, 1, row);
      } else { if (control is ComboBox) ((ComboBox)control).FlatStyle = FlatStyle.Flat; if (control is TextBox) ((TextBox)control).BorderStyle = BorderStyle.FixedSingle; layout.Controls.Add(control, 1, row); }
    }
    static void AddWide(TableLayoutPanel layout, Control control) { int row = layout.RowCount++; layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); control.Margin = new Padding(0, 0, 0, 12); layout.Controls.Add(control, 0, row); layout.SetColumnSpan(control, 2); }
    static object Get(Dictionary<string, object> row, string key) { object value; return row != null && row.TryGetValue(key, out value) ? value : null; }
    static string TextValue(Dictionary<string, object> row, string key) { return Convert.ToString(Get(row, key)); }
    static IEnumerable<object> Rows(object value) { var rows = value as System.Collections.IEnumerable; if (rows == null || value is string) yield break; foreach (var row in rows) yield return row; }
    static decimal DecimalValue(object value, decimal fallback) { try { return value == null ? fallback : Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture); } catch { return fallback; } }
    static decimal Number(Dictionary<string, object> row, string key, decimal fallback) { return DecimalValue(Get(row, key), fallback); }
    static string TypeName(string type) { switch (type) { case "video": return "视频"; case "web": return "网页"; case "scene": return "场景"; case "application": return "应用"; default: return type == "" ? "未知类型" : type; } }
    Dictionary<string, object> Profile(string id) { return Get(Get(settings, "wallpaperProfiles") as Dictionary<string, object>, id) as Dictionary<string, object>; }
    bool IsCurrent(Dictionary<string, object> item) { return String.Equals(TextValue(settings, "selectedWallpaper"), TextValue(item, "project"), StringComparison.OrdinalIgnoreCase); }
    sealed class PropertyChoice { public object Value; public string Text; public override string ToString() { return Text; } }
    public static Icon ApplicationIcon() { try { return System.Drawing.Icon.ExtractAssociatedIcon(Program.Executable) ?? SystemIcons.Application; } catch { return SystemIcons.Application; } }
    public void ShowError(string text) { error.Text = text; }
    public string StatusText { get { return status.Text; } }
    public void RefreshSettings(Dictionary<string, object> row) { initialized = false; SetStatus(row); }

    public void SetStatus(Dictionary<string, object> row) {
      var state = TextValue(row, "state"); var names = new Dictionary<string, string> { { "Disabled", "背景已关闭" }, { "Active", "独立壁纸已连接" }, { "WaitingForApps", "正在等待应用连接" }, { "LoadingWallpaper", "正在准备新壁纸" }, { "Recovering", "正在恢复连接" }, { "Incompatible", "当前适配尚未验证或不兼容" }, { "Paused", "背景已暂停" } };
      status.Text = names.ContainsKey(state) ? names[state] : state;
      var source = Get(row, "source") as Dictionary<string, object>; var policy = Get(row, "policy") as Dictionary<string, object>; string code = TextValue(row, "code"), explanation = "";
      if (code == "CODEX_CONNECTION_REQUIRED") explanation = "点击“以连接模式启动 Codex”打开独立窗口；首次可能需要登录。现有 Codex 窗口可以保留。";
      else if (code == "WALLPAPER_SELECTION_REQUIRED" || code == "NO_WALLPAPER_SELECTED") explanation = "请在“壁纸库”选择 Codex 专用壁纸。";
      else if (code == "WAITING_FOR_WALLPAPER_ENGINE") explanation = "正在等待 Wallpaper Engine 原生播放连接。";
      else if (code == "CODEX_ADAPTER_UNVERIFIED") explanation = "当前 Codex 版本尚未完成实机验收，可在高级选项中启用候选适配器进行开发验证。";
      else if (code.Contains("NATIVE_") || code.Contains("SCENE_")) explanation = PlaybackExplanation(code);
      else if (code.Contains("NEEDS_RENDERER") || code.Contains("RENDER_SURFACE")) explanation = "当前项目的动态画面接入尚未验证；可更换项目或导出诊断。";
      else if (state == "Incompatible") explanation = "当前项目或播放接口未通过验证。可更换壁纸，或导出诊断查看原因。";
      else if (state == "Recovering") explanation = "背景暂时无法加载，正在尝试恢复连接。";
      if (debug.Checked && code != "") explanation += "\n" + code;
      status.ForeColor = state == "Active" ? Color.FromArgb(24, 126, 105) : state == "Incompatible" || state == "Recovering" ? Color.FromArgb(169, 100, 26) : Ink;
      var appStatus = Get(row, "apps") as Dictionary<string, object>; var engineStatus = Get(appStatus, "wallpaperEngine") as Dictionary<string, object>;
      connections.Text = "Codex   ·   " + Get(row, "windowCount") + " 个窗口已连接\nWallpaper Engine   ·   " + (Get(engineStatus, "running") is bool && (bool)engineStatus["running"] ? "运行中" : "未检测到运行实例");
      details.Text = (source == null ? "等待选择壁纸" : TypeName(TextValue(source, "type")) + "壁纸") + "   ·   已连接 " + Get(row, "windowCount") + " 个窗口   ·   帧率上限 " + Get(policy, "fps") + " FPS" + (explanation == "" ? "" : "\n" + explanation);
      var update = Get(row, "updates") as Dictionary<string, object>; updateVersion = TextValue(update, "version"); string updateState = update == null ? "NotConfigured" : TextValue(update, "status");
      var updateNames = new Dictionary<string, string> { { "NotConfigured", "尚未配置发布源" }, { "Idle", "自动检查已开启" }, { "AwaitingConfirmation", "有可用更新 " + updateVersion }, { "UpToDate", "当前已是最新版本" }, { "Downloading", "正在校验下载" }, { "CheckFailed", "暂时无法检查，请稍后重试" }, { "Installing", "正在安装，Bridge 将重新启动" }, { "Staged", "更新已下载" } };
      updates.Text = "Bridge " + Get(row, "version") + " · " + (updateNames.ContainsKey(updateState) ? updateNames[updateState] : updateState); installUpdate.Enabled = updateState == "AwaitingConfirmation";
      diagnostics.Visible = debug.Checked; diagnostics.Text = debug.Checked ? "诊断：\n" + Program.Json.Serialize(new { apps = Get(row, "apps"), metrics = Get(row, "metrics"), adapter = Get(row, "adapter"), retry = Get(row, "retry"), source = source, windows = Get(row, "windows"), modules = Get(row, "modules") }) : "";
      var incomingSettings = Get(row, "settings") as Dictionary<string, object>;
      string selectedPath = TextValue(incomingSettings, "selectedWallpaper");
      var currentItem = libraryItems.FirstOrDefault(item => String.Equals(TextValue(item, "project"), selectedPath, StringComparison.OrdinalIgnoreCase));
      string selectedTitle = TextValue(currentItem, "title"); if (selectedTitle == "" && selectedPath != "") { try { selectedTitle = Path.GetFileName(Path.GetDirectoryName(selectedPath)); } catch { selectedTitle = "已选择的壁纸"; } }
      currentWallpaper.Text = selectedPath == "" ? "尚未选择 Codex 专用壁纸" : "当前壁纸  ·  " + selectedTitle + "  ·  始终静音"; currentWallpaper.ForeColor = Muted; hints.SetToolTip(currentWallpaper, selectedPath);
      if (initialized || incomingSettings == null) return;
      settings = incomingSettings; var effects = Get(settings, "effects") as Dictionary<string, object>;
      enabled.Checked = Get(settings, "enabled") is bool && (bool)settings["enabled"]; startup.Checked = Get(settings, "startup") is bool && (bool)settings["startup"]; adjust.Checked = Get(settings, "autoAdjust") is bool && (bool)settings["autoAdjust"];
      debug.Checked = Get(settings, "debug") is bool && (bool)settings["debug"]; candidate.Checked = Get(settings, "allowCandidateAdapter") is bool && (bool)settings["allowCandidateAdapter"]; frames.Checked = Get(settings, "experimentalWindowFrames") is bool && (bool)settings["experimentalWindowFrames"];
      mode.SelectedIndex = Math.Max(0, Array.IndexOf(new[] { "performance", "balanced", "quality" }, TextValue(settings, "performance")));
      fps.SelectedIndex = Array.IndexOf(new[] { 30, 60, 120, 0 }, (int)Number(settings, "fpsLimit", 60)); if (fps.SelectedIndex < 0) fps.SelectedIndex = 1;
      SetSlider(opacity, Number(effects, "opacity", 1) * 100); SetSlider(blur, Number(effects, "blur", 0)); SetSlider(brightness, Number(effects, "brightness", 1) * 100); SetSlider(contrast, Number(effects, "contrast", 1) * 100);
      initialized = true; if (selectedItem != null) ShowSelection();
    }
    static void SetSlider(TrackBar slider, decimal value) { slider.Value = Math.Max(slider.Minimum, Math.Min(slider.Maximum, (int)Math.Round(value))); }

    async Task Save() {
      if (settings == null || owner == null) return;
      // Read the current server copy so global controls never overwrite a newly selected wallpaper or its profiles.
      try {
        var latest = await owner.Request("GET", "/status", null); var value = Get(latest, "settings") as Dictionary<string, object>; if (value == null) return;
        value["enabled"] = enabled.Checked; value["startup"] = startup.Checked; value["autoAdjust"] = adjust.Checked; value["debug"] = debug.Checked; value["allowCandidateAdapter"] = candidate.Checked; value["experimentalWindowFrames"] = frames.Checked;
        value["performance"] = new[] { "performance", "balanced", "quality" }[Math.Max(0, mode.SelectedIndex)]; value["fpsLimit"] = new[] { 30, 60, 120, 0 }[Math.Max(0, fps.SelectedIndex)];
        value["effects"] = new { opacity = opacity.Value / 100.0, blur = blur.Value, brightness = brightness.Value / 100.0, contrast = contrast.Value / 100.0 }; await Post("/settings", value);
      } catch (Exception failure) { ShowFailure(failure); }
    }
    async Task<bool> Post(string route, object body) {
      if (owner == null) return false;
      try { error.Text = ""; await owner.Request("POST", route, body); RefreshSettings(await owner.Request("GET", "/status", null)); return true; }
      catch (Exception failure) { ShowFailure(failure); return false; }
    }
    void ShowFailure(Exception failure) {
      string message = "操作失败，请检查连接或导出诊断。"; var web = failure as WebException;
      if (web != null && web.Response != null) using (web.Response) using (var reader = new StreamReader(web.Response.GetResponseStream())) {
          try { var row = Program.Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd()); string code = TextValue(row, "error"); if (code != "") message += "\n" + ((code.Contains("NATIVE_") || code.Contains("SCENE_")) ? PlaybackExplanation(code) + "\n" : "") + code; } catch { }
      }
      ShowError(message);
    }
    protected override void Dispose(bool disposing) { if (disposing) { searchDelay.Dispose(); covers.Dispose(); hints.Dispose(); zoom.Dispose(); positionX.Dispose(); positionY.Dispose(); } base.Dispose(disposing); }
  }

}
