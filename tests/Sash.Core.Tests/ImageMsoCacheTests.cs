using Sash.Core.Excel;

namespace Sash.Core.Tests;

/// <summary>テストごとの一時フォルダ。</summary>
internal sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "sash-test-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path, recursive: true);
        }
        catch (DirectoryNotFoundException)
        {
        }
    }
}

public class ImageMsoCacheTests
{
    /// <summary>PNG の署名で始まるバイト列（キャッシュは署名のないファイルを壊れたものとして扱うため）。</summary>
    internal static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];

    [Fact]
    public void 画像は返し_存在しない名前はnull_知らない名前はMissesに返す()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        cache.Store("AutoSum", 32, Png);
        cache.MarkMissing("NoSuchIcon", 32);

        var r = cache.Lookup(["AutoSum", "NoSuchIcon", "Unknown", "AutoSum", ""], 32);

        Assert.Equal(Png, r.Found["AutoSum"]);
        Assert.True(r.Found.ContainsKey("NoSuchIcon"));
        Assert.Null(r.Found["NoSuchIcon"]);
        Assert.Equal(["Unknown"], r.Misses);
        Assert.Equal(2, r.Found.Count);
    }

    [Fact]
    public void 大きさごとに別に持つ()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        cache.Store("AutoSum", 32, Png);
        cache.MarkMissing("Old", 16);

        // 32px の画像は 16px にはなく、16px で存在しない記録は 32px には効かない
        Assert.Equal(["AutoSum"], cache.Lookup(["AutoSum", "Old"], 16).Misses);
        Assert.Equal(["Old"], cache.Lookup(["AutoSum", "Old"], 32).Misses);
        Assert.True(File.Exists(Path.Combine(dir.Path, "32", "AutoSum.png")));
        Assert.True(File.Exists(Path.Combine(dir.Path, "16", "missing.json")));
    }

    [Fact]
    public void ファイル名に使えない名前は存在しない名前として扱い_フォルダの外に書かない()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);

        cache.Store("../evil", 32, Png);
        var r = cache.Lookup(["../evil", "a:b", "x*", ".."], 32);

        Assert.All(r.Found.Values, v => Assert.Null(v));
        Assert.Empty(r.Misses);
        Assert.False(File.Exists(Path.Combine(dir.Path, "evil.png")));
        Assert.False(ImageMsoCache.IsValidName("trailing."));
        Assert.True(ImageMsoCache.IsValidName("FileSave_2"));
    }

    [Fact]
    public void 存在しない名前の記録は次の起動でも使える()
    {
        using var dir = new TempDir();
        var first = new ImageMsoCache(dir.Path);
        first.MarkMissing("Gone", 32, persist: false);
        first.MarkMissing("Gone2", 32, persist: false);
        first.Flush();

        var second = new ImageMsoCache(dir.Path);

        Assert.Equal(2, second.MissingCount(32));
        Assert.Null(second.Lookup(["Gone"], 32).Found["Gone"]);
        Assert.True(second.IsKnown("Gone2", 32));
    }

    [Fact]
    public void 画像が取れたら存在しない記録から外し_存在しなくなったら古い画像を消す()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        cache.MarkMissing("New", 32);
        cache.Store("Removed", 32, Png);
        Assert.Equal(1, cache.ImageCount(32));

        cache.Store("New", 32, Png);
        cache.MarkMissing("Removed", 32);

        var reopened = new ImageMsoCache(dir.Path);
        Assert.Equal(Png, reopened.Lookup(["New"], 32).Found["New"]);
        Assert.Null(reopened.Lookup(["Removed"], 32).Found["Removed"]);
        Assert.Equal(1, cache.ImageCount(32));
        Assert.Equal(1, reopened.ImageCount(32));
    }

    [Fact]
    public void 壊れたmissing_jsonとmanifestは記録なしとして扱う()
    {
        using var dir = new TempDir();
        Directory.CreateDirectory(Path.Combine(dir.Path, "32"));
        File.WriteAllText(Path.Combine(dir.Path, "32", "missing.json"), "[壊れ");
        File.WriteAllText(Path.Combine(dir.Path, "manifest.json"), "{壊れ");
        var cache = new ImageMsoCache(dir.Path);

        Assert.Equal(["A"], cache.Lookup(["A"], 32).Misses);
        Assert.Null(cache.ReadManifest());
    }

    [Fact]
    public void manifestを書いて読み直せる()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        var at = new DateTimeOffset(2026, 11, 23, 10, 0, 0, TimeSpan.FromHours(9));

        cache.WriteManifest(new ImageMsoManifest("16.0.19029", [32, 16], 1200, 300, 1500, at));
        var m = new ImageMsoCache(dir.Path).ReadManifest();

        Assert.NotNull(m);
        Assert.Equal("16.0.19029", m.ExcelVersion);
        Assert.Equal([32, 16], m.Sizes);
        Assert.Equal((1200, 300, 1500), (m.Images, m.Missing, m.Requested));
        Assert.Equal(at, m.CompletedAt);
    }
}

