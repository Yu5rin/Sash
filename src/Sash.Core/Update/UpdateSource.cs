namespace Sash.Core.Update;

public enum UpdateSourceKind
{
    /// <summary>GitHub のリリース（既定）。Atom フィードで確認し、配布物の URL は規則で組み立てる。</summary>
    GitHub,

    /// <summary>社内の Web サーバーなどに置いた latest.json（https）。</summary>
    Manifest,

    /// <summary>社内の共有フォルダやローカルのフォルダ（latest.json と exe を置く）。</summary>
    Folder,
}

/// <summary>
/// 更新の確認先。設定の文字列から決める。
/// ・空 → GitHub（既定）
/// ・https:// で始まる → latest.json の URL（末尾がフォルダなら latest.json を補う）
/// ・それ以外（\\server\share\Sash、C:\Sash\updates など）→ フォルダ
/// </summary>
public sealed record UpdateSource(UpdateSourceKind Kind, string Location)
{
    public const string DefaultOwner = "Yu5rin";
    public const string DefaultRepo = "Sash";
    public const string ManifestFileName = "latest.json";

    public static UpdateSource Default { get; } = new(UpdateSourceKind.GitHub, $"https://github.com/{DefaultOwner}/{DefaultRepo}");

    public static UpdateSource Parse(string? text)
    {
        var s = text?.Trim() ?? "";
        if (s.Length == 0)
        {
            return Default;
        }

        if (Uri.TryCreate(s, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp))
        {
            if (uri.Scheme != Uri.UriSchemeHttps)
            {
                throw new ArgumentException("更新の確認先には https の URL を指定してください（http は途中で書き換えられるおそれがあるため使えません）。");
            }

            // github.com のリポジトリが指定されたら、GitHub の方式で確認する
            var seg = uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase) && seg.Length >= 2)
            {
                return new UpdateSource(UpdateSourceKind.GitHub, $"https://github.com/{seg[0]}/{seg[1]}");
            }

            var url = s.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? s : s.TrimEnd('/') + "/" + ManifestFileName;
            return new UpdateSource(UpdateSourceKind.Manifest, url);
        }

        return new UpdateSource(UpdateSourceKind.Folder, s);
    }

    public bool IsDefault => this == Default;

    /// <summary>GitHub の Atom フィードの URL。</summary>
    public string AtomUrl => $"{Location}/releases.atom";

    /// <summary>GitHub のリリースページ（最新）。</summary>
    public string LatestPageUrl => Kind == UpdateSourceKind.GitHub ? $"{Location}/releases/latest" : Location;

    public string ReleasePageUrl(string tag) => Kind == UpdateSourceKind.GitHub ? $"{Location}/releases/tag/{Uri.EscapeDataString(tag)}" : Location;

    /// <summary>配布物のファイル名（リリースのワークフローと合わせる）。</summary>
    public static string AssetFileName(UpdateVersion v) => $"Sash-{v}-win-x64.exe";

    /// <summary>GitHub のリリースの配布物の URL（API を使わずに規則で組み立てる）。</summary>
    public string GitHubAssetUrl(string tag, UpdateVersion v) =>
        $"{Location}/releases/download/{Uri.EscapeDataString(tag)}/{Uri.EscapeDataString(AssetFileName(v))}";
}
