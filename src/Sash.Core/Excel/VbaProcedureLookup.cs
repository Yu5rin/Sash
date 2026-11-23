using System.Text.RegularExpressions;

namespace Sash.Core.Excel;

/// <summary>
/// VBA のコードから Sub / Function の宣言を探す（「試しに押す」で、引数のない Sub だけを実行するため。仕様書 §18.4）。
/// COM に触らない部分だけを置き、単体テストできるようにする。UI 側の解析（ui/src/vba.ts の parseProcedures）と同じ考え方にする。
/// </summary>
public static partial class VbaProcedureLookup
{
    /// <summary>
    /// コードの中から name の Sub / Function を探し、引数リスト（括弧の中身、前後の空白を除く）を返す。見つからなければ null。
    /// 名前は大文字・小文字を区別しない（VBA と同じ）。行継続（行末の " _"）はつないでから調べる。
    /// </summary>
    public static string? FindParameters(string code, string name)
    {
        foreach (var line in JoinContinuations(code))
        {
            var m = DeclarationPattern().Match(line);
            if (m.Success && string.Equals(m.Groups["name"].Value, name, StringComparison.OrdinalIgnoreCase))
            {
                return m.Groups["params"].Value.Trim();
            }
        }

        return null;
    }

    /// <summary>
    /// コールバック属性の値（"Module1.Name" や "Book.xlsm!Name" を含む）を、モジュール名（あれば）と Sub 名に分ける。
    /// "Book.xlsm!Module1.Name" のようにブック名が付いていれば外す（実行するブックは Sash が開いているものに決まっているため）。
    /// </summary>
    public static (string? Module, string Procedure) Split(string macro)
    {
        var bare = macro.Trim();
        var bang = bare.LastIndexOf('!');
        if (bang >= 0)
        {
            bare = bare[(bang + 1)..];
        }

        var dot = bare.LastIndexOf('.');
        return dot >= 0 ? (bare[..dot], bare[(dot + 1)..]) : (null, bare);
    }

    /// <summary>
    /// Application.Run に渡す名前（'ブック名'!モジュール.Sub）にする。ブック名の ' は '' にする（Excel の参照の書き方）。
    /// ブック名を付けるのは、同じ名前の Sub がほかのブックやアドインにあっても、開いているブックのものを実行するため。
    /// </summary>
    public static string QualifiedName(string workbookName, string? module, string procedure) =>
        $"'{workbookName.Replace("'", "''", StringComparison.Ordinal)}'!{(string.IsNullOrEmpty(module) ? string.Empty : module + ".")}{procedure}";

    private static IEnumerable<string> JoinContinuations(string code)
    {
        var current = string.Empty;
        foreach (var raw in code.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.EndsWith(" _", StringComparison.Ordinal))
            {
                current += line[..^1];
                continue;
            }

            yield return current + line;
            current = string.Empty;
        }

        if (current.Length > 0)
        {
            yield return current;
        }
    }

    [GeneratedRegex(@"^\s*(?:(?:Public|Private|Friend)\s+)?(?:Static\s+)?(?:Sub|Function)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)\s*\((?<params>(?:[^()]|\(\))*)\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DeclarationPattern();
}
