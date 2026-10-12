# Read only foreground geometry; never capture titles, images or game content.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TideForeground {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct Monitor { public int Size; public Rect Bounds,Work; public uint Flags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref Monitor info);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder text,int max);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h,int index);
  public static bool Covered(uint owner) {
    IntPtr h=GetForegroundWindow(); if(h==IntPtr.Zero)return false;
    uint pid; GetWindowThreadProcessId(h,out pid); if(pid==owner)return false;
    var name=new System.Text.StringBuilder(256); GetClassName(h,name,256);
    if(name.ToString()=="Progman"||name.ToString()=="WorkerW"||name.ToString()=="Shell_TrayWnd")return false;
    Rect r; if(!GetWindowRect(h,out r))return false;
    Monitor m=new Monitor();m.Size=Marshal.SizeOf(typeof(Monitor));
    if(!GetMonitorInfo(MonitorFromWindow(h,2),ref m))return false;
    bool full=r.L<=m.Bounds.L+2&&r.T<=m.Bounds.T+2&&r.R>=m.Bounds.R-2&&r.B>=m.Bounds.B-2;
    bool noCaption=(GetWindowLong(h,-16)&0x00C00000)==0;
    bool borderless=noCaption&&r.L<=m.Work.L+2&&r.T<=m.Work.T+2&&r.R>=m.Work.R-2&&r.B>=m.Work.B-2;
    return full||borderless;
  }
}
'@
$previous = ''
while (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue) {
  $next = if ([TideForeground]::Covered([uint32]$OwnerPid)) { '1' } else { '0' }
  if ($next -ne $previous) { [Console]::WriteLine($next); $previous = $next }
  Start-Sleep -Milliseconds 800
}
