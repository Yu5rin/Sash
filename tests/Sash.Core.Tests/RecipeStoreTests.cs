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
}