public class OnceLogTests
{
    [Fact]
    public void 同じ理由は1回だけ書く()
    {
        var lines = new List<string>();
        var log = new OnceLog(lines.Add);

        Assert.True(log.Write("a", "first"));
        Assert.False(log.Write("a", "again"));
        Assert.True(log.Write("b", "other"));

        Assert.Equal(["first", "other"], lines);
    }

    [Fact]
    public void 書き先がなくても動く()
    {
        Assert.True(new OnceLog(null).Write("a", "x"));
    }
}

public class ImageMsoCacheValidationTests
{
    private static readonly byte[] Png = ImageMsoCacheTests.Png;

    [Theory]
    [InlineData(new byte[0])]
    [InlineData(new byte[] { 0x42, 0x4D, 1, 2, 3, 4, 5, 6, 7, 8 })]
    [InlineData(new byte[] { 0x89, 0x50, 0x4E, 0x47 })]
    public void 空や壊れた画像はキャッシュにないものとして扱い_消して取り直させる(byte[] bad)
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        Directory.CreateDirectory(cache.SizeDirectory(32));
        var path = Path.Combine(cache.SizeDirectory(32), "AutoSum.png");
        File.WriteAllBytes(path, bad);

        Assert.False(cache.IsKnown("AutoSum", 32));
        Assert.False(File.Exists(path));

        File.WriteAllBytes(path, bad);
        var r = new ImageMsoCache(dir.Path).Lookup(["AutoSum"], 32);
        Assert.Equal(["AutoSum"], r.Misses);
        Assert.False(r.Found.ContainsKey("AutoSum"));
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void 正しいPNGは取り込み済みとして扱う()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        cache.Store("AutoSum", 32, Png);

        Assert.True(cache.IsKnown("AutoSum", 32));
        Assert.Equal(Png, cache.Lookup(["AutoSum"], 32).Found["AutoSum"]);
    }

    [Fact]
    public void 失敗の記録を書いて読み直し_消せる()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        Assert.Null(cache.ReadFailure());

        cache.WriteFailure(new ImageMsoFailureRecord("16.0.19029", DateTimeOffset.Now, "理由"));
        var read = new ImageMsoCache(dir.Path).ReadFailure();
        Assert.Equal(("16.0.19029", "理由"), (read!.ExcelVersion, read.Message));

        cache.ClearFailure();
        Assert.Null(cache.ReadFailure());
        cache.ClearFailure();
    }

    [Theory]
    [InlineData("16.0.19029", "16.0.19029")]
    [InlineData("16.0.19029.20000", "16.0.19029")]
    [InlineData(" 16.0 ", "16.0.0")]
    [InlineData("16", "16.0.0")]
    [InlineData("abc", "abc")]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void Excelの版をそろえる(string? input, string? expected)
    {
        Assert.Equal(expected, ImageMsoCache.NormalizeExcelVersion(input));
    }

    [Fact]
    public void 形の違う版も同じExcelなら同じとみなす()
    {
        Assert.True(ImageMsoCache.SameExcelVersion("16.0.19029", "16.0.19029.20000"));
        Assert.False(ImageMsoCache.SameExcelVersion("16.0.19029", "16.0.19127"));
        Assert.False(ImageMsoCache.SameExcelVersion(null, "16.0.19029"));
    }
}

