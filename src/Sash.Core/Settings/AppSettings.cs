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

    /// <summary>最近使ったファイル（新しい順）。</summary>
    public IReadOnlyList<string> RecentFiles { get; init; } = [];
}

/// <summary>設定の読み書き。壊れたファイルは既定値として扱い、起動を妨げない。</summary>
public sealed class SettingsStore(string path)
{
    public const int MaxRecentFiles = 15;

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
                if (!File.Exists(Path))
                {
                    return new AppSettings();
                }

                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(Path), Json) ?? new AppSettings();
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
            var next = change(Load());
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            var temp = Path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(next, Json));
            File.Move(temp, Path, overwrite: true);
            return next;
        }
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
