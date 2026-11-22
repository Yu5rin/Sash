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
}
