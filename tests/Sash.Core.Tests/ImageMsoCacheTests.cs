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
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47];

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

        Assert.Equal(["AutoSum", "Old"], cache.Lookup(["AutoSum", "Old"], 16).Misses.Order());
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

        Assert.All(r.Found.Values, Assert.Null);
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
