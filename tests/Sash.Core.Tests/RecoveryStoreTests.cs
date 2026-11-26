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
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0));
        File.SetLastWriteTimeUtc(book.Path, T0.UtcDateTime);

        Assert.True(store.IsFileNewer(book.Path, T0.AddMinutes(-1)));
        Assert.False(store.IsFileNewer(book.Path, T0.AddMinutes(1)));
        Assert.False(store.IsFileNewer(Path.Combine(Path.GetTempPath(), "sash-tests", "nothing-" + Guid.NewGuid().ToString("N")), T0));
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

    // ---- 2 つの Sash（プロセス）で同じブックを開いたとき（§23.2） ----

    private static RecoveryStore AsProcess(string root, int pid, params int[] alive) =>
        new(root, new FixedTime(T0), pid, p => alive.Contains(p));

    [Fact]
    public void 動いている別のSashの退避は_読まず_一覧に出さず_消さない()
    {
        var root = NewRoot();
        var a = AsProcess(root, 100, 100, 200);
        var b = AsProcess(root, 200, 100, 200);
        a.Write(@"C:ook.xlsm", 1, [Part("<a/>")]);
        b.Write(@"C:ook.xlsm", 2, [Part("<b/>")]);

        // それぞれ自分の退避だけを読む（取り合わない）
        Assert.Equal("<a/>", a.Read(@"C:ook.xlsm")!.Parts[0].Xml);
        Assert.Equal("<b/>", b.Read(@"C:ook.xlsm")!.Parts[0].Xml);
        Assert.Single(a.List());

        // a が消しても b のものは残る
        a.Delete(@"C:ook.xlsm");
        Assert.Null(a.Read(@"C:ook.xlsm"));
        Assert.Equal("<b/>", b.Read(@"C:ook.xlsm")!.Parts[0].Xml);
        Assert.Single(Directory.GetFiles(root, "*.json"));
    }

    [Fact]
    public void 動いていないプロセスが残した退避は_復旧の候補になり_消せる()
    {
        var root = NewRoot();
        AsProcess(root, 100, 100).Write(@"C:ook.xlsm", 5, [Part("<crashed/>")]);

        // 100 は落ちた。新しい Sash（200）は、その退避を読める・一覧に出せる
        var b = AsProcess(root, 200, 200);
        Assert.Equal("<crashed/>", b.Read(@"C:ook.xlsm")!.Parts[0].Xml);
        Assert.Single(b.List());

        // 自分の退避を書けば、そちらが優先される。捨てれば落ちた Sash のものも消える
        b.Write(@"C:ook.xlsm", 1, [Part("<mine/>")]);
        Assert.Equal("<mine/>", b.Read(@"C:ook.xlsm")!.Parts[0].Xml);
        Assert.Single(b.List());
        b.Delete(@"C:ook.xlsm");
        Assert.Null(b.Read(@"C:ook.xlsm"));
        Assert.Empty(Directory.GetFiles(root, "*.json"));
    }

    [Fact]
    public void 古くなった退避の掃除は_動いている別のSashのものには触らない()
    {
        var root = NewRoot();
        var time = new FixedTime(T0);
        new RecoveryStore(root, time, 100, p => true).Write(@"C:ook.xlsm", 1, [Part("<a/>")]);
        time.Now = T0.AddDays(RecoveryStore.RetentionDays + 5);

        Assert.Empty(new RecoveryStore(root, time, 200, p => true).List());
        Assert.Single(Directory.GetFiles(root, "*.json"));
    }

    // ---- 画像は変わった分だけ送る（§23.2） ----

    [Fact]
    public void 画像は前回から変わった分だけ受け取り_残りは前回の退避から引き継ぐ()
    {
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0));
        store.Write(@"C:ook.xlsm", 1, [new RecoveryPart(CustomUIVersion.Office2010, "<a/>", [new RecoveryImage("a", "data:A"), new RecoveryImage("b", "data:B")], [], null)]);

        // 2 回目：b を差し替え、c を足し、a は送らない（AddImageIds に a がある＝引き継ぐ）。d は AddImageIds にないので、送られても入らない
        store.Write(@"C:ook.xlsm", 2, [new RecoveryPart(CustomUIVersion.Office2010, "<a2/>", [new RecoveryImage("b", "data:B2"), new RecoveryImage("c", "data:C")], [], ["a", "b", "c"])]);
        var images = store.Read(@"C:ook.xlsm")!.Parts[0].AddImages.ToDictionary(i => i.Id, i => i.DataUrl);
        Assert.Equal(new Dictionary<string, string> { ["a"] = "data:A", ["b"] = "data:B2", ["c"] = "data:C" }, images);

        // 3 回目：a を外した（AddImageIds にない）。XML だけ変わった
        store.Write(@"C:ook.xlsm", 3, [new RecoveryPart(CustomUIVersion.Office2010, "<a3/>", [], [], ["b", "c"])]);
        Assert.Equal(["b", "c"], store.Read(@"C:ook.xlsm")!.Parts[0].AddImages.Select(i => i.Id).Order());
    }

    // ---- つながらないパスで待たされない（§23.2） ----

    [Fact]
    public void 元のファイルの確認が長引いても_一覧は時間で打ち切って返す()
    {
        var store = new RecoveryStore(NewRoot(), new FixedTime(T0), probe: _ => { Thread.Sleep(5000); return (false, null); }, probeTimeout: TimeSpan.FromMilliseconds(200));
        store.Write(@"\unreachable\shareook.xlsm", 1, [Part("<a/>")]);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var list = store.List();
        sw.Stop();

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(3), $"一覧に {sw.Elapsed} かかった");
        // 調べられなかったものは「ある・日時は不明」（復旧の候補からは外さない）
        var only = Assert.Single(list);
        Assert.True(only.FileExists);
        Assert.Null(only.FileModifiedAt);
        Assert.False(only.FileNewer);
    }
}
