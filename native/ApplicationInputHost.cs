using System;
using System.Runtime.InteropServices;

// Small AnyCPU assembly loaded only in the reviewed Sheep's x86 worker. The
// general desktop host and Scene capture remain x64 processes and binaries.
namespace CodexWallpaperBridge {
  internal static class Program {
    public static string Executable { get { return typeof(Program).Assembly.Location; } }
  }
  internal static class Native {
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left,Top,Right,Bottom; }
  }
}
