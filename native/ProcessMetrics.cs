using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace CodexWallpaperBridge {
  // Process counters only. Never opens user documents, command lines or renderer content.
  static class ProcessMetrics {
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
      public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;
      public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string executable;
    }
    [DllImport("kernel32.dll")]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32First(IntPtr snapshot,ref Entry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32Next(IntPtr snapshot,ref Entry entry);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    internal static Dictionary<uint,uint> ParentMap() {
      var parents=new Dictionary<uint,uint>();var snapshot=CreateToolhelp32Snapshot(2,0);
      if(snapshot==new IntPtr(-1))throw new Exception("METRICS_SNAPSHOT_FAILED");
      try {var entry=new Entry{size=(uint)Marshal.SizeOf(typeof(Entry))};if(Process32First(snapshot,ref entry))do{parents[entry.pid]=entry.parent;}while(parents.Count<8192 && Process32Next(snapshot,ref entry));}
      finally{CloseHandle(snapshot);}
      return parents;
    }
    internal static bool Descends(uint pid,uint root,Dictionary<uint,uint> parents) {
      for(int depth=0;depth<32;depth++){uint parent;if(!parents.TryGetValue(pid,out parent)||parent==0||parent==pid||!CreationOrdered(pid,parent))return false;if(parent==root)return true;pid=parent;}return false;
    }
    static bool CreationOrdered(uint child,uint parent) {
      // Toolhelp parent IDs outlive an exited parent and can be recycled. A
      // pre-existing process must not become an owned child through PID reuse.
      try{using(var childProcess=Process.GetProcessById((int)child))using(var parentProcess=Process.GetProcessById((int)parent))
        return childProcess.StartTime.ToUniversalTime()>=parentProcess.StartTime.ToUniversalTime();}catch{return false;}
    }
    public static object Collect(string roots) {
      if(!System.Text.RegularExpressions.Regex.IsMatch(roots,"^[0-9]{1,10}(,[0-9]{1,10}){0,7}$"))throw new Exception("METRICS_ARGUMENT_INVALID");
      var selected=new HashSet<uint>();foreach(string value in roots.Split(',')){uint pid;if(UInt32.TryParse(value,out pid)&&pid>0)selected.Add(pid);}
      var parents=ParentMap();
      for(int depth=0;depth<16;depth++){bool changed=false;foreach(var item in parents)if(selected.Contains(item.Value)&&!selected.Contains(item.Key)&&CreationOrdered(item.Key,item.Value)&&selected.Add(item.Key))changed=true;if(!changed)break;}
      selected.Remove((uint)Process.GetCurrentProcess().Id);var result=new List<object>();
      foreach(uint pid in selected){if(result.Count>=128)break;try{using(var process=Process.GetProcessById((int)pid))result.Add(new{pid=pid,
        identity=process.StartTime.ToUniversalTime().Ticks.ToString(),name=process.ProcessName,cpuMs=process.TotalProcessorTime.TotalMilliseconds,
        memory=process.WorkingSet64,privateBytes=process.PrivateMemorySize64,handles=process.HandleCount});}catch{}}
      return result.ToArray();
    }
  }
}
