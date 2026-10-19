using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Text;

namespace BridgeSetup {
  static class Program {
    const string Identity = "CodexWallpaperBridge/1";
    static string Programs, Target, Launcher, Data, MenuLink, DesktopLink, UninstallLink;
    static string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexWallpaperBridge";
    static string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static bool portable = false;
    static string operation = "START";
    static string Option(string[] args, string name) {
      int at = Array.IndexOf(args, name); if (at < 0) return null;
      if (at + 1 >= args.Length || args[at + 1].StartsWith("--")) throw new Exception("缺少参数：" + name);
      return args[at + 1];
    }
    static bool Same(string a, string b) { return String.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
    static void Initialize(string[] args) {
#if BRIDGE_SETUP_TEST
      // This branch is absent from shipped binaries. Never signal or register against a user's installation in fixture tests.
      string fixture = Environment.GetEnvironmentVariable("BRIDGE_SETUP_FIXTURE_ROOT");
      if (String.IsNullOrWhiteSpace(fixture) || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(fixture), "^BridgeUninstallFixture-[a-f0-9]{32}$") ||
          File.ReadAllText(Path.Combine(fixture, ".bridge-test-fixture")) != "CodexWallpaperBridge/TestFixture/1") throw new Exception("TEST_FIXTURE_REQUIRED");
      Plain(fixture); fixture = Path.GetFullPath(fixture);
      Programs = Path.Combine(fixture, "Programs"); Data = Path.Combine(fixture, "Data");
      UninstallKey = @"Software\CodexWallpaperBridge\TestFixtures\" + Path.GetFileName(fixture) + @"\Uninstall";
      RunKey = @"Software\CodexWallpaperBridge\TestFixtures\" + Path.GetFileName(fixture) + @"\Run";
      MenuLink = Path.Combine(fixture, "StartMenu", "Codex Wallpaper Bridge.lnk");
      UninstallLink = Path.Combine(fixture, "StartMenu", "卸载 Codex Wallpaper Bridge.lnk");
      DesktopLink = Path.Combine(fixture, "Desktop", "Codex Wallpaper Bridge.lnk");
#else
      Programs = BridgeShared.KnownPaths.Directory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"));
      Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexWallpaperBridge");
      MenuLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Codex Wallpaper Bridge.lnk");
      UninstallLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "卸载 Codex Wallpaper Bridge.lnk");
      DesktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Codex Wallpaper Bridge.lnk");
#endif
      Target = Path.Combine(Programs, "CodexWallpaperBridge"); Launcher = Path.Combine(Programs, "CodexWallpaperBridge.Launcher.exe");
#if BRIDGE_UNINSTALL
      string selected = Option(args, "--portable-root");
      string local = Path.GetDirectoryName(Application.ExecutablePath);
      if (selected == null && File.Exists(Path.Combine(local, ".bridge-owned"))) selected = local;
      // A damaged portable package must never fall back to uninstalling a different installed copy.
      if (selected == null && String.Equals(Path.GetFileName(Application.ExecutablePath), "Uninstall.exe", StringComparison.OrdinalIgnoreCase) &&
          !args.Contains("--remove-installed") && !args.Contains("--remove-installed-silent")) selected = local;
      if (selected != null && !Same(selected, Target)) {
        Target = Path.GetFullPath(selected).TrimEnd('\\'); portable = true; Plain(Target);
        if (Path.GetPathRoot(Target) == Target || new DirectoryInfo(Target).Parent == null) throw new Exception("便携目录无效。");
      }
#endif
    }
    [STAThread] static int Main(string[] args) {
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      try {
        Initialize(args);
        if (Option(args, "--wait-parent") != null) {
          int parentId = Int32.Parse(Option(args, "--wait-parent"));
          try { using (var parent = Process.GetProcessById(parentId)) if (!parent.WaitForExit(15000)) throw new Exception("卸载入口仍被占用，请重试。"); } catch (ArgumentException) { }
        }
#if BRIDGE_UNINSTALL
        if (args.Contains("--install-silent") || args.Contains("--verify-payload")) throw new Exception("这是独立卸载程序，请运行安装包进行安装。");
        bool quiet = args.Contains("--silent") || args.Contains("--remove-installed-silent");
        if (!quiet && !args.Contains("--remove-installed") && MessageBox.Show("卸载 Codex Wallpaper Bridge？\nBridge 会先退出并恢复外观。设置、登录资料、日志、用户新增文件及原始壁纸会保留。", "Codex Wallpaper Bridge", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return 0;
        if (!RelocateUninstaller(args, quiet)) RemoveInstalled(quiet);
        return 0;
#else
        if (args.Contains("--install-silent")) { Install(false,false); return 0; }
        if (args.Contains("--remove-installed-silent")) { RemoveInstalled(true); return 0; }
        if (args.Contains("--verify-payload")) { VerifyPayload(); return 0; }
        if (args.Contains("--remove-installed")) { RemoveInstalled(); return 0; }
        if (args.Contains("--uninstall")) {
          string tool = Path.Combine(Target, "Uninstall.exe"); Plain(tool);
          if (!File.Exists(tool)) throw new Exception("未找到卸载入口，请运行独立卸载程序。");
          Process.Start(new ProcessStartInfo(tool, "--uninstall") { UseShellExecute = false, CreateNoWindow = true }); return 0;
        }
        Application.Run(new SetupForm()); return 0;
#endif
      } catch (Exception error) {
        if(args.Contains("--install-silent") || args.Contains("--remove-installed-silent") || args.Contains("--silent")){Console.Error.WriteLine("SETUP_ACTION_FAILED_"+operation+"_"+error.GetType().Name+"_"+unchecked((uint)error.HResult).ToString("X8"));return 1;}
        if (args.Contains("--verify-payload")) return 1;
        MessageBox.Show("操作未完成：" + error.Message, "Codex Wallpaper Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
      } finally { try { ScheduleTemporaryCleanup(Option(args, "--cleanup-root")); } catch { } }
    }
    static string Quote(string value) { if (value.IndexOf('"') >= 0) throw new Exception("参数路径无效。"); return "\"" + value + "\""; }
    static bool RelocateUninstaller(string[] args, bool quiet) {
      if (!Application.ExecutablePath.StartsWith(Target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return false;
      var root = Path.Combine(Path.GetTempPath(), "CodexWallpaperBridge-Uninstall-" + Guid.NewGuid().ToString("N")); Plain(root); Directory.CreateDirectory(root);
      var copy = Path.Combine(root, "Uninstall.exe"); File.Copy(Application.ExecutablePath, copy);
      string arguments = (quiet ? "--remove-installed-silent" : "--remove-installed") + " --wait-parent " + Process.GetCurrentProcess().Id + " --cleanup-root " + Quote(root);
      if (portable) arguments += " --portable-root " + Quote(Target);
      try { Process.Start(new ProcessStartInfo(copy, arguments) { UseShellExecute = false, CreateNoWindow = true }); }
      catch { File.Delete(copy); Directory.Delete(root); throw; }
      return true;
    }
    static void ScheduleTemporaryCleanup(string root) {
      if (root == null) return;
      try {
        root = Path.GetFullPath(root); string executable = Path.Combine(root, "Uninstall.exe");
        if (!Same(Path.GetDirectoryName(root), Path.GetTempPath()) || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(root), "^CodexWallpaperBridge-Uninstall-[a-f0-9]{32}$") || !Same(Application.ExecutablePath, executable)) return;
        Plain(root); Plain(executable);
        // A hidden helper removes only this generated EXE and its now-empty temporary directory after the worker exits.
        string literalRoot = "'" + root.Replace("'", "''") + "'", literalFile = "'" + executable.Replace("'", "''") + "'";
        string script = "$ErrorActionPreference='Stop'; $workerId=" + Process.GetCurrentProcess().Id + "; $workerStart=" + Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks + "; $worker=Get-Process -Id $workerId -ErrorAction SilentlyContinue; if($worker -and $worker.StartTime.ToUniversalTime().Ticks -eq $workerStart){$worker.WaitForExit()}; for($attempt=0;$attempt -lt 50;$attempt++){try{Remove-Item -LiteralPath " + literalFile + " -Force -ErrorAction Stop; break}catch{Start-Sleep -Milliseconds 100}}; if((Test-Path -LiteralPath " + literalRoot + ") -and @(Get-ChildItem -LiteralPath " + literalRoot + " -Force).Count -eq 0){Remove-Item -LiteralPath " + literalRoot + " -ErrorAction Stop}";
        Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script))) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
      } catch { /* Only temporary cleanup may be deferred; no product or user path is delegated. */ }
    }
    static void Plain(string path) {
      for (var item = new DirectoryInfo(path); item != null; item = item.Parent)
        if (item.Exists && (item.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception("路径含重定向目录。");
      if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("路径含重定向文件。");
    }
    static void CheckPath(string fullPath) {
      var path = Path.GetFullPath(fullPath);
      if (!path.StartsWith(Path.GetFullPath(Programs) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("安装路径超出当前用户 Programs 目录。");
      for (var current = new DirectoryInfo(path); current != null; current = current.Parent)
        if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception("安装路径含重定向目录，请选择普通用户目录。");
    }
    static void StopBridge() {
#if BRIDGE_SETUP_TEST
      return;
#else
      string expected = Path.Combine(Target, "CodexWallpaperBridge.exe"); bool selectedRunning = false;
      foreach (var proc in Process.GetProcessesByName("CodexWallpaperBridge")) using (proc)
        try { if (String.Equals(proc.MainModule.FileName, expected, StringComparison.OrdinalIgnoreCase)) selectedRunning = true; } catch { }
      if (!selectedRunning) return;
      try { using (var signal = EventWaitHandle.OpenExisting("Local\\CodexWallpaperBridge.Stop-" + Environment.UserName)) signal.Set(); } catch (WaitHandleCannotBeOpenedException) { }
      var file = Path.Combine(Target, "CodexWallpaperBridge.exe");
      for (int attempt = 0; attempt < 60; attempt++) {
        bool running = false;
        foreach (var proc in Process.GetProcessesByName("CodexWallpaperBridge")) using (proc) {
          try { if (String.Equals(proc.MainModule.FileName, file, StringComparison.OrdinalIgnoreCase)) running = true; } catch { }
        }
        if (!running) return; Thread.Sleep(200);
      }
      throw new Exception("请先从托盘退出 Bridge，等待恢复外观后重试。");
#endif
    }
    static List<string> Extract(string root, bool write) {
      var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long total = 0;
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Bridge.Payload.zip")) {
        if (stream == null) throw new Exception("缺少安装数据。");
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read)) {
          if (archive.Entries.Count > 1000) throw new Exception("安装文件过多。");
          foreach (var entry in archive.Entries) {
            var name = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            if (String.IsNullOrWhiteSpace(name) || name.Contains(':') || Path.IsPathRooted(name) || name.TrimEnd(Path.DirectorySeparatorChar).Split(Path.DirectorySeparatorChar).Any(p => p == ".." || p == "." || p.Length==0 || p.IndexOfAny(Path.GetInvalidFileNameChars())>=0 || p.EndsWith(".") || p.EndsWith(" ") || System.Text.RegularExpressions.Regex.IsMatch(p,"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase)) ||
              ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000) throw new Exception("安装文件路径无效。");
            if (name.EndsWith(Path.DirectorySeparatorChar.ToString())) continue;
            var target = Path.GetFullPath(Path.Combine(root, name));
            if (!target.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !names.Add(name)) throw new Exception("重复或越界路径。");
            total += entry.Length; if (entry.Length > 200L * 1024 * 1024 || total > 400L * 1024 * 1024) throw new Exception("安装数据超出限制。");
            if (write) { Directory.CreateDirectory(Path.GetDirectoryName(target)); entry.ExtractToFile(target); }
          }
        }
      }
      foreach (var required in new[] { "CodexWallpaperBridge.exe", "BridgeArchive.exe", "BridgeLauncher.exe", "BridgeGraphicsHook.dll", "Uninstall.exe", "node.exe", @"src\main.mjs", @"config\adapter.json", @"config\wallpaper-engine.json" })
        if (!names.Contains(required)) throw new Exception("安装文件不完整。");
      return names.ToList();
    }
    static void VerifyPayload() { Extract(Path.Combine(Programs, "PayloadVerification"), false); }
    internal static void Install(bool desktop, bool startup) {
      using(var lease=new BridgeShared.InstallLease()) {
      CheckPath(Target); Directory.CreateDirectory(Programs);
      if (Directory.Exists(Target) && (!File.Exists(Path.Combine(Target, ".bridge-owned")) || File.ReadAllText(Path.Combine(Target, ".bridge-owned")) != Identity))
        throw new Exception("目标目录不属于 Bridge，未进行覆盖。");
      StopBridge();
      CheckPath(Launcher);
      if (File.Exists(Launcher) && (File.GetAttributes(Launcher) & FileAttributes.ReparsePoint) != 0) throw new Exception("稳定启动入口含重定向。");
      if (File.Exists(Launcher) && FileVersionInfo.GetVersionInfo(Launcher).ProductName != "CodexWallpaperBridge.Launcher/1") throw new Exception("稳定启动入口已有其他文件，未覆盖。");
      var previousLauncher = File.Exists(Launcher) ? File.ReadAllBytes(Launcher) : null;
      string staging = Target + ".staging-" + Guid.NewGuid().ToString("N"), backup = Target + ".previous-" + Guid.NewGuid().ToString("N");
      CheckPath(staging); CheckPath(backup); bool moved = false, activated = false;
      var priorRegistration = new Dictionary<string, object>();
      using (var prior = Registry.CurrentUser.OpenSubKey(UninstallKey))
        if (prior != null) foreach (var name in prior.GetValueNames()) priorRegistration[name] = prior.GetValue(name);
      string previousStartup = null;
      using (var prior = Registry.CurrentUser.OpenSubKey(RunKey))
        if (prior != null) previousStartup = prior.GetValue("CodexWallpaperBridge") as string;
      string menuLink = MenuLink, desktopLink = DesktopLink;
      bool hadMenuLink = File.Exists(menuLink), hadDesktopLink = File.Exists(desktopLink), hadUninstallLink = File.Exists(UninstallLink);
      try {
        Directory.CreateDirectory(staging); var files = Extract(staging, true);
        File.WriteAllText(Path.Combine(staging, ".bridge-owned"), Identity);
        File.WriteAllLines(Path.Combine(staging, "installed-files.txt"), files.Concat(new[] { ".bridge-owned" }).Distinct(StringComparer.OrdinalIgnoreCase));
        if (Directory.Exists(Target)) { Directory.Move(Target, backup); moved = true; }
        Directory.Move(staging, Target); activated = true;
        File.Copy(Path.Combine(Target, "BridgeLauncher.exe"), Launcher, true);
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey)) {
          key.SetValue("DisplayName", "Codex Wallpaper Bridge"); key.SetValue("DisplayVersion", BridgeShared.BuildInfo.Version);
          key.SetValue("InstallLocation", Target); key.SetValue("UninstallString", "\"" + Path.Combine(Target, "Uninstall.exe") + "\" --uninstall");
          key.SetValue("QuietUninstallString", "\"" + Path.Combine(Target, "Uninstall.exe") + "\" --silent");
          key.SetValue("DisplayIcon", Path.Combine(Target, "CodexWallpaperBridge.exe")); key.SetValue("Publisher", "Codex Wallpaper Bridge");
          key.SetValue("NoModify", 1); key.SetValue("NoRepair", 1);
        }
        Shortcut(menuLink, false);
        Shortcut(UninstallLink, false, true);
        if (desktop) Shortcut(desktopLink, false);
        using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) {
          if (startup) key.SetValue("CodexWallpaperBridge", "\"" + Launcher + "\" --background");
          else {
            var entry = key.GetValue("CodexWallpaperBridge") as string;
            if (entry != null && (entry.StartsWith("\"" + Path.Combine(Target, "CodexWallpaperBridge.exe") + "\"", StringComparison.OrdinalIgnoreCase) || entry.StartsWith("\"" + Launcher + "\"", StringComparison.OrdinalIgnoreCase))) key.DeleteValue("CodexWallpaperBridge", false);
          }
        }
        // The retained previous install is the local recovery copy, outside the active app.
      } catch {
        if (activated && Directory.Exists(Target)) Directory.Move(Target, staging + ".failed");
        if (moved && !Directory.Exists(Target) && Directory.Exists(backup)) Directory.Move(backup, Target);
        if (previousLauncher != null) File.WriteAllBytes(Launcher, previousLauncher);
        else if (File.Exists(Launcher) && FileVersionInfo.GetVersionInfo(Launcher).ProductName == "CodexWallpaperBridge.Launcher/1") File.Delete(Launcher);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        if (priorRegistration.Count > 0) using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
          foreach (var pair in priorRegistration) key.SetValue(pair.Key, pair.Value);
        using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) {
          if (previousStartup == null) key.DeleteValue("CodexWallpaperBridge", false); else key.SetValue("CodexWallpaperBridge", previousStartup);
        }
        if (!hadMenuLink && File.Exists(menuLink)) Shortcut(menuLink, true);
        if (!hadDesktopLink && File.Exists(desktopLink)) Shortcut(desktopLink, true);
        if (!hadUninstallLink && File.Exists(UninstallLink)) Shortcut(UninstallLink, true, true);
        throw;
      }
    }
      }
    static void Shortcut(string file, bool remove, bool uninstall = false) {
      var type = Type.GetTypeFromProgID("WScript.Shell"); var shell = Activator.CreateInstance(type);
      var link = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { file });
      var linkType = link.GetType(); var target = uninstall ? Path.Combine(Target, "Uninstall.exe") : Launcher;
      if (remove) {
        string actual = Convert.ToString(linkType.InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null));
        if (String.Equals(actual, target, StringComparison.OrdinalIgnoreCase) || String.Equals(actual, Path.Combine(Target, "CodexWallpaperBridge.exe"), StringComparison.OrdinalIgnoreCase)) File.Delete(file);
      } else {
        if (File.Exists(file)) {
          string actual = Convert.ToString(linkType.InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null));
          if (!String.Equals(actual, target, StringComparison.OrdinalIgnoreCase) && !String.Equals(actual, Path.Combine(Target, "CodexWallpaperBridge.exe"), StringComparison.OrdinalIgnoreCase)) throw new Exception("同名快捷方式属于其他程序，未进行覆盖。");
        }
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
        linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Target });
        linkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, link, new object[] { uninstall ? "--uninstall" : "" });
        linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
      }
      System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
    }
    static List<string> OwnedFiles(string root) {
      Plain(root); string marker = Path.Combine(root, ".bridge-owned"), inventory = Path.Combine(root, "installed-files.txt");
      Plain(marker); Plain(inventory);
      if (!File.Exists(marker) || File.ReadAllText(marker) != Identity || !File.Exists(inventory)) throw new Exception("安装目录身份或卸载清单不完整，未删除文件。");
      if (new FileInfo(inventory).Length > 2 * 1024 * 1024) throw new Exception("卸载清单超出限制。");
      var listed = File.ReadAllLines(inventory); if (listed.Length > 1500) throw new Exception("卸载清单超出限制。");
      var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (var item in listed) {
        string name = item.Replace('/', Path.DirectorySeparatorChar);
        if (String.IsNullOrWhiteSpace(name) || name.Contains(':') || Path.IsPathRooted(name) ||
            name.Split(Path.DirectorySeparatorChar).Any(p => p == "." || p == ".." || p.Length == 0 || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || p.EndsWith(".") || p.EndsWith(" ") || System.Text.RegularExpressions.Regex.IsMatch(p, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\.|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) || !names.Add(name)) throw new Exception("卸载清单路径无效。");
        string file = Path.GetFullPath(Path.Combine(root, name));
        if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("卸载清单路径越界。");
        Plain(file);
        if (Directory.Exists(file)) throw new Exception("卸载清单条目不是普通文件。");
      }
      if (!names.Contains("CodexWallpaperBridge.exe") || !names.Contains("Uninstall.exe")) throw new Exception("卸载清单缺少 Bridge 程序身份。");
      return names.Where(n => !String.Equals(n, ".bridge-owned", StringComparison.OrdinalIgnoreCase) && !String.Equals(n, "installed-files.txt", StringComparison.OrdinalIgnoreCase)).ToList();
    }
    static void PreflightFiles(IEnumerable<string> files) {
      // Check every selected file before deletion. Keep inventory and registration intact on a locked/read-only file so retry remains possible.
      foreach (var file in files) {
        Plain(file); if (!File.Exists(file)) continue;
        if ((File.GetAttributes(file) & FileAttributes.ReadOnly) != 0) throw new IOException("程序文件为只读，请解除占用或只读状态后重试：" + Path.GetFileName(file));
        using (var probe = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete)) { }
      }
    }
    static void DeleteListed(string root, List<string> listed) {
      foreach (var name in listed) File.Delete(Path.Combine(root, name));
      // Walk only parents of listed files, deepest first, removing empty ordinary directories only.
      var parents = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (var name in listed) for (string dir = Path.GetDirectoryName(Path.Combine(root, name)); !Same(dir, root); dir = Path.GetDirectoryName(dir)) parents.Add(dir);
      foreach (var directory in parents.OrderByDescending(n => n.Length)) {
        Plain(directory);
        if (Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
      }
    }
    static void CommitDirectory(string root) {
      File.Delete(Path.Combine(root, "installed-files.txt")); File.Delete(Path.Combine(root, ".bridge-owned"));
      if (!Directory.EnumerateFileSystemEntries(root).Any()) Directory.Delete(root);
    }
    static void RemoveInstalled(bool quiet = false) {
      using (var lease = new BridgeShared.InstallLease()) {
        operation = "VALIDATE_UNINSTALL";
        if (portable) Plain(Target); else CheckPath(Target);
        if (!Directory.Exists(Target)) return;
        // An earlier successful removal can leave a directory containing only user-added files.
        if (!File.Exists(Path.Combine(Target, ".bridge-owned")) && !File.Exists(Path.Combine(Target, "installed-files.txt")) &&
            !File.Exists(Path.Combine(Target, "CodexWallpaperBridge.exe")) && !File.Exists(Path.Combine(Target, "Uninstall.exe"))) return;
        var listed = OwnedFiles(Target);
        var backups = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        if (!portable && Directory.Exists(Programs)) foreach (var directory in Directory.GetDirectories(Programs, "CodexWallpaperBridge.*")) {
          if (!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(directory), "^CodexWallpaperBridge\\.(previous|update|staging)-[a-f0-9]{32}(\\.(failed|interrupted))?$")) continue;
          CheckPath(directory); Plain(directory);
          string marker = Path.Combine(directory, ".bridge-owned"); Plain(marker);
          if (!File.Exists(marker) || File.ReadAllText(marker) != Identity) continue;
          backups.Add(directory, OwnedFiles(directory));
        }
        StopBridge(); operation = "PREFLIGHT_UNINSTALL";
        PreflightFiles(listed.Select(n => Path.Combine(Target, n)).Concat(new[] { Path.Combine(Target, ".bridge-owned"), Path.Combine(Target, "installed-files.txt") }));
        foreach (var row in backups) PreflightFiles(row.Value.Select(n => Path.Combine(row.Key, n)).Concat(new[] { Path.Combine(row.Key, ".bridge-owned"), Path.Combine(row.Key, "installed-files.txt") }));
        bool ownLauncher = false;
        if (!portable) {
          CheckPath(Launcher); Plain(Launcher);
          ownLauncher = File.Exists(Launcher) && FileVersionInfo.GetVersionInfo(Launcher).ProductName == "CodexWallpaperBridge.Launcher/1";
          if (ownLauncher) PreflightFiles(new[] { Launcher });
        }
        operation = "DELETE_ACTIVE_FILES"; DeleteListed(Target, listed);
        operation = "REMOVE_BACKUPS";
        foreach (var row in backups) { DeleteListed(row.Key, row.Value); CommitDirectory(row.Key); }
        // Data (preferences, logs, login profiles and update recovery records) is deliberately retained in full.
        if (!portable) {
          operation = "REMOVE_SHORTCUTS";
          foreach (var file in new[] { MenuLink, DesktopLink }) if (File.Exists(file)) Shortcut(file, true);
          if (File.Exists(UninstallLink)) Shortcut(UninstallLink, true, true);
          operation = "REMOVE_REGISTRATION";
          using (var key = Registry.CurrentUser.OpenSubKey(RunKey, true)) {
            string value = key == null ? null : key.GetValue("CodexWallpaperBridge") as string;
            if (value != null && (value.StartsWith(Quote(Path.Combine(Target, "CodexWallpaperBridge.exe")), StringComparison.OrdinalIgnoreCase) || value.StartsWith(Quote(Launcher), StringComparison.OrdinalIgnoreCase))) key.DeleteValue("CodexWallpaperBridge", false);
          }
          bool ownedRegistration = false;
          using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey)) {
            string location = key == null ? null : key.GetValue("InstallLocation") as string;
            ownedRegistration = location != null && Same(location, Target);
          }
          if (ownedRegistration) Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
          if (ownLauncher) File.Delete(Launcher);
        }
        operation = "COMMIT_UNINSTALL"; CommitDirectory(Target);
        if (!quiet) MessageBox.Show("Bridge 已卸载。设置、登录资料、日志、用户新增文件和原始壁纸均已保留。", "Codex Wallpaper Bridge");
      }
    }

  }
  sealed class SetupForm : Form {
    public SetupForm() {
      Text = "安装 Codex Wallpaper Bridge"; ClientSize = new Size(560, 330); Font = new Font("Microsoft YaHei UI", 10); StartPosition = FormStartPosition.CenterScreen;
      try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
      var text = new Label { Text = "Codex Wallpaper Bridge " + BridgeShared.BuildInfo.Version + "\n\n为当前用户安装，无需管理员权限。\n包含独立 Node.js 运行时、设置面板和系统托盘。\n这是开发验证版本，完整兼容与稳定性验收仍在进行。", AutoSize = true, Location = new Point(24, 25) }; Controls.Add(text);
      var desktop = new CheckBox { Text = "创建桌面快捷方式", AutoSize = true, Location = new Point(24, 190) };
      var startup = new CheckBox { Text = "随 Windows 登录启动", AutoSize = true, Location = new Point(24, 225) }; Controls.Add(desktop); Controls.Add(startup);
      var install = new Button { Text = "安装", Location = new Point(405, 275), Size = new Size(120, 34) }; Controls.Add(install);
      install.Click += async delegate {
        install.Enabled = false;
        try { bool d = desktop.Checked, s = startup.Checked; await Task.Run(delegate { Program.Install(d, s); }); MessageBox.Show("安装完成，可从开始菜单启动。", Text); Close(); }
        catch (Exception error) { MessageBox.Show(error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error); install.Enabled = true; }
      };
    }
  }
}
