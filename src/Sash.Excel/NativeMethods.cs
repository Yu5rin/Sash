using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;

namespace Sash.Excel;

[SupportedOSPlatform("windows")]
internal static partial class NativeMethods
{
    [DllImport("ole32.dll")]
    public static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable prot);

    [DllImport("ole32.dll")]
    public static extern int CreateBindCtx(int reserved, out IBindCtx ppbc);

    [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
    public static extern int CLSIDFromProgID(string lpszProgID, out Guid pclsid);

    [DllImport("oleaut32.dll")]
    public static extern int GetActiveObject(ref Guid rclsid, IntPtr pvReserved, [MarshalAs(UnmanagedType.IUnknown)] out object ppunk);

    // ---- imageMso の取り込み用の Excel（仕様書 §17.7） ----

    /// <summary>ウィンドウを作ったプロセスの番号を返す。取り込み専用に起動した Excel のプロセスを、応答しなくなったときに終わらせるため。</summary>
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    /// <summary>短い名前（8.3 形式）のパス。VBA の Open は ANSI のパスしか扱えないので、ASCII でない文字を含む一時フォルダに使う。</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetShortPathName(string lpszLongPath, [Out] char[] lpszShortPath, int cchBuffer);

    // ---- Excel のウィンドウの幅（仕様書 §18.1）とウィンドウを前に出す操作 ----

    public const uint MonitorDefaultToNearest = 2;

    /// <summary>GetDpiForMonitor の MDT_EFFECTIVE_DPI（利用者が設定した拡大率を含む DPI）。</summary>
    public const int MdtEffectiveDpi = 0;

    /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2。座標を物理 px で受け取るために、呼び出しの間だけスレッドに設定する。</summary>
    public static readonly IntPtr DpiAwarenessContextPerMonitorAwareV2 = new(-4);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
