using System.Runtime.Versioning;
using Microsoft.Win32;
using Sash.Core.Excel;

namespace Sash.Excel;

/// <summary>
/// Excel の Workbook.FullName をローカルのパスにそろえる（Windows の部分）。
/// OneDrive / SharePoint の同期フォルダは、HKCU\Software\SyncEngines\Providers\OneDrive\&lt;id&gt; に
/// UrlNamespace（URL の名前空間）と MountPoint（ローカルのフォルダ）が登録されているので、それを使って直す。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class WorkbookPaths
{
    private const string ProvidersKey = @"Software\SyncEngines\Providers\OneDrive";

    /// <summary>同期フォルダの一覧。読めなければ空（同期していない PC でも動くように）。</summary>
    public static List<SyncMount> ReadSyncMounts()
    {
        var result = new List<SyncMount>();
        try
        {
            using var providers = Registry.CurrentUser.OpenSubKey(ProvidersKey);
            if (providers is null)
            {
                return result;
            }

            foreach (var name in providers.GetSubKeyNames())
            {
                using var key = providers.OpenSubKey(name);
                if (key?.GetValue("UrlNamespace") is string url && key.GetValue("MountPoint") is string mount
                    && url.Length > 0 && mount.Length > 0)
                {
                    result.Add(new SyncMount(url, mount));
                }
            }
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
        }

        return result;
    }

    /// <summary>FullName をローカルのフルパスにする。URL のまま直せなければ null。</summary>
    public static string? ToLocal(string? fullName, IReadOnlyList<SyncMount> mounts)
    {
        if (string.IsNullOrEmpty(fullName))
        {
            return null;
        }

        var local = WorkbookPathMapper.Normalize(fullName, mounts);
        if (WorkbookPathMapper.IsWebUrl(local))
        {
            return null;
        }

        return Full(local);
    }

    /// <summary>Path.GetFullPath でそろえる（「..」や区切りの違いをなくす）。失敗したらそのまま。</summary>
    public static string Full(string path)
    {
        try
        {
            return Path.GetFullPath(path);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return path;
        }
    }

    /// <summary>FullName が fullPath と同じファイルか（URL は同期フォルダのパスに直してから比べる）。</summary>
    public static bool Matches(string? fullName, string fullPath, IReadOnlyList<SyncMount> mounts) =>
        ToLocal(fullName, mounts) is { } local && WorkbookPathMapper.SamePath(local, Full(fullPath));
}
