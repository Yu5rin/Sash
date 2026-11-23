using System.Text.Json.Nodes;
using Sash.Core.Library;

namespace Sash.Core.Tests;

public class IconLibraryTests
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47];

    [Fact]
    public void 保存して一覧と中身を読み戻せる()
    {
        using var book = new TestWorkbook();
        var lib = new IconLibrary(Path.Combine(book.BackupRoot, "icons"));

        var icon = lib.Add("集計 ボタン", ["社内", " 社内 ", "集計"], Png, [1, 2, 3], "sum.svg", "image/svg+xml", new JsonObject { ["padding"] = 8 });

        var listed = Assert.Single(lib.List());
        Assert.Equal(icon.Id, listed.Id);
        Assert.Equal(["社内", "集計"], listed.Tags);
        Assert.Equal(Png, lib.ReadPng(icon.Id));
        Assert.Equal(new byte[] { 1, 2, 3 }, lib.ReadSource(icon.Id));
        Assert.Equal(8, lib.Get(icon.Id)!.Options!["padding"]!.GetValue<int>());
    }

    [Fact]
    public void 同じ名前は連番になり危ない文字は置き換える()
    {
        using var book = new TestWorkbook();
        var lib = new IconLibrary(Path.Combine(book.BackupRoot, "icons"));

        var a = lib.Add("a/b:c", [], Png, null, null, null, null);
        var b = lib.Add("a/b:c", [], Png, null, null, null, null);

        Assert.Equal("a_b_c", a.Id);
        Assert.Equal("a_b_c-2", b.Id);
        Assert.Null(lib.ReadSource(a.Id));
    }

    [Fact]
    public void 名前とタグを変更し削除できる()
    {
        using var book = new TestWorkbook();
        var lib = new IconLibrary(Path.Combine(book.BackupRoot, "icons"));
        var icon = lib.Add("x", [], Png, null, null, null, null);

        lib.Update(icon.Id, "新しい名前", ["t"]);
        Assert.Equal("新しい名前", lib.Get(icon.Id)!.Name);

        lib.Delete(icon.Id);
        Assert.Empty(lib.List());
        Assert.Throws<ArgumentException>(() => lib.Delete("../x"));
    }

    [Fact]
    public void 壊れたファイルや画像のない項目は一覧に出さない()
    {
        using var book = new TestWorkbook();
        var root = Path.Combine(book.BackupRoot, "icons");
        var lib = new IconLibrary(root);
        lib.Add("ok", [], Png, null, null, null, null);
        File.WriteAllText(Path.Combine(root, "broken.json"), "{");
        File.WriteAllText(Path.Combine(root, "nopng.json"), "{\"id\":\"nopng\",\"name\":\"n\"}");

        Assert.Equal(["ok"], lib.List().Select(i => i.Id));
    }

    [Fact]
    public void 長い名前を2回保存しても読み書きと削除ができる()
    {
        using var book = new TestWorkbook();
        var lib = new IconLibrary(Path.Combine(book.BackupRoot, "icons"));
        var name = new string('あ', 70);

        var a = lib.Add(name, [], Png, [9], "a.png", "image/png", null);
        var b = lib.Add(name, [], Png, null, null, null, null);
        var c = lib.Add(name, [], Png, null, null, null, null);

        Assert.Equal(IconLibrary.MaxSlugLength, a.Id.Length);
        Assert.EndsWith("-2", b.Id, StringComparison.Ordinal);
        Assert.EndsWith("-3", c.Id, StringComparison.Ordinal);
        Assert.True(b.Id.Length <= IconLibrary.MaxSlugLength);
        Assert.Equal(3, lib.List().Count);
        Assert.Equal(Png, lib.ReadPng(b.Id));
        Assert.Equal(new byte[] { 9 }, lib.ReadSource(a.Id));
        lib.Delete(b.Id);
        Assert.Equal(2, lib.List().Count);
    }

    [Fact]
    public void 切り詰めた末尾の空白や点は落とす()
    {
        using var book = new TestWorkbook();
        var lib = new IconLibrary(Path.Combine(book.BackupRoot, "icons"));
        // 60 文字目のあたりに空白と点が来る名前
        var name = new string('a', 58) + " .b" + new string('c', 10);

        var a = lib.Add(name, [], Png, null, null, null, null);
        var b = lib.Add(name, [], Png, null, null, null, null);

        Assert.Equal(new string('a', 58), a.Id);
        Assert.Equal(new string('a', 58) + "-2", b.Id);
        Assert.Equal(Png, lib.ReadPng(a.Id));
        Assert.Equal(Png, lib.ReadPng(b.Id));

        // 連番で切り詰めた位置に空白が来る場合
        var spaced = new string('d', 57) + " " + new string('e', 10);
        lib.Add(spaced, [], Png, null, null, null, null);
        var d2 = lib.Add(spaced, [], Png, null, null, null, null);
        Assert.Equal(new string('d', 57) + "-2", d2.Id);
        Assert.Equal(Png, lib.ReadPng(d2.Id));
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("a..b")]
    [InlineData("../x")]
    [InlineData(@"a\b")]
    [InlineData("a/b")]
    [InlineData(" a")]
    [InlineData("a ")]
    [InlineData(".a")]
    [InlineData("a.")]
    [InlineData("a:b")]
    public void 危ないidは受け付けない(string id) => Assert.False(IconLibrary.IsValidId(id));

    [Fact]
    public void idの長さには上限がある()
    {
        Assert.True(IconLibrary.IsValidId(new string('a', IconLibrary.MaxIdLength)));
        Assert.False(IconLibrary.IsValidId(new string('a', IconLibrary.MaxIdLength + 1)));
        Assert.True(IconLibrary.IsValidId("集計_ボタン-2"));
    }

    [Fact]
    public void Windowsの予約名はidにしない() => Assert.Equal("con_", IconLibrary.Slug("CON").ToLowerInvariant());

    [Fact]
    public void 目録のidがパスとして危なければ一覧に出さない()
    {
        using var book = new TestWorkbook();
        var root = Path.Combine(book.BackupRoot, "icons");
        var lib = new IconLibrary(root);
        lib.Add("ok", [], Png, null, null, null, null);
        File.WriteAllText(Path.Combine(root, "evil.json"), "{\"id\":\"../ok\",\"name\":\"n\"}");

        Assert.Equal(["ok"], lib.List().Select(i => i.Id));
    }
}
