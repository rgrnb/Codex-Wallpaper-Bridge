using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
namespace BridgeShared {
  static class KnownPaths {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder name,uint size,uint flags);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    public static string Directory(string path) {
      System.IO.Directory.CreateDirectory(path);
      var handle=CreateFile(path,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
      if(handle==new IntPtr(-1))throw new IOException("无法解析 Bridge 数据目录。");
      try {
        var result=new StringBuilder(32768);uint size=GetFinalPathNameByHandle(handle,result,(uint)result.Capacity,0);
        if(size==0 || size>=result.Capacity)throw new IOException("Bridge 数据目录路径无效。");
        string value=result.ToString();
        if(value.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))return @"\\"+value.Substring(8);
        return value.StartsWith(@"\\?\")?value.Substring(4):value;
      }finally{CloseHandle(handle);}
    }
  }
}
