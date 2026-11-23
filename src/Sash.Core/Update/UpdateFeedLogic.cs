using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Sash.Core.Update;

/// <summary>確認の結果わかった、最新版の情報。</summary>
/// <param name="Version">版。</param>
/// <param name="Tag">GitHub のタグ（v1.2.3）。latest.json のときは版の文字列。</param>
/// <param name="DownloadUrl">exe の場所（https の URL か、フォルダの中のファイルのフルパス）。</param>
/// <param name="Sha256">照合値（小文字 16 進 64 文字）。GitHub のときは別ファイルから取るので、ここでは null。</param>
/// <param name="ChecksumUrl">照合値ファイル（.sha256）の場所。latest.json に照合値があるときは null。</param>
/// <param name="Notes">更新内容（あれば）。</param>
/// <param name="PageUrl">利用者に案内するページやフォルダ。</param>
public sealed record UpdateRelease(UpdateVersion Version, string Tag, string DownloadUrl, string? Sha256, string? ChecksumUrl, string? Notes, string PageUrl);

/// <summary>
/// 更新の確認で、通信を含まない判定をまとめたもの（テストできるようにするため）。
/// 方式は、同じ作者の Graft・Pane が社内の共有回線で実際に踏んだ不具合への対策に倣っている。
/// ・GitHub API には未認証で 1 時間 60 回・IP 単位の上限があり、社内の共有回線では他の通信で先に使い切られる。
///   そこで確認は上限の対象外の Atom フィードで行い、配布物の URL は API に聞かずに規則で組み立てる。
/// ・照合値はリリースに添付した .sha256 ファイル（通常のダウンロード）から取る。
/// </summary>
public static partial class UpdateFeedLogic
{
    /// <summary>
    /// Atom フィードから、いちばん新しい版のタグを取り出す。並び順には頼らず、解釈できる版のうち最大のものを選ぶ
    /// （リリースの削除や作り直しで並びが変わることがあるため）。
    /// </summary>
    public static (string Tag, UpdateVersion Version)? LatestFromAtom(string xml)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(xml, LoadOptions.None);
        }
        catch (XmlException)
        {
            return null;
        }

        (string, UpdateVersion)? best = null;
        foreach (var link in doc.Descendants().Where(e => e.Name.LocalName == "link"))
        {
            var href = link.Attribute("href")?.Value;
            var m = href is null ? null : TagInUrl().Match(href);
            if (m is null || !m.Success)
            {
                continue;
            }

            var tag = Uri.UnescapeDataString(m.Groups[1].Value);
            if (UpdateVersion.TryParse(tag, out var v) && (best is null || v > best.Value.Item2))
            {
                best = (tag, v);
            }
        }

        return best;
    }

    /// <summary>.sha256 ファイルの中身から照合値を取り出す（「値」だけでも「値  ファイル名」でもよい）。</summary>
    public static string? ParseChecksum(string text, string? expectedFileName = null)
    {
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            var m = Sha256Line().Match(line);
            if (!m.Success)
            {
                continue;
            }

            var name = m.Groups[2].Value.TrimStart('*').Trim();
            if (expectedFileName is null || name.Length == 0 || string.Equals(name, expectedFileName, StringComparison.OrdinalIgnoreCase))
            {
                return m.Groups[1].Value.ToLowerInvariant();
            }
        }

        return null;
    }

    /// <summary>GitHub の最新版の情報を組み立てる。配布物と照合値の URL は規則どおりに作る。</summary>
    public static UpdateRelease ForGitHub(UpdateSource source, string tag, UpdateVersion version)
    {
        var url = source.GitHubAssetUrl(tag, version);
        return new UpdateRelease(version, tag, url, null, url + ".sha256", null, source.ReleasePageUrl(tag));
    }

    /// <summary>
    /// latest.json を読む。形式：{ "version": "1.2.3", "file": "Sash-1.2.3-win-x64.exe", "sha256": "…", "notes": "…" }。
    /// file は latest.json と同じ場所からの相対名で、別のホストや別のフォルダを指すことはできない
    /// （確認先を書き換えられたときに、よその配布物を入れられないようにするため）。
    /// </summary>
    public static UpdateRelease ForManifest(UpdateSource source, string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        string? Str(string name) => root.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

        var versionText = Str("version") ?? throw new FormatException("latest.json に version がありません。");
        if (!UpdateVersion.TryParse(versionText, out var version))
        {
            throw new FormatException($"latest.json の version を版として読めません：{versionText}");
        }

        var file = Str("file") ?? UpdateSource.AssetFileName(version);
        if (file.Contains('/') || file.Contains('\\') || file.Contains("..", StringComparison.Ordinal) || file.Contains(':'))
        {
            throw new FormatException("latest.json の file には、同じ場所にあるファイルの名前だけを書いてください。");
        }

        var sha = Str("sha256")?.Trim().ToLowerInvariant();
        if (sha is null || !Sha256Hex().IsMatch(sha))
        {
            throw new FormatException("latest.json に正しい sha256（64 桁の 16 進）がありません。");
        }

        string download;
        string page;
        if (source.Kind == UpdateSourceKind.Folder)
        {
            download = Path.Combine(source.Location, file);
            page = source.Location;
        }
        else
        {
            var baseUri = new Uri(source.Location);
            download = new Uri(baseUri, Uri.EscapeDataString(file)).ToString();
            page = new Uri(baseUri, ".").ToString();
        }

        return new UpdateRelease(version, versionText, download, sha, null, Str("notes"), page);
    }

    /// <summary>latest.json を作る（リリースのワークフローと社内向けの配置で使う形と同じ）。</summary>
    public static string BuildManifest(UpdateVersion version, string sha256, string? notes = null) =>
        JsonSerializer.Serialize(new { version = version.ToString(), file = UpdateSource.AssetFileName(version), sha256, notes }, new JsonSerializerOptions { WriteIndented = true });

    [GeneratedRegex(@"/releases/tag/([^/?#]+)")]
    private static partial Regex TagInUrl();

    [GeneratedRegex(@"^([0-9a-fA-F]{64})(?:\s+(.*))?$")]
    private static partial Regex Sha256Line();

    [GeneratedRegex(@"^[0-9a-f]{64}$")]
    private static partial Regex Sha256Hex();
}
