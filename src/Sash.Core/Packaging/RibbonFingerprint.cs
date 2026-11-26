using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Sash.Core.CustomUI;

namespace Sash.Core.Packaging;

/// <summary>
/// ブックの中のリボン（customUI の XML と画像）の「内容の照合値」（仕様書 §23.4）。
/// 開いたあとにほかのプログラム（Excel など）や別の人がリボンを書き換えたかを、バイト列ではなく内容で比べるために使う。
/// バイト列で比べると、Excel が保存し直しただけでパーツの書き方（属性の順・空白・宣言・名前空間の接頭辞）が変わって、
/// 誰も変えていないのに「変更された」と出てしまうため、XML を読んで正規化した形で比べる。
/// 正規化で無視するもの：XML 宣言、属性の順、タグの間の空白、コメント、名前空間の接頭辞（名前空間の URI は比べる）、
/// 画像を指す image 属性の値（画像の Id ではなく、指している画像の中身で比べる。リレーション Id が振り直されても同じになる）。
/// 比べるもの：要素の名前・並び順・属性の値・文字、画像の中身（SHA-256）。
/// </summary>
public static class RibbonFingerprint
{
    /// <summary>ブックのリボンの照合値。パーツ（customUI14 / customUI）ごとに 1 つ。パーツがなければ空。キーは office2010 / office2007。</summary>
    public static IReadOnlyDictionary<string, string> Compute(RibbonDocument doc)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in doc.Parts)
        {
            result[KeyOf(part.Version)] = Compute(part);
        }

        return result;
    }

    /// <summary>JSON のキー（UI の CustomUIVersion と同じ表記）。</summary>
    public static string KeyOf(CustomUIVersion version) => version == CustomUIVersion.Office2010 ? "office2010" : "office2007";

    /// <summary>パーツ 1 つの照合値。</summary>
    public static string Compute(CustomUIPart part)
    {
        var imageHashes = part.Images.ToDictionary(i => i.RelationshipId, i => Hash(i.Data), StringComparer.Ordinal);
        var sb = new StringBuilder();
        sb.Append(Canonical(part.Xml, imageHashes));
        sb.Append('\n');
        // 画像の組（中身だけ。Id の付け方は問わない）。使われていない画像が増えた・減ったときも変更として扱う
        foreach (var h in imageHashes.Values.Order(StringComparer.Ordinal))
        {
            sb.Append("img:").Append(h).Append('\n');
        }

        return Hash(Encoding.UTF8.GetBytes(sb.ToString()));
    }

    /// <summary>2 つの照合値が同じか（パーツの種類も、その照合値も同じ）。</summary>
    public static bool Same(IReadOnlyDictionary<string, string>? a, IReadOnlyDictionary<string, string>? b)
    {
        if (a is null || b is null || a.Count != b.Count)
        {
            return false;
        }

        return a.All(kv => b.TryGetValue(kv.Key, out var other) && string.Equals(kv.Value, other, StringComparison.Ordinal));
    }

    /// <summary>XML を正規化した文字列にする。XML として読めなければ、改行をそろえた生の文字列で代用する（同じ中身なら同じ値になる）。</summary>
    internal static string Canonical(string xml, IReadOnlyDictionary<string, string> imageHashes)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(xml, LoadOptions.None);
        }
        catch (System.Xml.XmlException)
        {
            return "invalid:" + xml.Replace("\r\n", "\n", StringComparison.Ordinal).Trim();
        }

        var sb = new StringBuilder();
        if (doc.Root is { } root)
        {
            Append(sb, root, imageHashes);
        }

        return sb.ToString();
    }

    private static void Append(StringBuilder sb, XElement el, IReadOnlyDictionary<string, string> imageHashes)
    {
        sb.Append('<').Append(el.Name.NamespaceName).Append('|').Append(el.Name.LocalName);
        foreach (var attr in el.Attributes().Where(a => !a.IsNamespaceDeclaration).OrderBy(a => a.Name.NamespaceName, StringComparer.Ordinal).ThenBy(a => a.Name.LocalName, StringComparer.Ordinal))
        {
            var value = attr.Value;
            if (attr.Name.LocalName == "image" && imageHashes.TryGetValue(value, out var hash))
            {
                value = "img:" + hash;
            }

            sb.Append(' ').Append(attr.Name.NamespaceName).Append('|').Append(attr.Name.LocalName).Append("=\"").Append(value.Replace("\"", "&quot;", StringComparison.Ordinal)).Append('"');
        }

        sb.Append('>');
        foreach (var node in el.Nodes())
        {
            switch (node)
            {
                case XElement child:
                    Append(sb, child, imageHashes);
                    break;
                case XText text when !string.IsNullOrWhiteSpace(text.Value):
                    // コメントは含めない。タグの間の空白だけの文字も含めない（整形し直されても同じになる）
                    sb.Append("T:").Append(text.Value.Trim()).Append(';');
                    break;
            }
        }

        sb.Append("</>");
    }

    private static string Hash(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
}
