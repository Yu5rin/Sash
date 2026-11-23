using System.Globalization;
using System.Text.Json;

namespace Sash.Core.Excel;

/// <summary>
/// imageMso を取り込み終えたときの記録（キャッシュのフォルダの manifest.json）。
/// 次の起動からはこれを見て取り込み済みと判断し、Excel を起動しない。
/// </summary>
/// <param name="ExcelVersion">取り込んだ Excel の版（Application.Version と Build。例：16.0.19029）。</param>
/// <param name="Sizes">取り込んだ大きさ（px）。</param>
/// <param name="Images">取り込めた画像の数（<see cref="ImageMsoCache.PrimarySize"/> の分）。</param>
/// <param name="Missing">Excel に存在しなかった名前の数（同上）。</param>
/// <param name="Requested">取り込もうとした名前の数。</param>
/// <param name="CompletedAt">取り込みを終えた日時。</param>
public sealed record ImageMsoManifest(
    string? ExcelVersion,
    IReadOnlyList<int> Sizes,
    int Images,
    int Missing,
    int Requested,
    DateTimeOffset CompletedAt);

/// <summary>
/// 取り込みに失敗したときの記録（キャッシュのフォルダの prefetch-failed.json）。
/// 失敗をメモリにだけ持つと、起動のたびに見えない Excel を起動して同じ理由で失敗し、エラーを出し続けるので、
/// 同じ版の Excel では自動で取り込みを始めないよう、ファイルに残す。
/// </summary>
/// <param name="ExcelVersion">失敗したときの Excel の版（<see cref="ImageMsoCache.NormalizeExcelVersion"/> の形）。分からなければ null。</param>
/// <param name="FailedAt">失敗した日時。</param>
/// <param name="Message">利用者に見せた理由。</param>
/// <param name="Method">失敗したときの取り出し方の版（<see cref="ImageMsoFailureRecord.CurrentMethod"/>）。古い記録にはないので 0。</param>
public sealed record ImageMsoFailureRecord(string? ExcelVersion, DateTimeOffset FailedAt, string? Message, int Method = 0)
{
    /// <summary>
    /// いまの取り出し方の版。取り出し方を直したら上げる。古い取り出し方で失敗した記録は当てはめず、もう一度自動で試す
    /// （直したのに「前に失敗したから」と自動で始めないままになるのを防ぐ）。
    /// 2：作業用のブックを開き、GetImageMso が使えるまで待ってから取り込む（ブックのない Excel が E_UNEXPECTED を返したため）。
    /// 3：Sash から（別のプロセスから）GetImageMso を呼ぶのをやめ、作業用のブックに一時的な VBA モジュールを入れて
    /// Excel の中で取り出す（ブックを開いても、利用者の Excel でも、別のプロセスからは E_UNEXPECTED が返ったため）。
    /// 2 までの失敗は別のプロセスから呼んだためのものなので、当てはめずにもう一度自動で試す。
    /// 4：マクロを有効にし、Application.Run の名前の書き方を確認用の関数で決める（3 で「マクロを実行できません」になったため）。
    /// </summary>
    public const int CurrentMethod = 4;
}

/// <summary>キャッシュを引いた結果。Found は見つかった画像（存在しない名前は null）、Misses はキャッシュにない名前。</summary>
public sealed record ImageMsoLookup(Dictionary<string, byte[]?> Found, IReadOnlyList<string> Misses);

/// <summary>
/// Excel から取り出した imageMso の画像のキャッシュ（%AppData%\Sash\cache\imageMso\&lt;大きさ&gt;\&lt;名前&gt;.png）。
/// Office のアイコンは Microsoft の著作物で、Sash（MIT）には同梱できない。利用者の PC の Excel から取り出し、
/// その PC の中だけに置く。存在しない名前は大きさごとの missing.json に記録し、Excel がない PC でも
/// 「存在しない imageMso」の警告を正しく出せるようにする。
/// 画像の読み書きは COM のスレッドとホストのスレッドの両方から来るので、すべて 1 つのロックの中で行う。
/// </summary>
public sealed class ImageMsoCache
{
    /// <summary>UI が表示に使う大きさ。取り込み済みの件数はこの大きさで数える。</summary>
    public const int PrimarySize = 32;

