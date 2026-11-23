using System.Text.RegularExpressions;
using static Sash.Core.Localization.Text;

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
    /// 引数の既定値の中の括弧（Optional v = Array(1, 2) など）や、文字列の中の括弧も数えて、宣言の閉じ括弧を探す
    /// （正規表現で「括弧の外の文字」だけを拾うと、入れ子の括弧で宣言を見落とすため）。
    /// </summary>
    public static string? FindParameters(string code, string name)
    {
        foreach (var line in JoinContinuations(code))
        {
            var m = DeclarationPattern().Match(line);
            if (m.Success && string.Equals(m.Groups["name"].Value, name, StringComparison.OrdinalIgnoreCase)
                && ReadParenthesized(line, m.Index + m.Length) is { } parameters)
            {
                return parameters.Trim();
            }
        }

        return null;
    }

    /// <summary>
    /// 開き括弧の直後（start）から、対応する閉じ括弧までの中身を返す。閉じていなければ null。
    /// 文字列（"..."、"" は文字列の中の " ）の中の括弧は数えない。
    /// </summary>
    private static string? ReadParenthesized(string text, int start)
    {
        int depth = 1;
        bool inString = false;
        for (int i = start; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '"')
            {
                inString = !inString;
            }
            else if (!inString && c == '(')
            {
                depth++;
            }
            else if (!inString && c == ')' && --depth == 0)
            {
                return text[start..i];
            }
        }

        return null;
    }

    /// <summary>引数リストを、括弧と文字列の外にあるカンマで分ける（既定値の Array(1, 2) を分けないため）。</summary>
    public static IReadOnlyList<string> SplitParameters(string parameters)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(parameters))
        {
            return result;
        }

        int depth = 0;
        bool inString = false;
        int from = 0;
        for (int i = 0; i < parameters.Length; i++)
        {
            char c = parameters[i];
            if (c == '"')
            {
                inString = !inString;
            }
            else if (!inString && c == '(')
            {
                depth++;
            }
            else if (!inString && c == ')')
            {
                depth--;
            }
            else if (!inString && depth == 0 && c == ',')
            {
                result.Add(parameters[from..i].Trim());
                from = i + 1;
            }
        }

        result.Add(parameters[from..].Trim());
        return result;
    }

    /// <summary>
    /// Sash から Application.Run で呼べる形かを決める（仕様書 §18.4）。
    /// 引数なし → そのまま呼ぶ。引数が 1 つで、型が IRibbonControl・Object・Variant（型なしを含む）のもの → control に Nothing を渡して呼ぶ。
    /// それ以外（引数が 2 つ以上・配列・ParamArray・String などほかの型）→ 呼べない（reason に理由）。
    /// </summary>
    public static MacroCallShape Classify(string parameters, out string? reason)
    {
        reason = null;
        var list = SplitParameters(parameters);
        if (list.Count == 0)
        {
            return MacroCallShape.NoArguments;
        }

        if (list.Count > 1)
        {
            reason = L($"引数が {list.Count} つ（{parameters.Trim()}）あるため、Sash からは実行できません。", $"It takes {list.Count} arguments ({parameters.Trim()}), so Sash cannot run it.");
            return MacroCallShape.Unsupported;
        }

        var m = ParameterPattern().Match(list[0]);
        if (!m.Success || m.Groups["paramArray"].Success || m.Groups["array"].Success)
        {
            reason = L($"引数（{list[0]}）の形が IRibbonControl ではないため、Sash からは実行できません。", $"Its argument ({list[0]}) is not an IRibbonControl, so Sash cannot run it.");
            return MacroCallShape.Unsupported;
        }

        var type = m.Groups["type"].Success ? m.Groups["type"].Value : "Variant";
        var bare = type.StartsWith("Office.", StringComparison.OrdinalIgnoreCase) ? type["Office.".Length..] : type;
        if (bare.Equals("IRibbonControl", StringComparison.OrdinalIgnoreCase) || bare.Equals("Object", StringComparison.OrdinalIgnoreCase) || bare.Equals("Variant", StringComparison.OrdinalIgnoreCase))
        {
            return MacroCallShape.RibbonControl;
        }

        reason = L($"引数の型が {type} のため、Sash からは実行できません（実行できるのは、引数がないか、IRibbonControl を 1 つ受け取る Sub です）。",
            $"Its argument is of type {type}, so Sash cannot run it (only Subs with no arguments or a single IRibbonControl argument can be run).");
        return MacroCallShape.Unsupported;
    }

    /// <summary>
    /// VBA の識別子（モジュール名・Sub 名）として正しいか。文字で始まり、文字・数字・_ だけで、255 文字まで。
    /// Application.Run に渡す名前は Sash が組み立てるので、余計な記号（' ! " 括弧など）が混ざった名前は実行の前に断る
    /// （別のブックのマクロや、意図しない式として解釈させないため）。
    /// </summary>
    public static bool IsVbaIdentifier(string? name) => !string.IsNullOrEmpty(name) && name.Length <= 255 && IdentifierPattern().IsMatch(name);

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

    // 宣言の頭（開き括弧まで）。引数の中身は ReadParenthesized で読む
    [GeneratedRegex(@"^\s*(?:(?:Public|Private|Friend)\s+)?(?:Static\s+)?(?:Sub|Function)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DeclarationPattern();

    // 引数 1 つ分：[Optional] [ByVal|ByRef] [ParamArray] 名前[()] [As 型] [= 既定値]
    [GeneratedRegex(@"^(?:Optional\s+)?(?:(?:ByVal|ByRef)\s+)?(?<paramArray>ParamArray\s+)?[\p{L}_][\p{L}\p{N}_]*\s*(?<array>\(\s*\))?(?:\s+As\s+(?<type>[\p{L}_][\p{L}\p{N}_.]*))?\s*(?:=.*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex ParameterPattern();

    [GeneratedRegex(@"^[\p{L}][\p{L}\p{N}_]*$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierPattern();
}

/// <summary>Application.Run での呼び方（<see cref="VbaProcedureLookup.Classify"/>）。</summary>
public enum MacroCallShape
{
    /// <summary>引数のない Sub。そのまま呼ぶ。</summary>
    NoArguments,

    /// <summary>IRibbonControl（または Object・Variant）を 1 つ受け取る Sub。control に Nothing を渡して呼ぶ。</summary>
    RibbonControl,

    /// <summary>Sash からは呼べない形。</summary>
    Unsupported,
}
