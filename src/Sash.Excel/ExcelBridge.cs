using System.Runtime.Versioning;

namespace Sash.Excel;

/// <summary>
/// <see cref="IExcelBridge"/> の実装。
/// TODO（第 1 弾）：ROT（実行中オブジェクト テーブル）を列挙して全 Excel インスタンスを調べる処理と、
/// 保存・クローズ・書き込み・再オープンの反映処理を実装する。
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ExcelBridge : IExcelBridge
{
    public OpenWorkbookInfo? FindOpenWorkbook(string fullPath) =>
        ListOpenWorkbooks().FirstOrDefault(w => string.Equals(w.FullPath, fullPath, StringComparison.OrdinalIgnoreCase));

    public IReadOnlyList<OpenWorkbookInfo> ListOpenWorkbooks()
    {
        if (!ExcelEnvironment.IsInstalled)
        {
            return [];
        }

        throw new NotImplementedException("Excel インスタンスの列挙は未実装です。");
    }
}
