param([long]$WindowHandle = 0, [string]$ExecutablePath = '', [string]$IconResourcePath = '', [string]$ExpectedRelaunchCommand = '', [string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct TidePropertyKey {
    public Guid formatId; public uint propertyId;
    public TidePropertyKey(uint id) { formatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); propertyId = id; }
}
[StructLayout(LayoutKind.Explicit, Size=24)] public struct TidePropertyValue {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr pointer;
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITidePropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out TidePropertyKey key);
    [PreserveSig] int GetValue(ref TidePropertyKey key, out TidePropertyValue value);
    [PreserveSig] int SetValue(ref TidePropertyKey key, ref TidePropertyValue value);
    [PreserveSig] int Commit();
}
public static class TideWindowIcon {
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint ExtractIconEx(string file, int index, out IntPtr large, out IntPtr small, uint count);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out ITidePropertyStore store);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref TidePropertyValue value);
    public static string ReadProperty(IntPtr hwnd, uint id) {
        var iid = typeof(ITidePropertyStore).GUID;
        ITidePropertyStore store;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(hwnd, ref iid, out store));
        try {
            var key = new TidePropertyKey(id);
            TidePropertyValue value;
            Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
            try { return value.type == 31 ? Marshal.PtrToStringUni(value.pointer) : ""; }
            finally { PropVariantClear(ref value); }
        } finally { Marshal.ReleaseComObject(store); }
    }
}
"@
$projectPath = Split-Path -Parent $PSScriptRoot
$expectedPath = Join-Path $projectPath 'assets\app.ico'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectPath 'screenshots' }
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
if (-not $ExecutablePath -and -not $IconResourcePath) { $ExecutablePath = Join-Path $projectPath 'dist\Tide-Companion-win32-x64\Tide-Companion.exe' }
$checks = [System.Collections.Generic.List[string]]::new()
function Assert-SharkBitmap([System.Drawing.Bitmap]$ActualBitmap, [string]$Label, [bool]$Exact = $true) {
    $expectedIcon = $null
    if ($Exact) {
        $expectedIcon = [System.Drawing.Icon]::new($expectedPath, $ActualBitmap.Width, $ActualBitmap.Height)
        $expectedBitmap = $expectedIcon.ToBitmap()
    } else {
        # Electron's NativeImage uses app.png for WM_GETICON, while the shell
        # reads the ICO; .NET's old Icon decoder omits a PNG-compressed 256 slot.
        $sourceBitmap = [System.Drawing.Bitmap]::new((Join-Path $projectPath 'assets\app.png'))
        try { $expectedBitmap = [System.Drawing.Bitmap]::new($sourceBitmap, $ActualBitmap.Width, $ActualBitmap.Height) }
        finally { $sourceBitmap.Dispose() }
    }
    try {
        if ($expectedBitmap.Size -ne $ActualBitmap.Size) { throw "$Label icon has an unexpected size: $($ActualBitmap.Size)." }
        [long]$difference = 0
        for ($y = 0; $y -lt $ActualBitmap.Height; $y++) {
            for ($x = 0; $x -lt $ActualBitmap.Width; $x++) {
                $a = $ActualBitmap.GetPixel($x, $y); $b = $expectedBitmap.GetPixel($x, $y)
                # Transparent RGB does not affect the displayed icon.
                if ($a.A -eq 0 -and $b.A -eq 0) { continue }
                $difference += [Math]::Abs([int]$a.A - [int]$b.A) + [Math]::Abs([int]$a.R - [int]$b.R) + [Math]::Abs([int]$a.G - [int]$b.G) + [Math]::Abs([int]$a.B - [int]$b.B)
            }
        }
        $meanDifference = $difference / ($ActualBitmap.Width * $ActualBitmap.Height * 4)
        if (($Exact -and $difference -ne 0) -or $meanDifference -gt 8) { throw "$Label icon does not match the shark icon (mean difference $meanDifference)." }
        $checks.Add("$Label shark image ($($ActualBitmap.Width)x$($ActualBitmap.Height))")
    } finally { if ($expectedIcon) { $expectedIcon.Dispose() }; $expectedBitmap.Dispose() }
}
foreach ($source in @(@{Path=$ExecutablePath;Label='executable'}, @{Path=$IconResourcePath;Label='shell-resource'})) {
    if (-not $source.Path) { continue }
    $large = [IntPtr]::Zero; $small = [IntPtr]::Zero
    $count = [TideWindowIcon]::ExtractIconEx($source.Path, 0, [ref]$large, [ref]$small, 1)
    if ($count -eq 0 -or $count -eq [uint32]::MaxValue -or $large -eq [IntPtr]::Zero) { throw "Icon extraction failed: $($source.Path), count=$count." }
    try {
        foreach ($image in @(@{Handle=$large;Size='large'}, @{Handle=$small;Size='small'})) {
            $actualIcon = [System.Drawing.Icon]::FromHandle($image.Handle)
            $bitmap = $actualIcon.ToBitmap()
            try {
                Assert-SharkBitmap $bitmap "$($source.Label) $($image.Size)"
                $bitmap.Save((Join-Path $OutputDirectory "$($source.Label)-$($image.Size).png"), [System.Drawing.Imaging.ImageFormat]::Png)
            } finally { $bitmap.Dispose(); $actualIcon.Dispose() }
        }
    } finally { [void][TideWindowIcon]::DestroyIcon($large); [void][TideWindowIcon]::DestroyIcon($small) }
}
if ($WindowHandle -ne 0) {
    foreach ($size in @(0, 1)) {
        $nativeIcon = [TideWindowIcon]::SendMessage([IntPtr]$WindowHandle, 0x007F, [IntPtr]$size, [IntPtr]0)
        if ($nativeIcon -eq [IntPtr]::Zero) { throw "Dashboard has no native window icon ($size)." }
        $windowIcon = [System.Drawing.Icon]::FromHandle($nativeIcon)
        $windowBitmap = $windowIcon.ToBitmap()
        try {
            Assert-SharkBitmap $windowBitmap "window $size" $false
            $windowBitmap.Save((Join-Path $OutputDirectory "window-icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $windowBitmap.Dispose(); $windowIcon.Dispose() }
    }
    $identity = [ordered]@{
        appId = [TideWindowIcon]::ReadProperty([IntPtr]$WindowHandle, 5)
        relaunchCommand = [TideWindowIcon]::ReadProperty([IntPtr]$WindowHandle, 2)
        relaunchIcon = [TideWindowIcon]::ReadProperty([IntPtr]$WindowHandle, 3)
        relaunchName = [TideWindowIcon]::ReadProperty([IntPtr]$WindowHandle, 4)
    }
    if ($identity.appId -ne 'org.transpet.desktop') { throw 'Window is missing its explicit application identity.' }
    if ($identity.relaunchName -ne '潮汐') { throw "Unexpected taskbar name: $($identity.relaunchName)" }
    if ($IconResourcePath -and $identity.relaunchIcon -ne "$IconResourcePath,0") { throw "Unexpected taskbar icon: $($identity.relaunchIcon)" }
    if ($ExpectedRelaunchCommand -and $identity.relaunchCommand -ne $ExpectedRelaunchCommand) { throw 'Unexpected taskbar relaunch command.' }
    $checks.Add('native Windows taskbar identity, icon, name and relaunch command')
} else { $identity = $null }
@{ok=$true;checks=$checks;identity=$identity} | ConvertTo-Json -Depth 5 -Compress
