using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Sash.Excel;

/// <summary>
/// Excel の有無を調べる。Excel が入っていない PC では連携機能をグレーアウトし、
/// ファイル編集だけを使えるようにする（仕様書 §3、§7.2）。
/// </summary>
[SupportedOSPlatform("windows")]
public static class ExcelEnvironment
{
    private const string ProgId = "Excel.Application";

    /// <summary>Excel の COM クラスが登録されているか。Excel を起動はしない。</summary>
    public static bool IsInstalled => Type.GetTypeFromProgID(ProgId, throwOnError: false) is not null;

    /// <summary>
    /// 入っている Excel の版（例：16.0.19029）。Application.Version と Build をつないだものと同じ形にする。
    /// imageMso のキャッシュを作った版と比べ、Excel が更新されたら取り込み直しを勧めるために使う。
    /// Excel を起動しないよう、登録された EXCEL.EXE のファイルの版から読む。分からなければ null。
    /// </summary>
    public static string? InstalledVersion()
    {
        try
        {
            const string AppPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe";
            var exe = (Registry.CurrentUser.OpenSubKey(AppPath)?.GetValue(null) ?? Registry.LocalMachine.OpenSubKey(AppPath)?.GetValue(null)) as string;
            if (string.IsNullOrWhiteSpace(exe))
            {
                return null;
            }

            exe = Environment.ExpandEnvironmentVariables(exe.Trim('"'));
            if (!File.Exists(exe))
            {
                return null;
            }

            var info = FileVersionInfo.GetVersionInfo(exe);
            return string.Create(CultureInfo.InvariantCulture, $"{info.FileMajorPart}.{info.FileMinorPart}.{info.FileBuildPart}");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return null;
        }
    }
}
