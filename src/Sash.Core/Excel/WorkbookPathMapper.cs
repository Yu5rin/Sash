namespace Sash.Core.Excel;

/// <summary>OneDrive / SharePoint の同期フォルダ 1 つ分（URL の名前空間と、同期先のローカルのフォルダ）。</summary>
/// <param name="UrlNamespace">例：https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents/</param>
/// <param name="MountPoint">例：C:\Users\user\OneDrive - Contoso</param>
public sealed record SyncMount(string UrlNamespace, string MountPoint);

/// <summary>
/// Excel の Workbook.FullName を、ローカルのパスと比べられる形にする（OS に依存しない部分）。
/// OneDrive や SharePoint で同期しているフォルダのブックは、FullName がローカルのパスではなく https の URL になる。
/// そのままではフルパスで開いているブックを探せず、反映が「共有違反」で失敗するので、
/// 同期の設定（URL の名前空間 → ローカルのフォルダ）を使ってローカルのパスに直す。
/// </summary>
public static class WorkbookPathMapper
{
    /// <summary>https の URL を、同期フォルダの中のローカルのパスに直す。どの同期フォルダにも当てはまらなければ null。</summary>
    public static string? ToLocalPath(string url, IEnumerable<SyncMount> mounts)
    {
        ArgumentNullException.ThrowIfNull(mounts);
        if (!IsWebUrl(url))
        {
            return null;
        }

        var target = Unescape(url);
        SyncMount? best = null;
        string? bestPrefix = null;
        foreach (var m in mounts)
        {
            if (string.IsNullOrWhiteSpace(m.UrlNamespace) || string.IsNullOrWhiteSpace(m.MountPoint))
            {
                continue;
            }

            var prefix = Unescape(m.UrlNamespace).TrimEnd('/');
            // 名前空間の途中で切れる一致（.../Documents と .../Documents2）は認めない
            if (target.Length > prefix.Length && target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && target[prefix.Length] == '/'
                && (bestPrefix is null || prefix.Length > bestPrefix.Length))
            {
                best = m;
                bestPrefix = prefix;
            }
        }

        if (best is null || bestPrefix is null)
        {
            return null;
        }

        // Excel の FullName は URL エスケープされていない（空白も「#」もそのまま）ので、「?」「#」で切ったりはしない
        var rest = target[(bestPrefix.Length + 1)..];
        if (rest.Length == 0)
        {
            return null;
        }

        return best.MountPoint.TrimEnd('\\', '/') + "\\" + rest.Replace('/', '\\');
    }

    /// <summary>FullName を比べる形にそろえる。URL は同期フォルダのパスに直し、直せなければそのまま返す。</summary>
    public static string Normalize(string fullName, IEnumerable<SyncMount> mounts) =>
        ToLocalPath(fullName, mounts) ?? fullName;

    /// <summary>Windows のパスとして同じものを指すか（大文字と小文字、区切り文字の向き、末尾の区切りの違いは無視する）。</summary>
    public static bool SamePath(string? a, string? b)
    {
        if (a is null || b is null)
        {
            return false;
        }

        static string Canon(string p) => p.Replace('/', '\\').TrimEnd('\\');
        return string.Equals(Canon(a), Canon(b), StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsWebUrl(string? text) =>
        text is not null && (text.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || text.StartsWith("http://", StringComparison.OrdinalIgnoreCase));

    private static string Unescape(string s)
    {
        try
        {
            return Uri.UnescapeDataString(s);
        }
        catch (UriFormatException)
        {
            return s;
        }
    }
}
