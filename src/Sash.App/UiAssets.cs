using System.Reflection;

namespace Sash.App;

/// <summary>埋め込みリソース（wwwroot/**）として持っている UI のファイルを返す。</summary>
internal static class UiAssets
{
    /// <summary>UI を配信する仮想オリジン。実在しない .invalid ドメインを使う。</summary>
    public const string Origin = "https://app.sash.invalid";

    private static readonly Assembly Assembly = typeof(UiAssets).Assembly;

    private static readonly Dictionary<string, string> ResourceNames =
        Assembly.GetManifestResourceNames()
            .Where(n => n.StartsWith("wwwroot", StringComparison.Ordinal))
            // Windows でビルドすると RecursiveDir の区切りが \ になるので / にそろえる
            .ToDictionary(n => n.Replace('\\', '/')["wwwroot/".Length..], n => n, StringComparer.OrdinalIgnoreCase);

    public static bool HasIndex => ResourceNames.ContainsKey("index.html");

    public static Stream? Open(string relativePath)
    {
        var key = relativePath.TrimStart('/');
        if (key.Length == 0)
        {
            key = "index.html";
        }

        return ResourceNames.TryGetValue(key, out var name) ? Assembly.GetManifestResourceStream(name) : null;
    }

    public static string ContentTypeOf(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".ttf" => "font/ttf",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
}
