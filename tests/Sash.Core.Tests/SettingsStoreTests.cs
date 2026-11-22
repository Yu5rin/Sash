using Sash.Core.Settings;

namespace Sash.Core.Tests;

public class SettingsStoreTests
{
    [Fact]
    public void ファイルがなければ既定値()
    {
        using var book = new TestWorkbook();
        var store = new SettingsStore(Path.Combine(book.BackupRoot, "settings.json"));

        Assert.Equal("system", store.Load().Theme);
        Assert.Equal(32, store.Load().IconSize);
    }

    [Fact]
    public void 壊れたファイルは既定値として扱う()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "settings.json");
        File.WriteAllText(path, "{ これはJSONではない");

        Assert.Equal("system", new SettingsStore(path).Load().Theme);
    }

    [Fact]
    public void 最近使ったファイルは新しい順で重複しない()
    {
        using var book = new TestWorkbook();
        var store = new SettingsStore(Path.Combine(book.BackupRoot, "s", "settings.json"));

        store.AddRecent(@"C:\a.xlsm");
        store.AddRecent(@"C:\b.xlam");
        store.AddRecent(@"C:\A.xlsm");

        Assert.Equal([@"C:\A.xlsm", @"C:\b.xlam"], store.Load().RecentFiles);
        Assert.Equal([@"C:\b.xlam"], store.RemoveRecent(@"c:\a.xlsm").RecentFiles);
    }

    [Fact]
    public void 最近使ったファイルは上限を超えない()
    {
        using var book = new TestWorkbook();
        var store = new SettingsStore(Path.Combine(book.BackupRoot, "settings.json"));

        for (var i = 0; i < 20; i++)
        {
            store.AddRecent($@"C:\{i}.xlsm");
        }

        Assert.Equal(SettingsStore.MaxRecentFiles, store.Load().RecentFiles.Count);
        Assert.Equal(@"C:\19.xlsm", store.Load().RecentFiles[0]);
    }

    [Fact]
    public void 設定を更新して読み戻せる()
    {
        using var book = new TestWorkbook();
        var store = new SettingsStore(Path.Combine(book.BackupRoot, "settings.json"));

        store.Update(s => s with { Theme = "dark", IconSize = 64 });

        Assert.Equal("dark", store.Load().Theme);
        Assert.Equal(64, store.Load().IconSize);
    }
}
