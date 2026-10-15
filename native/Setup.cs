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

namespace BridgeSetup {
  static class Program {
    const string Identity = "CodexWallpaperBridge/1";
    static readonly string Programs = BridgeShared.KnownPaths.Directory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"));
    static readonly string Target = Path.Combine(Programs, "CodexWallpaperBridge");
    static readonly string Launcher = Path.Combine(Programs, "CodexWallpaperBridge.Launcher.exe");
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexWallpaperBridge";
    static string operation = "START";
    [STAThread] static int Main(string[] args) {
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      try {
        if (args.Contains("--install-silent")) { Install(false,false); return 0; }
        if (args.Contains("--remove-installed-silent")) { RemoveInstalled(true); return 0; }
        if (args.Contains("--verify-payload")) { VerifyPayload(); return 0; }
        if (args.Contains("--remove-installed")) { RemoveInstalled(); return 0; }
        if (args.Contains("--uninstall")) {
          if (MessageBox.Show("卸载 Bridge 并恢复 Codex 外观？\nBridge 设置与日志会保留；Wallpaper Engine 壁纸不会删除。", "Codex Wallpaper Bridge", MessageBoxButtons.OKCancel) != DialogResult.OK) return 0;
          var temp = Path.Combine(Path.GetTempPath(), "CodexWallpaperBridge-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
          File.Copy(Application.ExecutablePath, temp);
          Process.Start(new ProcessStartInfo(temp, "--remove-installed") { UseShellExecute = false, CreateNoWindow = true }); return 0;
        }
        Application.Run(new SetupForm()); return 0;
      } catch (Exception error) {
        if(args.Contains("--install-silent") || args.Contains("--remove-installed-silent")){Console.Error.WriteLine("SETUP_ACTION_FAILED_"+operation+"_"+error.GetType().Name+"_"+unchecked((uint)error.HResult).ToString("X8"));return 1;}
        if (args.Contains("--verify-payload")) return 1;
        MessageBox.Show("操作未完成：" + error.Message, "Codex Wallpaper Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
      }
    }
    static void CheckPath(string fullPath) {
      var path = Path.GetFullPath(fullPath);
      if (!path.StartsWith(Path.GetFullPath(Programs) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("安装路径超出当前用户 Programs 目录。");
      for (var current = new DirectoryInfo(path); current != null; current = current.Parent)
        if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception("安装路径含重定向目录，请选择普通用户目录。");
    }
    static void StopBridge() {
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
      foreach (var required in new[] { "CodexWallpaperBridge.exe", "BridgeArchive.exe", "BridgeLauncher.exe", "BridgeGraphicsHook.dll", "node.exe", @"src\main.mjs", @"config\adapter.json", @"config\wallpaper-engine.json" })
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
      using (var prior = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
        if (prior != null) previousStartup = prior.GetValue("CodexWallpaperBridge") as string;
      string menuLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Codex Wallpaper Bridge.lnk");
      string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Codex Wallpaper Bridge.lnk");
      bool hadMenuLink = File.Exists(menuLink), hadDesktopLink = File.Exists(desktopLink);
      try {
        Directory.CreateDirectory(staging); var files = Extract(staging, true);
        File.Copy(Application.ExecutablePath, Path.Combine(staging, "Uninstall.exe")); files.Add("Uninstall.exe");
        File.WriteAllText(Path.Combine(staging, ".bridge-owned"), Identity); files.Add(".bridge-owned");
        File.WriteAllLines(Path.Combine(staging, "installed-files.txt"), files);
        if (Directory.Exists(Target)) { Directory.Move(Target, backup); moved = true; }
        Directory.Move(staging, Target); activated = true;
        File.Copy(Path.Combine(Target, "BridgeLauncher.exe"), Launcher, true);
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey)) {
          key.SetValue("DisplayName", "Codex Wallpaper Bridge"); key.SetValue("DisplayVersion", BridgeShared.BuildInfo.Version);
          key.SetValue("InstallLocation", Target); key.SetValue("UninstallString", "\"" + Path.Combine(Target, "Uninstall.exe") + "\" --uninstall");
          key.SetValue("NoModify", 1); key.SetValue("NoRepair", 1);
        }
        Shortcut(menuLink, false);
        if (desktop) Shortcut(desktopLink, false);
        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) {
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
        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) {
          if (previousStartup == null) key.DeleteValue("CodexWallpaperBridge", false); else key.SetValue("CodexWallpaperBridge", previousStartup);
        }
        if (!hadMenuLink && File.Exists(menuLink)) Shortcut(menuLink, true);
        if (!hadDesktopLink && File.Exists(desktopLink)) Shortcut(desktopLink, true);
        throw;
      }
    }
      }
    static void Shortcut(string file, bool remove) {
      var type = Type.GetTypeFromProgID("WScript.Shell"); var shell = Activator.CreateInstance(type);
      var link = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { file });
      var linkType = link.GetType(); var target = Launcher;
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
        linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
      }
      System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
    }
    static void RemoveInstalled(bool quiet = false) {
      using(var lease=new BridgeShared.InstallLease()) {
      operation="VALIDATE_UNINSTALL";
      CheckPath(Target); if (!Directory.Exists(Target)) return;
      if (File.ReadAllText(Path.Combine(Target, ".bridge-owned")) != Identity) throw new Exception("安装目录身份不匹配。");
      StopBridge();
      var listed = File.ReadAllLines(Path.Combine(Target, "installed-files.txt"));
      foreach (var name in listed) {
        var file = Path.GetFullPath(Path.Combine(Target, name));
        if (!file.StartsWith(Target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("卸载清单路径无效。");
        CheckPath(Path.GetDirectoryName(file));
        if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new Exception("卸载清单含重定向文件。");
      }
      operation="DELETE_ACTIVE_FILES";
      foreach (var name in listed.Where(n=>n!=".bridge-owned"&&n!="installed-files.txt")) File.Delete(Path.Combine(Target, name));
      operation="REMOVE_REGISTRATION";
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) {
        var value = key == null ? null : key.GetValue("CodexWallpaperBridge") as string;
        if (value != null && (value.StartsWith("\"" + Path.Combine(Target, "CodexWallpaperBridge.exe") + "\"", StringComparison.OrdinalIgnoreCase) || value.StartsWith("\"" + Launcher + "\"", StringComparison.OrdinalIgnoreCase))) key.DeleteValue("CodexWallpaperBridge", false);
      }
      Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
      if (File.Exists(Launcher) && FileVersionInfo.GetVersionInfo(Launcher).ProductName == "CodexWallpaperBridge.Launcher/1") File.Delete(Launcher);
      operation="REMOVE_SHORTCUTS";
      foreach (var file in new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Codex Wallpaper Bridge.lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Codex Wallpaper Bridge.lnk") })
        if (File.Exists(file)) Shortcut(file, true);
      // Empty directories only: user-added files are never recursively deleted.
      operation="REMOVE_EMPTY_ACTIVE_DIRECTORIES";
      foreach (var directory in listed.Select(n => Path.GetDirectoryName(Path.Combine(Target, n))).Where(n => n != Target).Distinct().OrderByDescending(x => x.Length))
        if (Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
      operation="REMOVE_BACKUPS";
      foreach(var directory in Directory.GetDirectories(Programs,"CodexWallpaperBridge.*")) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(directory),"^CodexWallpaperBridge\\.(previous|update|staging)-[a-f0-9]{32}(\\.(failed|interrupted))?$"))continue;
        RemoveOwnedBackup(directory);
      }
      var updates=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexWallpaperBridge","updates");
      operation="REMOVE_UPDATE_CACHE";
      if(Directory.Exists(updates)) {
        for(var current=new DirectoryInfo(updates);current!=null;current=current.Parent)
          if((current.Attributes&FileAttributes.ReparsePoint)!=0)throw new Exception("更新缓存目录含重定向。");
        foreach(var file in Directory.GetFiles(updates)) {
          var name=Path.GetFileName(file);
          if(!System.Text.RegularExpressions.Regex.IsMatch(name,"^(worker-node\\.exe|BridgeArchive\\.exe|update-worker\\.mjs|settings\\.previous\\.json|activation\\.json|staged\\.json|(health|job)-[a-f0-9]{32}\\.json|[0-9]+\\.[0-9]+\\.[0-9]+\\.zip)$"))continue;
          if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new Exception("更新缓存含重定向文件。");
          File.Delete(file);
        }
        if(!Directory.EnumerateFileSystemEntries(updates).Any())Directory.Delete(updates);
      }
      operation="COMMIT_UNINSTALL";
      File.Delete(Path.Combine(Target,"installed-files.txt"));File.Delete(Path.Combine(Target,".bridge-owned"));
      if(!Directory.EnumerateFileSystemEntries(Target).Any())Directory.Delete(Target);
      if(!quiet)MessageBox.Show("Bridge 已卸载。设置与日志已保留，Wallpaper Engine 资源未改动。", "Codex Wallpaper Bridge");
      }
    }
    static void RemoveOwnedBackup(string root) {
      CheckPath(root);string marker=Path.Combine(root,".bridge-owned"),manifest=Path.Combine(root,"installed-files.txt");
      if(!File.Exists(marker)||File.ReadAllText(marker)!=Identity||!File.Exists(manifest))return;
      var listed=File.ReadAllLines(manifest);if(listed.Length>1500)throw new Exception("恢复副本清单超出限制。");
      foreach(var name in listed) {
        var file=Path.GetFullPath(Path.Combine(root,name));
        if(!file.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("恢复副本清单越界。");
        CheckPath(Path.GetDirectoryName(file));if(File.Exists(file)&&(File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new Exception("恢复副本文件含重定向。");
      }
      foreach(var name in listed)File.Delete(Path.Combine(root,name));File.Delete(manifest);
      foreach(var directory in listed.Select(n=>Path.GetDirectoryName(Path.Combine(root,n))).Where(n=>n!=root).Distinct().OrderByDescending(n=>n.Length))
        if(Directory.Exists(directory)&&!Directory.EnumerateFileSystemEntries(directory).Any())Directory.Delete(directory);
      if(!Directory.EnumerateFileSystemEntries(root).Any())Directory.Delete(root);
    }
  }
  sealed class SetupForm : Form {
    public SetupForm() {
      Text = "安装 Codex Wallpaper Bridge"; ClientSize = new Size(560, 330); Font = new Font("Microsoft YaHei UI", 10); StartPosition = FormStartPosition.CenterScreen;
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
