// Runs under medium P0 and attempts the exact SCM binary-path mutation right.
using System;
using System.Runtime.InteropServices;
internal static class ServiceConfigProbe {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenSCManager(string machine, string database, uint access);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenService(IntPtr manager, string name, uint access);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ChangeServiceConfig(IntPtr service, uint serviceType, uint startType, uint errorControl, string binaryPath, string loadOrderGroup, IntPtr tag, string dependencies, string account, string password, string displayName);
  [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
  public static int Main(string[] args) {
    if(args.Length != 1) return 2;
    IntPtr manager=OpenSCManager(null,null,1); if(manager==IntPtr.Zero)return Marshal.GetLastWin32Error();
    try { IntPtr service=OpenService(manager,args[0],2); if(service==IntPtr.Zero)return Marshal.GetLastWin32Error();
      try { bool changed=ChangeServiceConfig(service,0xffffffff,0xffffffff,0xffffffff,Environment.SystemDirectory+"\\cmd.exe",null,IntPtr.Zero,null,null,null,null); return changed?0:Marshal.GetLastWin32Error(); }
      finally { CloseServiceHandle(service); }
    } finally { CloseServiceHandle(manager); }
  }
}
