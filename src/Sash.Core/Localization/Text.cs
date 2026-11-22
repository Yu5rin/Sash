namespace Sash.Core.Localization;

/// <summary>
/// ホスト側のメッセージの言語（仕様書 §9.3）。UI と同じ設定（settings.json の language）に合わせる。
/// 文言が少ないので辞書は持たず、呼び出し側で日本語と英語を並べて書く。
/// </summary>
public static class Text
{
    /// <summary>ja か en。</summary>
    public static string Language { get; set; } = "ja";

    public static bool IsEnglish => string.Equals(Language, "en", StringComparison.Ordinal);

    public static string L(string ja, string en) => IsEnglish ? en : ja;
}
