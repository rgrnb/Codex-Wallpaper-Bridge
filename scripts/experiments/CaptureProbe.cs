using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using CodexWallpaperBridge;

// Diagnostic executable only. Not shipped or called by the production service.
// Only captures a uniquely named WE probe pop-out.
internal static class CaptureProbe {
  delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  static object BoundsOf(IntPtr hwnd) { Rect rect; GetWindowRect(hwnd, out rect); return new { left = rect.Left, top = rect.Top, right = rect.Right, bottom = rect.Bottom }; }
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static string ClassOf(IntPtr hwnd) { var value = new StringBuilder(256); GetClassName(hwnd, value, value.Capacity); return value.ToString(); }
  static string TitleOf(IntPtr hwnd) { var value = new StringBuilder(512); GetWindowText(hwnd, value, value.Capacity); return value.ToString(); }
  static void Write(object value) { Console.WriteLine(Json.Serialize(value)); }
  static List<IntPtr> Windows(uint selectedPid) {
    var result = new List<IntPtr>(); var visited = new HashSet<long>();
    EnumCallback visit = delegate(IntPtr hwnd, IntPtr p) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid == selectedPid && visited.Add(hwnd.ToInt64())) result.Add(hwnd);
      return true;
    };
    EnumWindows(delegate(IntPtr hwnd, IntPtr p) { visit(hwnd, p); EnumChildWindows(hwnd, visit, p); return true; }, IntPtr.Zero);
    return result;
  }
  static void Capture(IntPtr hwnd) {
    using (var capture = new WgcCapture(hwnd)) {
      for (int index = 0; index < 4; index++) {
        using (var frame = capture.Next()) using (var memory = new MemoryStream()) using (var sha = SHA256.Create()) {
          frame.Save(memory, ImageFormat.Png);
          Write(new { frame = index, width = frame.Width, height = frame.Height,
            sha256 = BitConverter.ToString(sha.ComputeHash(memory.ToArray())).Replace("-", ""),
            center = frame.GetPixel(frame.Width / 2, frame.Height / 2).ToArgb(), savedPixels = false });
        }
        Thread.Sleep(150);
      }
    }
  }
  [STAThread] static int Main(string[] args) {
    try {
      if (args.Length < 2) throw new Exception("PROBE_ARGUMENTS_INVALID");
      uint selectedPid = UInt32.Parse(args[1]);
      using (var process = Process.GetProcessById((int)selectedPid)) {
        var file = Path.GetFileName(process.MainModule.FileName);
        if (file != "wallpaper64.exe" && file != "wallpaper32.exe") throw new Exception("PROBE_OWNER_INVALID");
      }
      var windows = Windows(selectedPid);
      if (args[0] == "--promote-selected-scene") {
        var scene = windows.FindAll(h => ClassOf(h) == "WPEDesktopDX11Window" && GetParent(h) != IntPtr.Zero);
        if (scene.Count != 1) throw new Exception("SCENE_WINDOW_NOT_UNIQUE");
        var hwnd = scene[0]; int original = GetWindowLong(hwnd, -16);
        try {
          SetWindowLongPtr(hwnd, -16, new IntPtr((original & ~0x40000000) | unchecked((int)0x80000000)));
          SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x37);
          Capture(hwnd);
        } finally { SetWindowLongPtr(hwnd, -16, new IntPtr(original)); SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x37); }
        return 0;
      }
      if (args[0] == "--inspect") {
        foreach (var hwnd in windows) Write(new { hwnd = hwnd.ToInt64().ToString(), className = ClassOf(hwnd),
          parent = GetParent(hwnd).ToInt64().ToString(), visible = IsWindowVisible(hwnd), style = GetWindowLong(hwnd, -16).ToString("X8"), bounds = BoundsOf(hwnd) });
        return 0;
      }
      if (args.Length != 3 || (args[0] != "--capture" && args[0] != "--move-offscreen") || !args[2].StartsWith("CodexBridgeProbe-")) throw new Exception("PROBE_NAME_INVALID");
      var matching = windows.FindAll(h => GetParent(h) == IntPtr.Zero && TitleOf(h) == args[2]);
      if (matching.Count != 1) throw new Exception("PROBE_WINDOW_NOT_UNIQUE:" + matching.Count);
      if (args[0] == "--move-offscreen") {
        if (!SetWindowPos(matching[0], new IntPtr(1), -10000, -10000, 320, 180, 0x30)) throw new Exception("PROBE_MOVE_FAILED");
        Write(new { bounds = BoundsOf(matching[0]) }); return 0;
      }
      Capture(matching[0]); return 0;
    } catch (Exception error) { Write(new { error = error.Message }); return 1; }
  }
}
