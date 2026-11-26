using System.Globalization;

namespace Sash.Core.Packaging;

/// <summary>
/// ファイルに付く「インターネットから取得した」印（Zone.Identifier という NTFS の代替データ ストリーム。仕様書 §23.5）。
/// 印の付いたブックは、Office がマクロを既定でブロックする（保護ビュー・「セキュリティ リスク」の表示）ので、
/// 配布したブックのリボンが配布先で出ない原因になる。印の有無を見るだけで、付け外しはしない。
/// </summary>
public static class MarkOfTheWeb
{
    /// <summary>ファイルに「インターネット」（ゾーン 3）以上の印が付いているか。Windows 以外・読めないときは false。</summary>
    public static bool IsMarked(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            // NTFS の代替データ ストリームは「ファイル名:ストリーム名」で読める。ないときは例外になる
            return ZoneOf(File.ReadAllText(path + ":Zone.Identifier")) >= 3;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return false;
        }
    }

    /// <summary>Zone.Identifier の中身（INI 形式）から ZoneId を読む。なければ null。0 = ローカル、1 = イントラネット、2 = 信頼済み、3 = インターネット、4 = 制限付き。</summary>
    internal static int? ZoneOf(string content)
    {
        foreach (var raw in content.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("ZoneId=", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(line["ZoneId=".Length..].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var zone))
            {
                return zone;
            }
        }

        return null;
    }
}
