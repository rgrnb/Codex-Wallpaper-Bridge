using System;
using System.Threading;
namespace BridgeShared {
  sealed class InstallLease : IDisposable {
    readonly Mutex mutex;
    public InstallLease() {
      mutex=new Mutex(false,"Local\\CodexWallpaperBridge.Install-"+Environment.UserName);
      bool acquired;try{acquired=mutex.WaitOne(0,false);}catch(AbandonedMutexException){acquired=true;}
      if(!acquired){mutex.Dispose();throw new Exception("UPDATE_INSTALL_BUSY");}
    }
    public void Dispose(){mutex.ReleaseMutex();mutex.Dispose();}
  }
}
