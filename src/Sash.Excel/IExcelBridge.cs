namespace Sash.Excel;

/// <summary>開いているブックの情報。</summary>
/// <param name="FullPath">ブックのフルパス。</param>
/// <param name="IsAddIn">アドイン（xlam）として読み込まれているか。</param>
/// <param name="IsDirty">未保存の変更があるか。</param>
public sealed record OpenWorkbookInfo(string FullPath, bool IsAddIn, bool IsDirty);

/// <summary>
/// Excel との連携窓口。COM は遅延バインド（dynamic）で呼び、Interop アセンブリは同梱しない。
/// 反映の流れは仕様書 §7.1 を参照。
/// </summary>
public interface IExcelBridge
{
    /// <summary>実行中の全 Excel インスタンスから、フルパスが一致するブックを探す。</summary>
    OpenWorkbookInfo? FindOpenWorkbook(string fullPath);

    /// <summary>実行中の全 Excel インスタンスで開いている xlsm / xlam を列挙する。</summary>
    IReadOnlyList<OpenWorkbookInfo> ListOpenWorkbooks();
}
