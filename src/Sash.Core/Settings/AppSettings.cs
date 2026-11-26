using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sash.Core.Settings;

/// <summary>利用者の設定。%AppData%\Sash\settings.json に保存する。</summary>
public sealed record AppSettings
{
    /// <summary>system / light / dark。</summary>
    public string Theme { get; init; } = "system";

    /// <summary>XML エディタをキャンバスの上に置く。</summary>
    public bool XmlOnTop { get; init; }

    /// <summary>アイコンの出力サイズ（32 か 64）。</summary>
    public int IconSize { get; init; } = 32;

    /// <summary>「アドインのユーザー インターフェイス エラーを表示する」の案内を出したか。</summary>
    public bool RibbonErrorsHintShown { get; init; }

    /// <summary>バックアップの世代数。</summary>
    public int BackupGenerations { get; init; } = 10;

    /// <summary>コールバック名の規則。{id} と {attr} を置き換える。</summary>
    public string CallbackPattern { get; init; } = "Ribbon_{id}_{attr}";

    /// <summary>複数のコントロールで 1 つの Sub を共有し、control.Id で振り分ける。</summary>
    public bool CallbackShared { get; init; }

    /// <summary>共有するときのコールバック名の規則。{attr} を置き換える。</summary>
    public string CallbackSharedPattern { get; init; } = "Ribbon_{attr}";

    /// <summary>VBA の雛形を挿入する標準モジュール。</summary>
    public string CallbackModule { get; init; } = "modRibbon";

    /// <summary>アイコンライブラリの場所。空なら %AppData%\Sash\icons。共有フォルダも指定できる。</summary>
    public string? IconLibraryPath { get; init; }

    /// <summary>お気に入りのアイコン（ライブラリの id）。共有フォルダを使っていても、お気に入りは人ごとに持つ。</summary>
    public IReadOnlyList<string> IconFavorites { get; init; } = [];

    /// <summary>画面の言語（ja / en）。</summary>
    public string Language { get; init; } = "ja";

    /// <summary>起動時に更新を確認する。</summary>
    public bool UpdateCheckOnStartup { get; init; } = true;

    /// <summary>更新の確認先。空なら GitHub のリリース。社内の共有フォルダや https の latest.json も指定できる。</summary>
    public string UpdateSource { get; init; } = "";

    /// <summary>前回終了時のウィンドウの位置と大きさ。null なら既定（WindowPlacement）。UI の設定画面からは変えない。</summary>
    public WindowBounds? Window { get; init; }

    /// <summary>最近使ったファイル（新しい順）。</summary>
    public IReadOnlyList<string> RecentFiles { get; init; } = [];
}

/// <summary>
/// 設定の読み書き。読むだけのとき（起動時など）は、壊れたファイルや読めないファイルを既定値として扱い、起動を妨げない。
/// 書き換えるときは、読めなかったファイルを既定値で上書きしないよう、読めなければ中止する（壊れていれば .bak に退避してから書く）。
/// </summary>
public sealed class SettingsStore(string path)
{
    public const int MaxRecentFiles = 15;

    private static readonly string[] Themes = ["system", "light", "dark"];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private readonly Lock _lock = new();

    public string Path { get; } = path;

    public AppSettings Load()
    {
        lock (_lock)
        {
            try
            {
                var text = JsonFile.ReadText(Path);
                return text is null ? new AppSettings() : Normalize(JsonSerializer.Deserialize<AppSettings>(text, Json));
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                return new AppSettings();
            }
        }
    }

    public AppSettings Update(Func<AppSettings, AppSettings> change)
    {
        lock (_lock)
        {
            var next = Normalize(change(LoadForUpdate()));
            JsonFile.WriteAtomic(Path, JsonSerializer.Serialize(next, Json));
            return next;
        }
    }

    /// <summary>書き換えの前に読む。読めなければ投げ、壊れていれば退避して既定値から始める。</summary>
    private AppSettings LoadForUpdate()
    {
        var text = JsonFile.ReadTextForUpdate(Path);
        if (text is null)
        {
            return new AppSettings();
        }

        try
        {
            return Normalize(JsonSerializer.Deserialize<AppSettings>(text, Json));
        }
        catch (JsonException)
        {
            JsonFile.MoveAside(Path);
            return new AppSettings();
        }
    }

    /// <summary>
    /// 手で書き換えた設定ファイルや古い版のファイルで、null や範囲外の値が入っていても動くようにそろえる。
    /// JSON に "recentFiles": null とあると、宣言では null にならない型でも null が入るため。
    /// </summary>
    internal static AppSettings Normalize(AppSettings? s)
    {
        var d = new AppSettings();
        if (s is null)
        {
            return d;
        }

        return s with
        {
            Theme = s.Theme is not null && Themes.Contains(s.Theme, StringComparer.Ordinal) ? s.Theme : d.Theme,
            IconSize = s.IconSize is 32 or 64 ? s.IconSize : d.IconSize,
            BackupGenerations = Math.Clamp(s.BackupGenerations, 1, 100),
            Language = s.Language is "ja" or "en" ? s.Language : d.Language,
            CallbackPattern = string.IsNullOrWhiteSpace(s.CallbackPattern) ? d.CallbackPattern : s.CallbackPattern,
            CallbackSharedPattern = string.IsNullOrWhiteSpace(s.CallbackSharedPattern) ? d.CallbackSharedPattern : s.CallbackSharedPattern,
            CallbackModule = string.IsNullOrWhiteSpace(s.CallbackModule) ? d.CallbackModule : s.CallbackModule,
            UpdateSource = s.UpdateSource ?? d.UpdateSource,
            // 手で書き換えて壊れた値（0 や負の大きさ）は捨てて、既定の置き方にする
            Window = s.Window is { Width: > 0, Height: > 0 } ? s.Window : null,
            IconFavorites = s.IconFavorites?.OfType<string>().ToList() ?? [],
            RecentFiles = s.RecentFiles?.OfType<string>().Where(p => p.Length > 0).ToList() ?? [],
        };
    }

    /// <summary>最近使ったファイルの先頭に追加する（同じパスは1つにまとめる）。</summary>
    public AppSettings AddRecent(string fullPath) => Update(s => s with
    {
        RecentFiles = [fullPath, .. s.RecentFiles.Where(p => !string.Equals(p, fullPath, StringComparison.OrdinalIgnoreCase)).Take(MaxRecentFiles - 1)],
    });

    public AppSettings RemoveRecent(string fullPath) => Update(s => s with
    {
        RecentFiles = s.RecentFiles.Where(p => !string.Equals(p, fullPath, StringComparison.OrdinalIgnoreCase)).ToList(),
    });
}
