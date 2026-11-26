using static Sash.Core.Localization.Text;

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
/// ・それ以外（\\server\share\Sash、C:\Sash\updates など）→ フォルダ（完全なパスだけ）
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

        // 「://」を含むものは URL として扱い、https 以外は断る（file:// や ftp:// をフォルダとして扱わないため）
        if (s.Contains("://", StringComparison.Ordinal))
        {
            if (!Uri.TryCreate(s, UriKind.Absolute, out var uri))
            {
                throw UserErrors.Argument(L($"更新の確認先の URL を読めません：{s}", $"The update source URL is invalid: {s}"));
            }

            if (uri.Scheme == Uri.UriSchemeHttp)
            {
                throw UserErrors.Argument(L("更新の確認先には https の URL を指定してください（http は途中で書き換えられるおそれがあるため使えません）。", "Use an https URL for the update source (http cannot be used because it can be tampered with in transit)."));
            }

            if (uri.Scheme != Uri.UriSchemeHttps)
            {
                throw UserErrors.Argument(L($"更新の確認先に使える URL は https だけです：{s}", $"Only https URLs can be used as the update source: {s}"));
            }

            // github.com のリポジトリが指定されたら、GitHub の方式で確認する
            var seg = uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase) && seg.Length >= 2)
            {
                return new UpdateSource(UpdateSourceKind.GitHub, $"https://github.com/{seg[0]}/{seg[1]}");
            }

            // .json で終わるかはパスの部分だけで判断する（?token=… などのクエリが付いていても見誤らないように）
            if (uri.AbsolutePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            {
                return new UpdateSource(UpdateSourceKind.Manifest, s);
            }

            var builder = new UriBuilder(uri) { Path = uri.AbsolutePath.TrimEnd('/') + "/" + ManifestFileName };
            // ToString() は %20 などをほどいた表示用の文字列を返すので、空白や日本語を含むパスで別の URL になってしまう。
            // 要求に使う、エスケープしたままの AbsoluteUri を使う
            return new UpdateSource(UpdateSourceKind.Manifest, builder.Uri.AbsoluteUri);
        }

        // フォルダは完全なパス（C:\… か \\server\share\…）だけを受け付ける。
        // 相対パスは、起動したときの作業フォルダしだいで別の場所を指してしまうため
        if (!IsFullyQualifiedFolder(s))
        {
            throw UserErrors.Argument(L($"更新の確認先のフォルダは、ドライブ名から始まるパスか \\\\server\\share の形で指定してください：{s}", $"Specify the update folder as a full path starting with a drive letter, or as \\\\server\\share: {s}"));
        }

        return new UpdateSource(UpdateSourceKind.Folder, s);
    }

    /// <summary>
    /// Windows の完全なパスか。テストを Linux でも動かすため、Path.IsPathFullyQualified（実行中の OS の規則）に加えて
    /// Windows の形（X:\、X:/、\\server\share）も自分で見る。
    /// </summary>
    private static bool IsFullyQualifiedFolder(string s)
    {
        if (s.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return s.Length > 2 && s[2] is not '\\' and not '/';
        }

        if (s.Length >= 3 && char.IsAsciiLetter(s[0]) && s[1] == ':' && s[2] is '\\' or '/')
        {
            return true;
        }

        return Path.IsPathFullyQualified(s);
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
