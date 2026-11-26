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
/// <param name="AddImages">足した・差し替えた画像。AddImageIds があるときは、前回から変わった分だけ（残りは前回の退避から引き継ぐ）。</param>
/// <param name="AddImageIds">いま足している画像の Id の全部。null なら AddImages が全部。</param>
public sealed record RecoveryPart(CustomUIVersion Version, string Xml, IReadOnlyList<RecoveryImage> AddImages, IReadOnlyList<string> RemoveImages, IReadOnlyList<string>? AddImageIds = null);

/// <summary>未保存の編集の退避 1 件分（ブック 1 つにつき 1 件。上書きしていく）。</summary>
/// <param name="OwnerPid">書いた Sash のプロセス ID（2 つの Sash で同じブックを開いても、退避を取り合わないため）。</param>
public sealed record RecoveryEntry(string Path, DateTimeOffset SavedAt, int EditCount, IReadOnlyList<RecoveryPart> Parts, int OwnerPid = 0);

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
    private readonly int _pid;
    private readonly Func<int, bool> _isAlive;
    private readonly Func<string, (bool Exists, DateTimeOffset? Modified)> _probe;
    private readonly TimeSpan _probeTimeout;

    /// <param name="ownerPid">この Sash のプロセス ID。退避のファイルはこの ID を名前に含め、自分のものだけを書き換える・消す。</param>
    /// <param name="isAlive">そのプロセスが動いているか（ほかの Sash の退避を、復旧の候補にしてよいかの判定）。</param>
    /// <param name="probe">元のファイルの有無と更新日時を調べる（つながらないネットワーク パスで待たされないよう、時間を区切って呼ぶ）。</param>
    public RecoveryStore(string root, TimeProvider? time = null, int? ownerPid = null, Func<int, bool>? isAlive = null,
        Func<string, (bool Exists, DateTimeOffset? Modified)>? probe = null, TimeSpan? probeTimeout = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        _root = root;
        _time = time ?? TimeProvider.System;
        _pid = ownerPid ?? Environment.ProcessId;
        _isAlive = isAlive ?? ProcessAlive;
        _probe = probe ?? DefaultProbe;
        _probeTimeout = probeTimeout ?? TimeSpan.FromSeconds(2);
    }

    private static bool ProcessAlive(int pid)
    {
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return false;
        }
        catch (Exception)
        {
            // 権限がなくて調べられないときは、動いているものとして扱う（ほかの Sash の退避を横取りしない側に倒す）
            return true;
        }
    }

    private static (bool, DateTimeOffset?) DefaultProbe(string path)
    {
        var info = new FileInfo(path);
        return info.Exists ? (true, new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero)) : (false, null);
    }

    /// <summary>
    /// 元のファイルの有無と更新日時。つながらないネットワーク パスや止まった共有フォルダでは、存在確認だけで長く待たされるので、
    /// 時間（既定 2 秒）で打ち切る。打ち切ったときは「ある・日時は不明」として扱い（開こうとすれば、そこで分かる言葉の失敗になる）、timedOut を true にする。
    /// </summary>
    internal (bool Exists, DateTimeOffset? Modified, bool TimedOut) Probe(string path)
    {
        var task = Task.Run(() => _probe(path));
        try
        {
            return task.Wait(_probeTimeout) ? (task.Result.Exists, task.Result.Modified, false) : (true, null, true);
        }
        catch (AggregateException)
        {
            return (false, null, false);
        }
    }

    private string HashOf(string path) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(System.IO.Path.GetFullPath(path).ToUpperInvariant())))[..32];

    private string FileFor(string path, int pid) => System.IO.Path.Combine(_root, $"{HashOf(path)}.{pid}.json");

    /// <summary>そのブックの、ほかのプロセスが書いた退避のファイル。</summary>
    private IEnumerable<(string File, int Pid)> OthersOf(string path)
    {
        if (!Directory.Exists(_root))
        {
            yield break;
        }

        var prefix = HashOf(path) + ".";
        foreach (var file in Directory.EnumerateFiles(_root, prefix + "*.json"))
        {
            var mid = System.IO.Path.GetFileNameWithoutExtension(file)[prefix.Length..];
            if (int.TryParse(mid, out var pid) && pid != _pid)
            {
                yield return (file, pid);
            }
        }
    }

    /// <summary>この Sash の、そのブックの退避のファイル（名前は、フルパスの照合値とプロセス ID）。大文字小文字だけ違うパスは同じブックとして扱う。</summary>
    public string FileOf(string path) => FileFor(path, _pid);

    /// <summary>
    /// 退避を書く（この Sash のものを置き換える）。日時は書く時点のもの。
    /// 画像は、パーツの AddImageIds があれば「前回から変わった分」だけが AddImages に入っているので、残りは前回の退避から引き継ぐ。
    /// </summary>
    public void Write(string path, int editCount, IReadOnlyList<RecoveryPart> parts)
    {
        var full = System.IO.Path.GetFullPath(path);
        var previous = TryRead(FileOf(full));
        var merged = parts.Select(p => MergeImages(p, previous?.Parts.FirstOrDefault(q => q.Version == p.Version))).ToList();
        var entry = new RecoveryEntry(full, _time.GetUtcNow(), editCount, merged, _pid);
        JsonFile.WriteAtomic(FileOf(full), JsonSerializer.Serialize(entry, Json));
    }

    private static RecoveryPart MergeImages(RecoveryPart part, RecoveryPart? previous)
    {
        if (part.AddImageIds is null)
        {
            return part;
        }

        var incoming = part.AddImages.ToDictionary(i => i.Id, StringComparer.Ordinal);
        var kept = (previous?.AddImages ?? []).Where(i => !incoming.ContainsKey(i.Id) && part.AddImageIds.Contains(i.Id)).ToList();
        return part with { AddImages = [.. kept, .. part.AddImages.Where(i => part.AddImageIds.Contains(i.Id))], AddImageIds = null };
    }

    /// <summary>
    /// 退避を読む。この Sash のものを返し、なければ、動いていないプロセスが残した退避のうち最も新しいものを返す（落ちた Sash の退避の復旧）。
    /// 動いている別の Sash が書いている退避は返さない（その Sash の編集中のものを、横から復旧させない）。
    /// ない・壊れている・別のブックのもの（照合値が同じでも、パスが違う）は null。
    /// </summary>
    public RecoveryEntry? Read(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var own = Verified(TryRead(FileOf(full)), full);
        if (own is not null)
        {
            return own;
        }

        return OthersOf(full)
            .Where(o => !_isAlive(o.Pid))
            .Select(o => Verified(TryRead(o.File), full))
            .OfType<RecoveryEntry>()
            .OrderByDescending(e => e.SavedAt)
            .FirstOrDefault();
    }

    private static RecoveryEntry? Verified(RecoveryEntry? entry, string full) =>
        entry is not null && string.Equals(entry.Path, full, StringComparison.OrdinalIgnoreCase) ? entry : null;

    /// <summary>
    /// そのブックの退避を消す：この Sash のものと、動いていないプロセスが残したもの。動いている別の Sash の退避は消さない。
    /// なければ何もしない。消せなくても（別のプログラムが掴んでいるなど）例外にしない。
    /// </summary>
    public void Delete(string path)
    {
        try
        {
            var own = FileOf(path);
            if (File.Exists(own))
            {
                File.Delete(own);
            }

            foreach (var (file, pid) in OthersOf(path).ToList())
            {
                if (!_isAlive(pid))
                {
                    TryDelete(file);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// 退避の一覧（新しい順。ブックごとに 1 件）。この Sash のものと、動いていないプロセスが残したものを出し、動いている別の Sash のものは出さない。
    /// 読めない・壊れているものと、<see cref="RetentionDays"/> 日より古いものは、一覧に出さずに消す（動いている別の Sash のものは、古くても触らない）。
    /// 元のファイルの有無は、時間を区切って調べる（<see cref="Probe"/>）。
    /// </summary>
    public IReadOnlyList<RecoverySummary> List()
    {
        if (!Directory.Exists(_root))
        {
            return [];
        }

        var oldest = _time.GetUtcNow().AddDays(-RetentionDays);
        var entries = new List<RecoveryEntry>();
        foreach (var file in Directory.EnumerateFiles(_root, "*.json"))
        {
            var entry = TryRead(file);
            var pid = PidOf(file);
            if (pid is { } p && p != _pid && _isAlive(p))
            {
                continue;
            }

            if (entry is null || entry.SavedAt < oldest)
            {
                TryDelete(file);
                continue;
            }

            entries.Add(entry);
        }

        // 書きかけで残った一時ファイルも、古ければ掃除する
        foreach (var temp in Directory.EnumerateFiles(_root, "*.tmp"))
        {
            if (File.GetLastWriteTimeUtc(temp) < _time.GetUtcNow().UtcDateTime.AddDays(-1))
            {
                TryDelete(temp);
            }
        }

        // 同じブックの退避が複数（自分のものと、落ちた Sash のもの）あれば、新しいほうだけ
        return entries
            .GroupBy(e => e.Path, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.OrderByDescending(e => e.SavedAt).First())
            .Select(e =>
            {
                var (exists, modified, _) = Probe(e.Path);
                return new RecoverySummary(e.Path, e.SavedAt, e.EditCount, exists, modified);
            })
            .OrderByDescending(r => r.SavedAt)
            .ToList();
    }

    private static int? PidOf(string file)
    {
        // <照合値>.<pid>.json
        var parts = System.IO.Path.GetFileNameWithoutExtension(file).Split('.');
        return parts.Length == 2 && int.TryParse(parts[1], out var pid) ? pid : null;
    }

    /// <summary>元のファイルが、退避を書いた後に変わっているか（ファイルがない・時間内に調べられなかったときは false）。</summary>
    public bool IsFileNewer(string path, DateTimeOffset savedAt) => Probe(path) is { Exists: true, Modified: { } m } && m > savedAt;

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
