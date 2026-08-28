// Elevated test helper: launch one child with a duplicate of the existing
// Explorer primary token so physical P0 probes never inherit elevation.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace Aiopago.OperationAuthority.Testing {
  internal static class MediumTokenLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008, MAXIMUM_ALLOWED = 0x02000000;
    private const int SecurityImpersonation = 2, TokenPrimary = 1;
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr primary);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application, StringBuilder commandLine, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
    private static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    public static int Main(string[] args) {
      if (args.Length < 1) { Console.Error.WriteLine("usage: medium-token-launcher <application> [args...]"); return 2; }
      Process explorer = Process.GetProcessesByName("explorer").OrderBy(p => p.Id).FirstOrDefault();
      if (explorer == null) throw new InvalidOperationException("EXPLORER_NOT_FOUND");
      IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, explorer.Id), token = IntPtr.Zero, primary = IntPtr.Zero;
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        Check(OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY, out token));
        Check(DuplicateTokenEx(token, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary));
        string application = System.IO.Path.GetFullPath(args[0]);
        StringBuilder command = new StringBuilder(Quote(application));
        for (int i = 1; i < args.Length; ++i) command.Append(" ").Append(Quote(args[i]));
        STARTUPINFO startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
        PROCESS_INFORMATION child;
        Check(CreateProcessWithTokenW(primary, 1, application, command, 0x00000400, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child));
        try {
          Console.WriteLine("P0_PID=" + child.dwProcessId + " EXPLORER_PID=" + explorer.Id);
          WaitForSingleObject(child.hProcess, 0xffffffff);
          uint exitCode; Check(GetExitCodeProcess(child.hProcess, out exitCode));
          return unchecked((int)exitCode);
        } finally { CloseHandle(child.hThread); CloseHandle(child.hProcess); }
      } finally {
        if (primary != IntPtr.Zero) CloseHandle(primary); if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); explorer.Dispose();
      }
    }
  }
}
