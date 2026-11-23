using System.Runtime.InteropServices;

namespace Sash.App;

/// <summary>
/// ウィンドウのタイトルバー（Windows が描く部分）の明暗を、画面のテーマに合わせる。
/// WebView2 の中のテーマを変えても、タイトルバーは Windows の既定（明るい色）のままになるため、
/// DWM の「ダークモードのタイトルバー」属性を切り替える。
/// </summary>
internal static class TitleBarTheme
{
    // Windows 10 20H1 以降と Windows 11 の属性番号。それより前の Windows 10（1809〜1909）は 19 番だった。
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeOld = 19;

    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpFrameChanged = 0x0020;

    /// <summary>タイトルバーを暗く（または明るく）する。対応していない Windows では何もしない。</summary>
    public static void Apply(IntPtr hwnd, bool dark)
    {
        if (hwnd == IntPtr.Zero || !OperatingSystem.IsWindowsVersionAtLeast(10, 0, 17763))
        {
            return;
        }

        var value = dark ? 1 : 0;
        if (DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref value, sizeof(int)) != 0)
        {
            // 古い Windows 10 は番号が違う。失敗しても見た目が変わらないだけなので、結果は見ない
            _ = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkModeOld, ref value, sizeof(int));
        }

        // Windows 10 は属性を変えただけではタイトルバーを描き直さないので、枠の描き直しを頼む
        _ = SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoZOrder | SwpNoActivate | SwpFrameChanged);
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
}
