using System.Text.Json.Nodes;
using Sash.Core.Settings;

namespace Sash.Core.Tests;

public class RecipeStoreTests
{
    [Fact]
    public void 保存と置き換えと削除ができる()
    {
        using var book = new TestWorkbook();
        var store = new RecipeStore(Path.Combine(book.BackupRoot, "r", "recipes.json"));

        store.Save(new JsonObject { ["id"] = "a", ["title"] = "A" });
        store.Save(new JsonObject { ["id"] = "b", ["title"] = "B" });
        store.Save(new JsonObject { ["id"] = "a", ["title"] = "A2" });

        Assert.Equal(["B", "A2"], store.List().Select(r => r["title"]!.GetValue<string>()));
        store.Delete("b");
        Assert.Equal(["a"], store.List().Select(r => r["id"]!.GetValue<string>()));
    }

    [Fact]
    public void ファイルが壊れていても空として扱う()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "recipes.json");
        File.WriteAllText(path, "[壊れている");

        Assert.Empty(new RecipeStore(path).List());
    }

    [Fact]
    public void 壊れたファイルは退避してから保存する()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "recipes.json");
        File.WriteAllText(path, "[壊れている");
        var store = new RecipeStore(path);

        store.Save(new JsonObject { ["id"] = "a" });

        Assert.Equal(["a"], store.List().Select(r => r["id"]!.GetValue<string>()));
        Assert.Equal("[壊れている", File.ReadAllText(path + ".bak"));
        Assert.Empty(Directory.GetFiles(book.BackupRoot, "*.tmp"));
    }

    [Fact]
    public void 読めないときは保存も削除もせずに中止する()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "recipes.json");
        var store = new RecipeStore(path);
        store.Save(new JsonObject { ["id"] = "a" });
        var before = File.ReadAllText(path);

        using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Assert.Throws<UserFacingException>(() => store.Save(new JsonObject { ["id"] = "b" }));
            Assert.Throws<UserFacingException>(() => store.Delete("a"));
        }

        Assert.Equal(before, File.ReadAllText(path));
    }

    [Fact]
    public void idのないレシピは保存しない()
    {
        using var book = new TestWorkbook();
        var store = new RecipeStore(Path.Combine(book.BackupRoot, "recipes.json"));
        Assert.Throws<ArgumentException>(() => store.Save(new JsonObject { ["title"] = "x" }));
        Assert.Throws<ArgumentException>(() => store.Save(new JsonObject { ["id"] = 1 }));
    }
}
