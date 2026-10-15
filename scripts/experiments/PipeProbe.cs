using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
class PipeProbe {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct Startup {public int cb;public string reserved,desktop,title;public int x,y,cx,cy,charsX,charsY,fill,flags;public short show,size;public IntPtr bytes,input,output,error;}
 [StructLayout(LayoutKind.Sequential)]struct Info {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string app,StringBuilder command,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
 [DllImport("kernel32.dll")]static extern IntPtr VirtualAllocEx(IntPtr p,IntPtr address,UIntPtr size,uint type,uint protection);
 [DllImport("kernel32.dll")]static extern bool WriteProcessMemory(IntPtr p,IntPtr address,byte[] data,UIntPtr size,out UIntPtr written);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandle(string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi)]static extern IntPtr GetProcAddress(IntPtr module,string name);
 [DllImport("kernel32.dll")]static extern IntPtr CreateRemoteThread(IntPtr p,IntPtr attributes,UIntPtr size,IntPtr start,IntPtr parameter,uint flags,out uint id);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")]static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll")]static extern bool GetExitCodeThread(IntPtr h,out uint code);
 static int Main(string[] args) {
   if((args.Length!=2 && args.Length!=4) || Path.GetFileName(args[0])!="wallpaper64.exe" || !File.Exists(args[0]) || !File.Exists(args[1]))return 2;
   string command=" -control getWallpaper -monitor 0";
   if(args.Length==4) {
     var allowed=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(args[1]),"..","scripts","experiments","fixtures","web","project.json"));
     if(Path.GetFullPath(args[2])!=allowed || !args[3].StartsWith("CodexBridgeProbe-"))return 9;
     command=" -control openWallpaper -file \""+allowed+"\" -playInWindow \""+args[3]+"\" -width 320 -height 180";
   }
   var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup))};Info info;
   if(!CreateProcess(args[0],new StringBuilder("\""+args[0]+"\""+command),IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,Path.GetDirectoryName(args[0]),ref startup,out info))return 3;
   try {
     byte[] data=Encoding.Unicode.GetBytes(Path.GetFullPath(args[1])+"\0");
     var address=VirtualAllocEx(info.process,IntPtr.Zero,(UIntPtr)data.Length,0x3000,4);UIntPtr written;
     if(address==IntPtr.Zero || !WriteProcessMemory(info.process,address,data,(UIntPtr)data.Length,out written))return 4;
     uint id;var thread=CreateRemoteThread(info.process,IntPtr.Zero,UIntPtr.Zero,GetProcAddress(GetModuleHandle("kernel32.dll"),"LoadLibraryW"),address,0,out id);
     if(thread==IntPtr.Zero)return 5;
     uint loaded;try {if(WaitForSingleObject(thread,5000)!=0)return 6;GetExitCodeThread(thread,out loaded);}finally{CloseHandle(thread);}
     if(loaded==0)return 7;
     ResumeThread(info.thread);if(WaitForSingleObject(info.process,5000)!=0)return 8;return 0;
   }finally{TerminateProcess(info.process,0);CloseHandle(info.thread);CloseHandle(info.process);}
 }
}
