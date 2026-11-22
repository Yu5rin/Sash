using System.Runtime.Versioning;

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
}
