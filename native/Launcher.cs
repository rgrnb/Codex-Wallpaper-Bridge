using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Reflection;
[assembly: AssemblyProduct("CodexWallpaperBridge.Launcher/1")]
// Stable launcher outside the replaceable application directory.
static class Launcher {
  static readonly string Programs = BridgeShared.KnownPaths.Directory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"));
  static readonly string Target = Path.Combine(Programs, "CodexWallpaperBridge");
  static readonly string Data = BridgeShared.KnownPaths.Directory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexWallpaperBridge"));
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static string recoveryStep="START";
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool MoveFileEx(string from,string to,uint flags);
  static void Plain(string file) {
    for (var item = new DirectoryInfo(Path.GetDirectoryName(file)); item != null; item = item.Parent)
      if (item.Exists && (item.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception("恢复路径含目录重定向。");
    if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new Exception("恢复文件含重定向。");
  }
  static bool Owned(string root) { return File.Exists(Path.Combine(root, ".bridge-owned")) && File.ReadAllText(Path.Combine(root, ".bridge-owned")) == "CodexWallpaperBridge/1"; }
  static void Atomic(string file, object row) {
    file=Path.Combine(BridgeShared.KnownPaths.Directory(Path.GetDirectoryName(file)),Path.GetFileName(file));
    string temporary=file+".recovery.tmp";var bytes=System.Text.Encoding.UTF8.GetBytes(Json.Serialize(row));
    using(var stream=new FileStream(temporary,FileMode.Create,FileAccess.Write,FileShare.None)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
    for(int n=0;n<30;n++) {
      if(MoveFileEx(temporary,file,9))return;
      int failure=Marshal.GetLastWin32Error();if((failure!=5&&failure!=32)||n==29)throw new IOException("RECOVERY_RENAME_FAILED_"+failure);
      Thread.Sleep(100);
    }
  }
  static bool WorkerAlive(Dictionary<string, object> record) {
    object value; if (!record.TryGetValue("workerPid", out value)) return false;
    try { using (var proc = Process.GetProcessById(Convert.ToInt32(value))) return String.Equals(proc.MainModule.FileName, Path.Combine(Data, "updates", "worker-node.exe"), StringComparison.OrdinalIgnoreCase); } catch { return false; }
  }
  static void Recover() {
    var journal = Path.Combine(Data, "updates", "activation.json"); Plain(journal);
    if (!File.Exists(journal)) return;
    var record = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(journal));
    if (Convert.ToInt32(record["schemaVersion"]) != 2) return;
    string phase = Convert.ToString(record["phase"]);
    if (phase == "committed" || phase == "rolledBack" || phase == "preparing") return;
    if (WorkerAlive(record)) throw new Exception("正在安装更新，请稍候再启动 Bridge。");
    string nonce = Convert.ToString(record["nonce"]);
    if (!System.Text.RegularExpressions.Regex.IsMatch(nonce, "^[a-f0-9]{32}$")) throw new Exception("更新恢复记录无效。");
    string backup = Target + ".previous-" + nonce, stage = Target + ".update-" + nonce;
    if (Convert.ToString(record["target"]) != Target || Convert.ToString(record["backup"]) != backup || Convert.ToString(record["stage"]) != stage) throw new Exception("更新恢复路径不匹配。");
    Plain(Path.Combine(backup, ".bridge-owned")); Plain(Path.Combine(Target, ".bridge-owned"));
    if (!Directory.Exists(backup)) {
      if(!Owned(Target)||Convert.ToString(Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Target,"package.json")))["version"])==Convert.ToString(record["version"]))throw new Exception("未找到完整的上一版，请重新运行安装器。");
    } else {
    if (!Owned(backup)) throw new Exception("上一版身份校验失败。");
    if (Directory.Exists(Target)) {
      if (!Owned(Target)) throw new Exception("当前安装身份校验失败。");
      try { using (var signal = EventWaitHandle.OpenExisting("Local\\CodexWallpaperBridge.Stop-" + Environment.UserName)) signal.Set(); } catch (WaitHandleCannotBeOpenedException) { }
      bool moved = false;
      for (int i = 0; i < 60; i++) { try { Directory.Move(Target, stage + ".interrupted"); moved = true; break; } catch (IOException) { Thread.Sleep(250); } }
      if (!moved) throw new Exception("请退出 Bridge 后重新启动以完成恢复。");
    }
    recoveryStep="RESTORE_DIRECTORY";Directory.Move(backup, Target);
    }
    string settingsBackup = Path.Combine(Data, "updates", "settings.previous.json"), settings = Path.Combine(Data, "settings.json"); Plain(settingsBackup); Plain(settings);
    recoveryStep="RESTORE_SETTINGS";var previous = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsBackup)); previous["enabled"] = false; Atomic(settings, previous);
    recoveryStep="COMMIT_RECOVERY";record["phase"] = "rolledBack"; record["code"] = "UPDATE_INTERRUPTED_ROLLED_BACK"; Atomic(journal, record);
  }
  [STAThread] static int Main(string[] args) {
    try {
      Recover();
      if (!Owned(Target)) throw new Exception("未找到 Bridge 安装，请运行安装器。");
      Plain(Path.Combine(Target, "CodexWallpaperBridge.exe"));
      Process.Start(new ProcessStartInfo(Path.Combine(Target, "CodexWallpaperBridge.exe"), Array.IndexOf(args, "--background") >= 0 ? "--background" : "") { UseShellExecute = false, CreateNoWindow = true });
      return 0;
    } catch (Exception error) {
      var nonce=Environment.GetEnvironmentVariable("BRIDGE_UPDATE_NONCE");
      if(nonce!=null&&System.Text.RegularExpressions.Regex.IsMatch(nonce,"^[a-f0-9]{32}$")) {
        try{File.WriteAllText(Path.Combine(Data,"updates","health-"+nonce+".json"),Json.Serialize(new{nonce=nonce,healthy=false,code="LAUNCHER_"+recoveryStep+"_"+error.GetType().Name+"_"+unchecked((uint)error.HResult).ToString("X8")}));}catch{}
        return 1;
      }
      if(Array.IndexOf(args,"--background")<0)System.Windows.Forms.MessageBox.Show(error.Message,"Codex Wallpaper Bridge");return 1;
    }
  }
}
