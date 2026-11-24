using System.Globalization;

namespace Sash.Core;

/// <summary>
/// WebView2 ランタイム（Chromium）の版の判定。UI は light-dark()・color-mix()・CSS の入れ子などを
/// lightningcss で下げて Chromium 109 以上を対象にしている（docs/SPEC.md §3）。それより古いと背景色が消えるなど、
/// 画面が正しく表示されないので、起動時に版を確かめて知らせる。
/// </summary>
public static class WebView2Runtime
{
    /// <summary>対応する Chromium の主版数の下限。Windows 7 / 8.1 向けの WebView2 の最終版で、企業で固定されがちな版。</summary>
    public const int MinimumMajorVersion = 109;

    /// <summary>
    /// "109.0.1518.140" のような版の文字列から主版数を取る。
    /// "131.0.2903.70 beta" のように後ろに何か付いていても、先頭の数字の並びが主版数なら読む。読めなければ false。
    /// </summary>
    public static bool TryGetMajorVersion(string? versionString, out int major)
    {
        major = 0;
        if (string.IsNullOrWhiteSpace(versionString))
        {
            return false;
        }

        var s = versionString.Trim();
        var end = 0;
        while (end < s.Length && s[end] is >= '0' and <= '9')
        {
            end++;
        }

        // 数字で始まり、そのあとが '.' か終端のときだけ版とみなす（"abc1.2" や "12abc" は壊れた文字列）
        if (end == 0 || (end < s.Length && s[end] != '.'))
        {
            return false;
        }

        return int.TryParse(s.AsSpan(0, end), NumberStyles.None, CultureInfo.InvariantCulture, out major);
    }

    /// <summary>
    /// 古すぎて画面が正しく表示されないおそれがあるか。主版数が下限未満のときだけ true。
    /// 版が読めないときは false（確かめられないものを古いと決めつけて、利用者を不安にさせない）。
    /// </summary>
    public static bool IsTooOld(string? versionString) =>
        TryGetMajorVersion(versionString, out var major) && major < MinimumMajorVersion;
}
