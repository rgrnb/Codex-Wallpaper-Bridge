using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;

// Invoked only on an already authenticated update archive by the update worker.
static class ArchiveHost {
  static int Main(string[] args) {
    try {
      if(args.Length==1 && args[0]=="--lease") {
        using(var lease=new BridgeShared.InstallLease()){Console.WriteLine("ready");while(Console.ReadLine()!=null){}return 0;}
      }
      if (args.Length != 3) return 2;
      string file = Path.GetFullPath(args[0]), root = Path.GetFullPath(args[1]);
      using (var stream = File.OpenRead(file)) using (var sha = SHA256.Create()) {
        if (!String.Equals(BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", ""), args[2], StringComparison.OrdinalIgnoreCase)) throw new Exception("HASH");
        stream.Position = 0;
        if (Directory.Exists(root)) throw new Exception("DESTINATION_EXISTS");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long total = 0;
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
          if (zip.Entries.Count > 1500) throw new Exception("ENTRY_LIMIT");
          foreach (var e in zip.Entries) {
            string n = e.FullName.Replace('/', '\\');
            if (n.Length == 0 || n.Contains(':') || Path.IsPathRooted(n) || n.TrimEnd('\\').Split('\\').Any(p => p == "." || p == ".." || p.Length==0 || p.IndexOfAny(Path.GetInvalidFileNameChars())>=0 || p.EndsWith(".") || p.EndsWith(" ") || System.Text.RegularExpressions.Regex.IsMatch(p,"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase)) ||
              ((e.ExternalAttributes >> 16) & 0xf000) == 0xa000) throw new Exception("PATH");
            if (n.EndsWith("\\")) continue;
            if (!names.Add(n) || e.Length > 200L * 1024 * 1024 || (total += e.Length) > 400L * 1024 * 1024) throw new Exception("LIMIT");
            if (!Path.GetFullPath(Path.Combine(root, n)).StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)) throw new Exception("PATH");
          }
          foreach (var required in new[] { "CodexWallpaperBridge.exe", "node.exe", "BridgeArchive.exe", "BridgeLauncher.exe", "BridgeGraphicsHook.dll", "src\\main.mjs", "src\\update-worker.mjs", "package.json", "config\\adapter.json", "config\\wallpaper-engine.json" })
            if (!names.Contains(required)) throw new Exception("INCOMPLETE");
          Directory.CreateDirectory(root);
          foreach (var e in zip.Entries) {
            string n = e.FullName.Replace('/', '\\'); if (n.EndsWith("\\")) continue;
            string target = Path.Combine(root, n); Directory.CreateDirectory(Path.GetDirectoryName(target)); e.ExtractToFile(target);
          }
        }
        File.WriteAllLines(Path.Combine(root, "installed-files.txt"), names.Concat(new[] { ".bridge-owned", "Uninstall.exe" }).Distinct(StringComparer.OrdinalIgnoreCase));
        File.WriteAllText(Path.Combine(root, ".bridge-owned"), "CodexWallpaperBridge/1");
      }
      return 0;
    } catch { Console.Error.WriteLine("UPDATE_EXTRACTION_FAILED"); return 1; }
  }
}
