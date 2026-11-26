namespace Sash.App;

/// <summary>設定・バックアップ・アイコンライブラリの保存先（仕様書 §3：%AppData%\Sash）。</summary>
internal static class AppPaths
{
    public static string Root { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Sash");

    public static string Backups => Path.Combine(Root, "backups");

    /// <summary>未保存の編集の退避（仕様書 §23.2）。</summary>
    public static string Recovery => Path.Combine(Root, "recovery");

    public static string Icons => Path.Combine(Root, "icons");

    public static string Settings => Path.Combine(Root, "settings.json");

    public static string Recipes => Path.Combine(Root, "recipes.json");

    /// <summary>Excel から取得した imageMso の画像のキャッシュ。</summary>
    public static string ImageMsoCache => Path.Combine(Root, "cache", "imageMso");

    /// <summary>WebView2 のユーザーデータ（キャッシュなど）。</summary>
    public static string WebView2Data =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sash", "WebView2");
}
