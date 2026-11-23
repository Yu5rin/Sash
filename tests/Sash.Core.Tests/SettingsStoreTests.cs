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

    [Fact]
    public void nullや範囲外の値は既定値にそろえる()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "settings.json");
        File.WriteAllText(path, """
            { "theme": "purple", "iconSize": 48, "backupGenerations": 0, "language": "fr",
              "recentFiles": null, "iconFavorites": [null, "a"], "callbackPattern": null, "updateSource": null }
            """);
        var store = new SettingsStore(path);

        var s = store.Load();
        Assert.Equal("system", s.Theme);
        Assert.Equal(32, s.IconSize);
        Assert.Equal(1, s.BackupGenerations);
        Assert.Equal("ja", s.Language);
        Assert.Empty(s.RecentFiles);
        Assert.Equal(["a"], s.IconFavorites);
        Assert.Equal("Ribbon_{id}_{attr}", s.CallbackPattern);
        Assert.Equal("", s.UpdateSource);

        // null のままでも追加できる
        store.AddRecent(@"C:\a.xlsm");
        Assert.Equal([@"C:\a.xlsm"], store.Load().RecentFiles);
        Assert.Equal(100, SettingsStore.Normalize(new AppSettings { BackupGenerations = 1000 }).BackupGenerations);
    }

    [Fact]
    public void 壊れたファイルは退避してから書き直す()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "settings.json");
        File.WriteAllText(path, "{ 壊れ");
        File.WriteAllText(path + ".bak", "前の退避");
        var store = new SettingsStore(path);

        store.Update(s => s with { Theme = "dark" });

        Assert.Equal("dark", store.Load().Theme);
        Assert.Equal("前の退避", File.ReadAllText(path + ".bak"));
        Assert.Equal("{ 壊れ", File.ReadAllText(path + ".1.bak"));
        Assert.Empty(Directory.GetFiles(book.BackupRoot, "*.tmp"));
    }

    [Fact]
    public void 読めないファイルは既定値で上書きしない()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "settings.json");
        var store = new SettingsStore(path);
        store.Update(s => s with { Theme = "dark" });
        var before = File.ReadAllText(path);

        // ほかのプログラムが排他で開いている間は、書き換えずに中止する
        using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Assert.Throws<UserFacingException>(() => store.Update(s => s with { Theme = "light" }));
        }

        Assert.Equal(before, File.ReadAllText(path));
        Assert.Equal("dark", store.Load().Theme);
    }
}
