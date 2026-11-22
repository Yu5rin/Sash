namespace Sash.App;

/// <summary>設定・バックアップ・アイコンライブラリの保存先（仕様書 §3：%AppData%\Sash）。</summary>
internal static class AppPaths
{
    public static string Root { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Sash");

    public static string Backups => Path.Combine(Root, "backups");

    public static string Icons => Path.Combine(Root, "icons");

    public static string Settings => Path.Combine(Root, "settings.json");

    /// <summary>Excel から取得した imageMso の画像のキャッシュ。</summary>
    public static string ImageMsoCache => Path.Combine(Root, "cache", "imageMso");

    /// <summary>WebView2 のユーザーデータ（キャッシュなど）。</summary>
    public static string WebView2Data =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sash", "WebView2");
}