    private const string MissingFile = "missing.json";
    private const string ManifestFile = "manifest.json";
    private const string FailureFile = "prefetch-failed.json";

    /// <summary>PNG の先頭 8 バイト。</summary>
    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly Dictionary<int, HashSet<string>> _missing = [];
    private readonly Dictionary<int, int> _imageCounts = [];

    public ImageMsoCache(string root)
    {
        Root = root;
    }

    public string Root { get; }

    /// <summary>
    /// ファイル名として安全な名前か。imageMso は英数字と _ だけなので、Windows のファイル名に使えない文字や
    /// 「..」を含む名前は存在しない名前として扱ってよい（キャッシュのフォルダの外に書かないための確認も兼ねる）。
    /// OS に依存しないよう、Windows で使えない文字をここで並べる。
    /// </summary>
    public static bool IsValidName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 200 || name is "." or "..")
        {
            return false;
        }

        foreach (var c in name)
        {
            if (c < 0x20 || c is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*')
            {
                return false;
            }
        }

        return !name.EndsWith('.') && !name.EndsWith(' ');
    }

    /// <summary>
    /// Excel の版を「メジャー.マイナー.ビルド」にそろえる（例：16.0.19029.20000 → 16.0.19029）。
    /// 取り込んだ Excel から読む版（Application.Version と Build）と、Excel を起動せずに EXCEL.EXE から読む版とで
    /// 形が違っても、同じ Excel を「更新された」と取り違えないようにするため。数字が読めなければ空白を除いた元の文字列。
    /// </summary>
    public static string? NormalizeExcelVersion(string? version)
    {
        if (string.IsNullOrWhiteSpace(version))
        {
            return null;
        }

        var parts = version.Trim().Split('.');
        var numbers = new List<int>(3);
        foreach (var part in parts)
        {
            if (numbers.Count == 3)
            {
                break;
            }

            if (!int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var n))
            {
                return version.Trim();
            }

            numbers.Add(n);
        }

        while (numbers.Count < 3)
        {
            numbers.Add(0);
        }

        return string.Join('.', numbers.Select(n => n.ToString(CultureInfo.InvariantCulture)));
    }

    /// <summary>2 つの Excel の版が同じか（<see cref="NormalizeExcelVersion"/> でそろえて比べる）。どちらかが不明なら false。</summary>
    public static bool SameExcelVersion(string? a, string? b)
    {
        var x = NormalizeExcelVersion(a);
        var y = NormalizeExcelVersion(b);
        return x is not null && y is not null && string.Equals(x, y, StringComparison.Ordinal);
    }

    public string SizeDirectory(int size) => Path.Combine(Root, size.ToString(CultureInfo.InvariantCulture));

    private string ImagePath(string name, int size) => Path.Combine(SizeDirectory(size), name + ".png");

    /// <summary>
    /// キャッシュを引く。画像があればその PNG、missing.json にあれば null を Found に入れ、どちらでもない名前は Misses に返す。
    /// ファイル名に使えない名前は存在しない名前（null）とする。
    /// </summary>
    public ImageMsoLookup Lookup(IEnumerable<string> names, int size)
    {
        var found = new Dictionary<string, byte[]?>(StringComparer.Ordinal);
        var misses = new List<string>();
        lock (_lock)
        {
            var missing = MissingSet(size);
            foreach (var name in names.Where(n => !string.IsNullOrWhiteSpace(n)).Distinct(StringComparer.Ordinal))
            {
                if (!IsValidName(name))
                {
                    found[name] = null;
                    continue;
                }

                var png = TryRead(ImagePath(name, size), size);
                if (png is not null)
                {
                    found[name] = png;
                }
                else if (missing.Contains(name))
                {
                    found[name] = null;
                }
                else
                {
                    misses.Add(name);
                }
            }
        }

        return new ImageMsoLookup(found, misses);
    }

    /// <summary>画像があるか、存在しないと記録済みか（取り込みで飛ばしてよいか）。</summary>
    public bool IsKnown(string name, int size)
    {
        lock (_lock)
        {
            return MissingSet(size).Contains(name) || HasValidImage(ImagePath(name, size), size);
        }
    }

    /// <summary>画像を書く。存在しない名前の記録にあれば外す（Excel の更新で増えたアイコン）。</summary>
    public void Store(string name, int size, byte[] png)
    {
        ArgumentNullException.ThrowIfNull(png);
        if (!IsValidName(name))
        {
            return;
        }

        lock (_lock)
        {
            var path = ImagePath(name, size);
            try
            {
                Directory.CreateDirectory(SizeDirectory(size));
                var existed = File.Exists(path);

                // 書きかけのファイルを読ませないよう、一時ファイルに書いてから置き換える
                var temp = path + ".tmp";
                File.WriteAllBytes(temp, png);
                File.Move(temp, path, overwrite: true);
                if (!existed && _imageCounts.TryGetValue(size, out var n))
                {
                    _imageCounts[size] = n + 1;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 書けなくても表示には使える。次の機会にまた取り直すだけ
            }

            if (MissingSet(size).Remove(name))
            {
                SaveMissing(size);
            }
        }
    }

    /// <summary>
    /// Excel に存在しない名前として記録する。古い画像が残っていれば消す（Excel の更新でなくなったアイコン）。
    /// persist が false のときは、まとめて <see cref="Flush"/> で書く（取り込みでは 1 件ごとに書かないため）。
    /// </summary>
    public void MarkMissing(string name, int size, bool persist = true)
    {
        if (!IsValidName(name))
        {
            return;
        }

        lock (_lock)
        {
            var path = ImagePath(name, size);
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                    if (_imageCounts.TryGetValue(size, out var n))
                    {
                        _imageCounts[size] = Math.Max(0, n - 1);
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }

            if (MissingSet(size).Add(name) && persist)
            {
                SaveMissing(size);
            }
        }
    }

    /// <summary>記録した存在しない名前を、すべての大きさについて missing.json に書く。</summary>
    public void Flush()
    {
        lock (_lock)
        {
            foreach (var size in _missing.Keys.ToList())
            {
                SaveMissing(size);
            }
        }
    }

    /// <summary>存在しない名前の数。</summary>
    public int MissingCount(int size)
    {
        lock (_lock)
        {
            return MissingSet(size).Count;
        }
    }

    /// <summary>キャッシュにある画像の数。最初の 1 回だけフォルダを数え、あとは書き込みに合わせて数え直す。</summary>
    public int ImageCount(int size)
    {
        lock (_lock)
        {
            if (!_imageCounts.TryGetValue(size, out var n))
            {
                n = CountFiles(SizeDirectory(size), "*.png");
                _imageCounts[size] = n;
            }

            return n;
        }
    }

    /// <summary>キャッシュのフォルダ全体のバイト数（設定画面に出す）。</summary>
    public long TotalBytes()
    {
        lock (_lock)
        {
            try
            {
                return Directory.Exists(Root)
                    ? new DirectoryInfo(Root).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length)
                    : 0;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return 0;
            }
        }
    }

    public ImageMsoManifest? ReadManifest()
    {
        lock (_lock)
        {
            try
            {
                var path = Path.Combine(Root, ManifestFile);
                return File.Exists(path) ? JsonSerializer.Deserialize<ImageMsoManifest>(File.ReadAllText(path), Json) : null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
            {
                // 壊れた記録は「取り込んでいない」とみなす。画像のキャッシュはそのまま使える
                return null;
            }
        }
    }

    public void WriteManifest(ImageMsoManifest manifest)
    {
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(Root);
                var path = Path.Combine(Root, ManifestFile);
                File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(manifest, Json));
                File.Move(path + ".tmp", path, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    /// <summary>取り込みに失敗した記録を読む。なければ null。</summary>
    public ImageMsoFailureRecord? ReadFailure()
    {
        lock (_lock)
        {
            try
            {
                var path = Path.Combine(Root, FailureFile);
                return File.Exists(path) ? JsonSerializer.Deserialize<ImageMsoFailureRecord>(File.ReadAllText(path), Json) : null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
            {
                // 壊れた記録は「失敗していない」とみなす。最悪でも、次の起動で取り込みをもう一度試すだけ
                return null;
            }
        }
    }

    public void WriteFailure(ImageMsoFailureRecord record)
    {
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(Root);
                var path = Path.Combine(Root, FailureFile);
                File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(record, Json));
                File.Move(path + ".tmp", path, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    /// <summary>失敗の記録を消す（取り込みに成功したとき）。</summary>
    public void ClearFailure()
    {
        lock (_lock)
        {
            try
            {
                File.Delete(Path.Combine(Root, FailureFile));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private HashSet<string> MissingSet(int size)
    {
        if (_missing.TryGetValue(size, out var set))
        {
            return set;
        }

        set = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            var path = Path.Combine(SizeDirectory(size), MissingFile);
            if (File.Exists(path))
            {
                foreach (var name in JsonSerializer.Deserialize<string[]>(File.ReadAllText(path), Json) ?? [])
                {
                    if (IsValidName(name))
                    {
                        set.Add(name);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // 壊れていれば記録なしとして扱う。次に取り込めば書き直される
        }

        _missing[size] = set;
        return set;
    }

    private void SaveMissing(int size)
    {
        try
        {
            Directory.CreateDirectory(SizeDirectory(size));
            var path = Path.Combine(SizeDirectory(size), MissingFile);
            var names = MissingSet(size).Order(StringComparer.Ordinal).ToArray();
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(names, Json));
            File.Move(path + ".tmp", path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// 画像を読む。0 バイトや PNG でないファイル（書き込みの途中で電源が落ちた、ほかのソフトが壊したなど）は
    /// キャッシュにないものとして扱い、消して取り直させる。残しておくと「取り込み済み」とみなされて、二度と取り直されないため。
    /// ロックの中で呼ぶ。
    /// </summary>
    private byte[]? TryRead(string path, int size)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            var bytes = File.ReadAllBytes(path);
            if (IsPng(bytes))
            {
                return bytes;
            }

            DeleteBad(path, size);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 読めなければキャッシュにないものとして扱い、Excel から取り直させる
            return null;
        }
    }

    /// <summary>使える画像のファイルがあるか（先頭の 8 バイトだけ読む）。壊れていれば消す。ロックの中で呼ぶ。</summary>
    private bool HasValidImage(string path, int size)
    {
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            Span<byte> head = stackalloc byte[8];
            int read;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                read = stream.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
            }

            if (read == head.Length && head.SequenceEqual(PngSignature))
            {
                return true;
            }

            DeleteBad(path, size);
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsPng(ReadOnlySpan<byte> bytes) => bytes.Length > PngSignature.Length && bytes[..PngSignature.Length].SequenceEqual(PngSignature);

    private void DeleteBad(string path, int size)
    {
        try
        {
            File.Delete(path);
            if (_imageCounts.TryGetValue(size, out var n))
            {
                _imageCounts[size] = Math.Max(0, n - 1);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 消せなくても、キャッシュにないものとして扱うことに変わりはない
        }
    }

    private static int CountFiles(string dir, string pattern)
    {
        try
        {
            return Directory.Exists(dir) ? Directory.EnumerateFiles(dir, pattern).Count() : 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }
}
