using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Sash.Core.CustomUI;
using Sash.Core.Settings;

namespace Sash.Core.Recovery;

/// <summary>退避した画像 1 つ分。dataUrl は UI が表示に使う形（data:image/png;base64,…）のまま持つ。</summary>
public sealed record RecoveryImage(string Id, string DataUrl);

/// <summary>退避したパーツ 1 つ分。保存のときに書き込む内容（XML と、保存済みからの画像の差分）と同じ形。</summary>
public sealed record RecoveryPart(CustomUIVersion Version, string Xml, IReadOnlyList<RecoveryImage> AddImages, IReadOnlyList<string> RemoveImages);

/// <summary>未保存の編集の退避 1 件分（ブック 1 つにつき 1 件。上書きしていく）。</summary>
public sealed record RecoveryEntry(string Path, DateTimeOffset SavedAt, int EditCount, IReadOnlyList<RecoveryPart> Parts);

/// <summary>一覧に出す情報（中身は読まない）。</summary>
/// <param name="FileModifiedAt">元のファイルの更新日時。ファイルがなければ null。</param>
public sealed record RecoverySummary(string Path, DateTimeOffset SavedAt, int EditCount, bool FileExists, DateTimeOffset? FileModifiedAt)
{
    /// <summary>元のファイルが、退避より後に変わっている（Excel や別の人が保存した）。復旧すると、その変更を上書きしかねない。</summary>
    public bool FileNewer => FileModifiedAt is { } m && m > SavedAt;
}

/// <summary>
/// 未保存の編集の退避（仕様書 §23.2）。編集中の XML と、足した・変えた画像を %AppData%\Sash\recovery に書く。
/// 正常に保存・閉じたら消し、次に同じブックを開いたときに、残っていれば復旧を選べる。
/// ブック 1 つにつき 1 ファイル（名前は、フルパスの照合値）。一時ファイルに書いてから置き換えるので、書き込みの途中で落ちても
/// 前の退避を壊さない。退避はあくまで保険なので、読めない・壊れているものは黙って捨てる（編集を止めない）。
/// </summary>
public sealed class RecoveryStore
{
    /// <summary>退避を残す日数。これより古いものは掃除する。</summary>
    public const int RetentionDays = 30;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly string _root;
    private readonly TimeProvider _time;

    public RecoveryStore(string root, TimeProvider? time = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        _root = root;
        _time = time ?? TimeProvider.System;
    }

    /// <summary>退避のファイルのパス。大文字小文字だけ違うパスは同じブックとして扱う（Windows のパスは区別しない）。</summary>
    public string FileOf(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(full.ToUpperInvariant())))[..32];
        return System.IO.Path.Combine(_root, hash + ".json");
    }

    /// <summary>退避を書く（あれば置き換える）。日時は書く時点のものにする。</summary>
    public void Write(string path, int editCount, IReadOnlyList<RecoveryPart> parts)
    {
        var full = System.IO.Path.GetFullPath(path);
        var entry = new RecoveryEntry(full, _time.GetUtcNow(), editCount, parts);
        JsonFile.WriteAtomic(FileOf(full), JsonSerializer.Serialize(entry, Json));
    }

    /// <summary>退避を読む。ない・壊れている・別のブックのもの（照合値が同じでも、パスが違う）は null。</summary>
    public RecoveryEntry? Read(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var entry = TryRead(FileOf(full));
        return entry is not null && string.Equals(entry.Path, full, StringComparison.OrdinalIgnoreCase) ? entry : null;
    }

    /// <summary>退避を消す。なければ何もしない。消せなくても（別のプログラムが掴んでいるなど）例外にしない。</summary>
    public void Delete(string path)
    {
        try
        {
            var file = FileOf(path);
            if (File.Exists(file))
            {
                File.Delete(file);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// 退避の一覧（新しい順）。読めない・壊れているものと、<see cref="RetentionDays"/> 日より古いものは、一覧に出さずに消す。
    /// </summary>
    public IReadOnlyList<RecoverySummary> List()
    {
        if (!Directory.Exists(_root))
        {
            return [];
        }

        var oldest = _time.GetUtcNow().AddDays(-RetentionDays);
        var result = new List<RecoverySummary>();
        foreach (var file in Directory.EnumerateFiles(_root, "*.json"))
        {
            var entry = TryRead(file);
            if (entry is null || entry.SavedAt < oldest)
            {
                TryDelete(file);
                continue;
            }

            var info = new FileInfo(entry.Path);
            result.Add(new RecoverySummary(entry.Path, entry.SavedAt, entry.EditCount, info.Exists, info.Exists ? new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero) : null));
        }

        // 書きかけで残った一時ファイルも、古ければ掃除する
        foreach (var temp in Directory.EnumerateFiles(_root, "*.tmp"))
        {
            if (File.GetLastWriteTimeUtc(temp) < _time.GetUtcNow().UtcDateTime.AddDays(-1))
            {
                TryDelete(temp);
            }
        }

        return result.OrderByDescending(r => r.SavedAt).ToList();
    }

    /// <summary>元のファイルが、退避を書いた後に変わっているか（ファイルがなければ false）。</summary>
    public static bool IsFileNewer(string path, DateTimeOffset savedAt)
    {
        var info = new FileInfo(path);
        return info.Exists && new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero) > savedAt;
    }

    private static RecoveryEntry? TryRead(string file)
    {
        try
        {
            if (!File.Exists(file))
            {
                return null;
            }

            var entry = JsonSerializer.Deserialize<RecoveryEntry>(File.ReadAllText(file), Json);
            return entry is { Path.Length: > 0, Parts: not null } ? entry : null;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
