using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Sash.Core.Localization.Text;

namespace Sash.Core.Library;

/// <summary>ライブラリのアイコン 1 つ分の情報。</summary>
public sealed record LibraryIcon
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public IReadOnlyList<string> Tags { get; init; } = [];

    public DateTimeOffset CreatedAt { get; init; }

    /// <summary>元画像のファイル名（あれば加工し直せる）。</summary>
    public string? SourceName { get; init; }

    public string? SourceContentType { get; init; }

    /// <summary>アイコンエディタの加工設定（形は UI が決める）。</summary>
    public JsonObject? Options { get; init; }
}

/// <summary>
/// アイコンライブラリ（仕様書 §6.4）。加工済みのアイコンを、元画像と加工設定ごとフォルダに保存する。
/// 共有フォルダに置いて複数人で使えるよう、1 つのアイコンを「id.json・id.png・id.source」の 3 ファイルで持ち、
/// 全体の目録ファイルは作らない（同時に書き込んでも壊れにくくするため）。
/// </summary>
public sealed partial class IconLibrary(string root)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public string Root { get; } = root;

    public IReadOnlyList<LibraryIcon> List()
    {
        if (!Directory.Exists(Root))
        {
            return [];
        }

        var result = new List<LibraryIcon>();
        foreach (var file in Directory.EnumerateFiles(Root, "*.json"))
        {
            try
            {
                var icon = JsonSerializer.Deserialize<LibraryIcon>(File.ReadAllText(file), Json);
                // id は json の中身なので信用しない。パスとして危ないものは飛ばす
                if (icon is not null && IsValidId(icon.Id) && File.Exists(PngPath(icon.Id)))
                {
                    result.Add(icon);
                }
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                // 壊れたファイルや書き込み途中のファイルは飛ばす
            }
        }

        return result.OrderByDescending(i => i.CreatedAt).ToList();
    }

    public LibraryIcon? Get(string id) => IsValidId(id) && File.Exists(MetaPath(id))
        ? JsonSerializer.Deserialize<LibraryIcon>(File.ReadAllText(MetaPath(id)), Json)
        : null;

    public byte[] ReadPng(string id) => File.ReadAllBytes(PngPath(Checked(id)));

    public byte[]? ReadSource(string id) => File.Exists(SourcePath(Checked(id))) ? File.ReadAllBytes(SourcePath(id)) : null;

    /// <summary>保存する。id は名前から作り、重なれば連番を付ける。</summary>
    public LibraryIcon Add(string name, IReadOnlyList<string> tags, byte[] png, byte[]? source, string? sourceName, string? sourceContentType, JsonObject? options, TimeProvider? time = null)
    {
        Directory.CreateDirectory(Root);
        var baseId = Slug(name);
        var id = baseId;
        for (var n = 2; File.Exists(MetaPath(id)); n++)
        {
            // 連番を足しても上限を超えないよう、元の部分を削ってから付ける。削った末尾に空白や「.」が残ると
            // Windows がファイル名から黙って落とし、id とファイル名が食い違うので、もう一度落としておく
            var suffix = $"-{n}";
            var head = TrimId(baseId.Length + suffix.Length > MaxSlugLength ? baseId[..(MaxSlugLength - suffix.Length)] : baseId);
            id = (head.Length == 0 ? "icon" : head) + suffix;
        }

        var icon = new LibraryIcon
        {
            Id = id,
            Name = string.IsNullOrWhiteSpace(name) ? id : name.Trim(),
            Tags = NormalizeTags(tags),
            CreatedAt = (time ?? TimeProvider.System).GetUtcNow(),
            SourceName = source is null ? null : sourceName,
            SourceContentType = source is null ? null : sourceContentType,
            Options = options,
        };

        // 画像を先に書き、最後に目録（json）を書く。途中で失敗しても一覧には出ない
        File.WriteAllBytes(PngPath(id), png);
        if (source is not null)
        {
            File.WriteAllBytes(SourcePath(id), source);
        }

        WriteMeta(icon);
        return icon;
    }

    public LibraryIcon Update(string id, string? name, IReadOnlyList<string>? tags)
    {
        var icon = Get(id) ?? throw new FileNotFoundException(L($"アイコン {id} が見つかりません。", $"Icon {id} was not found."));
        var next = icon with
        {
            Name = string.IsNullOrWhiteSpace(name) ? icon.Name : name.Trim(),
            Tags = tags is null ? icon.Tags : NormalizeTags(tags),
        };
        WriteMeta(next);
        return next;
    }

    public void Delete(string id)
    {
        Checked(id);
        foreach (var p in new[] { MetaPath(id), PngPath(id), SourcePath(id) })
        {
            if (File.Exists(p))
            {
                File.Delete(p);
            }
        }
    }

    private void WriteMeta(LibraryIcon icon)
    {
        var temp = MetaPath(icon.Id) + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(icon, Json));
        File.Move(temp, MetaPath(icon.Id), overwrite: true);
    }

    private static List<string> NormalizeTags(IEnumerable<string> tags) =>
        tags.Select(t => t.Trim()).Where(t => t.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// <summary>Slug の長さの上限。連番（-2 など）を付けても <see cref="MaxIdLength"/> に収まるようにしてある。</summary>
    public const int MaxSlugLength = 60;

    /// <summary>id として受け付ける長さの上限。</summary>
    public const int MaxIdLength = 80;

    private static readonly string[] ReservedNames =
        ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

    /// <summary>ファイル名に使える id にする。日本語などは残し、パスに使えない文字だけを置き換える。</summary>
    public static string Slug(string name)
    {
        var s = TrimId(UnsafeChars().Replace((name ?? string.Empty).Trim(), "_"));
        if (s.Length > MaxSlugLength)
        {
            // 切った末尾に空白や「.」が来ることがあるので、切ってからもう一度落とす
            s = TrimId(s[..MaxSlugLength]);
        }

        if (s.Length == 0)
        {
            return "icon";
        }

        // CON や NUL は Windows では拡張子を付けてもファイル名に使えない
        return ReservedNames.Contains(s, StringComparer.OrdinalIgnoreCase) ? s + "_" : s;
    }

    private static string TrimId(string s) => s.Trim('.', ' ', '_');

    /// <summary>
    /// ファイル名の一部として安全に使える id か。Slug(id) == id で判定すると、切り詰めや連番で作った id が
    /// 弾かれて読めなくなるので、「パスとして危なくないか」だけを見る。
    /// </summary>
    internal static bool IsValidId(string? id) =>
        !string.IsNullOrEmpty(id)
        && id.Length <= MaxIdLength
        && id.IndexOfAny(Path.GetInvalidFileNameChars()) < 0
        && !UnsafeChars().IsMatch(id)
        && id is not "." and not ".."
        && !id.Contains("..", StringComparison.Ordinal)
        && !id.StartsWith(' ') && !id.EndsWith(' ')
        && !id.StartsWith('.') && !id.EndsWith('.');

    private static string Checked(string id) => IsValidId(id) ? id : throw new ArgumentException(L($"不正な id です：{id}", $"Invalid id: {id}"), nameof(id));

    private string MetaPath(string id) => Path.Combine(Root, id + ".json");

    private string PngPath(string id) => Path.Combine(Root, id + ".png");

    private string SourcePath(string id) => Path.Combine(Root, id + ".source");

    [GeneratedRegex(@"[\\/:*?""<>|\x00-\x1f]+")]
    private static partial Regex UnsafeChars();
}
