using Sash.Core.CustomUI;
using Sash.Core.Recovery;

namespace Sash.Core.Tests;

public class RecoveryStoreTests
{
    private sealed class FixedTime(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = start;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static readonly DateTimeOffset T0 = new(2026, 11, 26, 9, 0, 0, TimeSpan.Zero);

    private static string NewRoot() => Path.Combine(Path.GetTempPath(), "sash-tests", Guid.NewGuid().ToString("N"), "recovery");

    private static RecoveryPart Part(string xml, params RecoveryImage[] add) =>
        new(CustomUIVersion.Office2010, xml, add, ["old"]);

    [Fact]
    public void 書いた退避を読み戻せる_画像と削除する画像の印も残る()
    {
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0));
        var book = Path.Combine(Path.GetTempPath(), "book.xlsm");

        store.Write(book, 12, [Part("<customUI/>", new RecoveryImage("rId1", "data:image/png;base64,AAAA"))]);
        var entry = store.Read(book);

        Assert.NotNull(entry);
        Assert.Equal(Path.GetFullPath(book), entry.Path);
        Assert.Equal(12, entry.EditCount);
        Assert.Equal(T0, entry.SavedAt);
        var part = Assert.Single(entry.Parts);
        Assert.Equal(CustomUIVersion.Office2010, part.Version);
        Assert.Equal("<customUI/>", part.Xml);
        Assert.Equal("data:image/png;base64,AAAA", Assert.Single(part.AddImages).DataUrl);
        Assert.Equal(["old"], part.RemoveImages);
    }

    [Fact]
    public void 同じブックへ書くと置き換わる_大文字小文字だけ違うパスは同じブック()
    {
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0));
        store.Write(@"C:\Work\Book.xlsm", 1, [Part("<a/>")]);
        store.Write(@"c:\work\book.XLSM", 2, [Part("<b/>")]);

        Assert.Single(store.List());
        Assert.Equal("<b/>", store.Read(@"C:\Work\Book.xlsm")!.Parts[0].Xml);
    }

    [Fact]
    public void 消すと読めなくなり_ないものを消しても例外にならない()
    {
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0));
        store.Write(@"C:\a.xlsm", 1, [Part("<a/>")]);
        store.Delete(@"C:\a.xlsm");
        store.Delete(@"C:\a.xlsm");
        store.Delete(@"C:\never.xlsm");

        Assert.Null(store.Read(@"C:\a.xlsm"));
        Assert.Empty(store.List());
    }

    [Fact]
    public void 一覧は新しい順で_元のファイルが退避より後に変わっていれば印が付く()
    {
        var root = NewRoot();
        var time = new FixedTime(T0);
        var store = new RecoveryStore(root, time);
        using var older = new TestWorkbook();
        using var newer = new TestWorkbook();

        time.Now = T0;
        store.Write(older.Path, 3, [Part("<a/>")]);
        // older の更新日時は退避より前、newer は退避より後にする
        File.SetLastWriteTimeUtc(older.Path, T0.UtcDateTime.AddMinutes(-5));
        time.Now = T0.AddMinutes(10);
        store.Write(newer.Path, 5, [Part("<b/>")]);
        File.SetLastWriteTimeUtc(newer.Path, T0.UtcDateTime.AddMinutes(30));

        var list = store.List();

        Assert.Equal([newer.Path, older.Path], list.Select(r => r.Path));
        Assert.True(list[0].FileNewer);
        Assert.False(list[1].FileNewer);
        Assert.True(list[1].FileExists);
    }

    [Fact]
    public void IsFileNewer_ファイルの更新日時と退避の日時を比べる_ファイルがなければfalse()
    {
        using var book = new TestWorkbook();
        File.SetLastWriteTimeUtc(book.Path, T0.UtcDateTime);

        Assert.True(RecoveryStore.IsFileNewer(book.Path, T0.AddMinutes(-1)));
        Assert.False(RecoveryStore.IsFileNewer(book.Path, T0.AddMinutes(1)));
        Assert.False(RecoveryStore.IsFileNewer(Path.Combine(Path.GetTempPath(), "sash-tests", "nothing-" + Guid.NewGuid().ToString("N")), T0));
    }

    [Fact]
    public void 元のファイルがなくても退避は一覧に出る()
    {
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0));
        store.Write(Path.Combine(Path.GetTempPath(), "sash-tests", "gone-" + Guid.NewGuid().ToString("N") + ".xlsm"), 1, [Part("<a/>")]);

        var only = Assert.Single(store.List());
        Assert.False(only.FileExists);
        Assert.Null(only.FileModifiedAt);
        Assert.False(only.FileNewer);
    }

    [Fact]
    public void 保存期間を過ぎた退避は一覧を作るときに掃除される()
    {
        var time = new FixedTime(T0);
        var store = new RecoveryStore(NewRoot(), time);
        store.Write(@"C:\old.xlsm", 1, [Part("<a/>")]);
        time.Now = T0.AddDays(RecoveryStore.RetentionDays - 1);
        store.Write(@"C:\fresh.xlsm", 1, [Part("<b/>")]);

        time.Now = T0.AddDays(RecoveryStore.RetentionDays + 1);
        var list = store.List();

        Assert.Equal([Path.GetFullPath(@"C:\fresh.xlsm")], list.Select(r => r.Path));
        Assert.Null(store.Read(@"C:\old.xlsm"));
    }

    [Fact]
    public void 壊れた退避は読まず_一覧で掃除する()
    {
        var root = NewRoot();
        var store = new RecoveryStore(root, new FixedTime(T0));
        store.Write(@"C:\a.xlsm", 1, [Part("<a/>")]);
        File.WriteAllText(store.FileOf(@"C:\a.xlsm"), "{ これは JSON ではない");
        File.WriteAllText(Path.Combine(root, "junk.json"), "null");

        Assert.Null(store.Read(@"C:\a.xlsm"));
        Assert.Empty(store.List());
        Assert.Empty(Directory.GetFiles(root, "*.json"));
    }

    [Fact]
    public void 中のパスが違う退避は別のブックのものとして返さない()
    {
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0));
        store.Write(@"C:\a.xlsm", 1, [Part("<a/>")]);
        // 照合値が同じでも、中に書かれたパスが違えば別のブックの退避とみなす（衝突しても他人の編集を復旧させない）
        var file = store.FileOf(@"C:\a.xlsm");
        File.WriteAllText(file, File.ReadAllText(file).Replace("a.xlsm", "other.xlsm"));

        Assert.Null(store.Read(@"C:\a.xlsm"));
    }

    [Fact]
    public void フォルダがまだなくても一覧は空で_書くとフォルダを作る()
    {
        var root = NewRoot();
        var store = new RecoveryStore(root, new FixedTime(T0));
        Assert.Empty(store.List());
        Assert.Null(store.Read(@"C:\a.xlsm"));

        store.Write(@"C:\a.xlsm", 1, [Part("<a/>")]);
        Assert.True(Directory.Exists(root));
    }
}
