using Sash.Core.Update;

namespace Sash.Core.Tests;

public class UpdateVersionTests
{
    [Theory]
    [InlineData("v1.2.3", 1, 2, 3)]
    [InlineData(" 0.10.0 ", 0, 10, 0)]
    [InlineData("1.2", 1, 2, 0)]
    [InlineData("1.2.3.0", 1, 2, 3)]
    public void 版を読む(string text, int a, int b, int c)
    {
        Assert.True(UpdateVersion.TryParse(text, out var v));
        Assert.Equal(new UpdateVersion(a, b, c), v);
    }

    [Theory]
    [InlineData("1.2.3-beta")]
    [InlineData("latest")]
    [InlineData("")]
    [InlineData("1")]
    public void 正式版でないものは読まない(string text) => Assert.False(UpdateVersion.TryParse(text, out _));

    [Fact]
    public void 数値として比べる()
    {
        UpdateVersion.TryParse("1.10.0", out var a);
        UpdateVersion.TryParse("1.9.9", out var b);
        Assert.True(a > b);
    }
}

public class UpdateSourceTests
{
    [Fact]
    public void 空なら既定のGitHub()
    {
        var s = UpdateSource.Parse("");
        Assert.True(s.IsDefault);
        Assert.Equal("https://github.com/Yu5rin/Sash/releases.atom", s.AtomUrl);
    }

    [Fact]
    public void 共有フォルダとURLを見分ける()
    {
        Assert.Equal(UpdateSourceKind.Folder, UpdateSource.Parse(@"\\server\share\Sash").Kind);
        var m = UpdateSource.Parse("https://intra.example.com/tools/sash/");
        Assert.Equal(UpdateSourceKind.Manifest, m.Kind);
        Assert.Equal("https://intra.example.com/tools/sash/latest.json", m.Location);
        Assert.Equal(UpdateSourceKind.GitHub, UpdateSource.Parse("https://github.com/someone/Fork/releases").Kind);
    }

    [Fact]
    public void httpは使えない() => Assert.Throws<ArgumentException>(() => UpdateSource.Parse("http://intra.example.com/latest.json"));

    [Theory]
    [InlineData("file:///C:/Sash/latest.json")]
    [InlineData("ftp://intra.example.com/sash/")]
    [InlineData("updates")]
    [InlineData(@"Sash\updates")]
    [InlineData(@"C:Sash")]
    [InlineData(@"\\")]
    public void httpsでないURLや相対パスは使えない(string text) => Assert.Throws<ArgumentException>(() => UpdateSource.Parse(text));

    [Theory]
    [InlineData(@"C:\Sash\updates")]
    [InlineData(@"\\fs\tools\Sash")]
    [InlineData("D:/Sash")]
    public void 完全なパスはフォルダとして使える(string text)
    {
        var s = UpdateSource.Parse(text);
        Assert.Equal(UpdateSourceKind.Folder, s.Kind);
        Assert.Equal(text, s.Location);
    }

    [Theory]
    [InlineData("https://intra.example.com/社内 ツール/sash/", "https://intra.example.com/%E7%A4%BE%E5%86%85%20%E3%83%84%E3%83%BC%E3%83%AB/sash/latest.json")]
    [InlineData("https://intra.example.com/my%20tools/", "https://intra.example.com/my%20tools/latest.json")]
    public void フォルダのURLに足すlatest_jsonはエスケープしたままのURLにする(string text, string expected) =>
        Assert.Equal(expected, UpdateSource.Parse(text).Location);

    [Fact]
    public void クエリの付いたURLもパスで判断する()
    {
        Assert.Equal("https://intra.example.com/sash/latest.json?token=abc", UpdateSource.Parse("https://intra.example.com/sash/latest.json?token=abc").Location);
        Assert.Equal("https://intra.example.com/sash/latest.json?v=1", UpdateSource.Parse("https://intra.example.com/sash/?v=1").Location);
    }
}

public class UpdateFeedLogicTests
{
    private const string Atom = """
        <?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry><link rel="alternate" type="text/html" href="https://github.com/Yu5rin/Sash/releases/tag/v0.9.0"/></entry>
          <entry><link rel="alternate" type="text/html" href="https://github.com/Yu5rin/Sash/releases/tag/v1.10.0"/></entry>
          <entry><link rel="alternate" type="text/html" href="https://github.com/Yu5rin/Sash/releases/tag/v1.9.0"/></entry>
          <entry><link rel="alternate" type="text/html" href="https://github.com/Yu5rin/Sash/releases/tag/v2.0.0-beta"/></entry>
        </feed>
        """;

    [Fact]
    public void Atomから並び順に頼らず最大の正式版を選ぶ()
    {
        var latest = UpdateFeedLogic.LatestFromAtom(Atom)!.Value;
        Assert.Equal("v1.10.0", latest.Tag);
        Assert.Equal(new UpdateVersion(1, 10, 0), latest.Version);
    }

    [Theory]
    [InlineData("<not xml")]
    [InlineData("<html><body>サインインしてください</body></html>")]
    [InlineData("<feed><entry/></feed>")]
    [InlineData("")]
    public void Atomでない応答は最新とみなさず失敗にする(string body) =>
        Assert.Throws<FormatException>(() => UpdateFeedLogic.LatestFromAtom(body));

    [Fact]
    public void 版のないフィードはnull()
    {
        Assert.Null(UpdateFeedLogic.LatestFromAtom("""<feed xmlns="http://www.w3.org/2005/Atom"></feed>"""));
        Assert.Null(UpdateFeedLogic.LatestFromAtom("""<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="https://github.com/a/b/releases/tag/nightly"/></entry></feed>"""));
    }

    [Fact]
    public void GitHubの配布物と照合値のURLを規則で組み立てる()
    {
        var r = UpdateFeedLogic.ForGitHub(UpdateSource.Default, "v1.2.3", new UpdateVersion(1, 2, 3));
        Assert.Equal("https://github.com/Yu5rin/Sash/releases/download/v1.2.3/Sash-1.2.3-win-x64.exe", r.DownloadUrl);
        Assert.Equal(r.DownloadUrl + ".sha256", r.ChecksumUrl);
        Assert.Equal("https://github.com/Yu5rin/Sash/releases/tag/v1.2.3", r.PageUrl);
    }

    [Fact]
    public void 照合値ファイルを読む()
    {
        var hash = new string('a', 64);
        Assert.Equal(hash, UpdateFeedLogic.ParseChecksum(hash.ToUpperInvariant()));
        Assert.Equal(hash, UpdateFeedLogic.ParseChecksum($"{hash}  Sash-1.2.3-win-x64.exe\n", "Sash-1.2.3-win-x64.exe"));
        Assert.Null(UpdateFeedLogic.ParseChecksum($"{hash}  other.exe", "Sash-1.2.3-win-x64.exe"));
        Assert.Null(UpdateFeedLogic.ParseChecksum("壊れている"));
    }

    [Fact]
    public void 照合値ファイルの先頭のBOMは無視する()
    {
        var hash = new string('c', 64);
        Assert.Equal(hash, UpdateFeedLogic.ParseChecksum($"\uFEFF{hash}  Sash-1.2.3-win-x64.exe\r\n", "Sash-1.2.3-win-x64.exe"));
        Assert.Equal(hash, UpdateFeedLogic.ParseChecksum($"\uFEFF{hash}"));
    }

    [Fact]
    public void latest_jsonを共有フォルダとURLで読む()
    {
        var json = UpdateFeedLogic.BuildManifest(new UpdateVersion(1, 2, 3), new string('b', 64), "修正");

        var folder = UpdateFeedLogic.ForManifest(UpdateSource.Parse(@"\\server\share\Sash"), json);
        Assert.Equal(Path.Combine(@"\\server\share\Sash", "Sash-1.2.3-win-x64.exe"), folder.DownloadUrl);
        Assert.Equal(new string('b', 64), folder.Sha256);
        Assert.Equal("修正", folder.Notes);

        var web = UpdateFeedLogic.ForManifest(UpdateSource.Parse("https://intra.example.com/sash/latest.json"), json);
        Assert.Equal("https://intra.example.com/sash/Sash-1.2.3-win-x64.exe", web.DownloadUrl);
    }

    [Theory]
    [InlineData("""{"version":"1.2.3","file":"../evil.exe","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}""")]
    [InlineData("""{"version":"1.2.3","file":"https://evil.example.com/x.exe","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}""")]
    [InlineData("""{"version":"1.2.3"}""")]
    [InlineData("""{"version":"x","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}""")]
    [InlineData("""["1.2.3"]""")]
    [InlineData("\"1.2.3\"")]
    [InlineData("null")]
    public void 別の場所を指すものや照合値のないlatest_jsonは拒否する(string json) =>
        Assert.Throws<FormatException>(() => UpdateFeedLogic.ForManifest(UpdateSource.Parse("https://intra.example.com/sash/latest.json"), json));
}

public class ExecutableReplacerTests
{
    [Fact]
    public void 入れ替えて古い版を退避し次の起動で消す()
    {
        using var book = new TestWorkbook();
        var exe = Path.Combine(book.BackupRoot, "Sash.exe");
        var next = Path.Combine(book.BackupRoot, "new.exe");
        File.WriteAllText(exe, "old");
        File.WriteAllText(next, "new");

        ExecutableReplacer.Replace(exe, next);

        Assert.Equal("new", File.ReadAllText(exe));
        Assert.Equal("old", File.ReadAllText(exe + ".old"));
        ExecutableReplacer.CleanupLeftovers(exe);
        Assert.False(File.Exists(exe + ".old"));
    }

    [Fact]
    public void 新しいファイルがなければ元に戻す()
    {
        using var book = new TestWorkbook();
        var exe = Path.Combine(book.BackupRoot, "Sash.exe");
        File.WriteAllText(exe, "old");

        Assert.ThrowsAny<IOException>(() => ExecutableReplacer.Replace(exe, Path.Combine(book.BackupRoot, "missing.exe")));

        Assert.Equal("old", File.ReadAllText(exe));
        Assert.False(File.Exists(exe + ".old"));
    }
}

public class UpdatePolicyTests
{
    [Fact]
    public void 管理者の設定ファイルを読み壊れていれば止める()
    {
        using var book = new TestWorkbook();
        Assert.Null(UpdatePolicy.Load(book.BackupRoot));

        File.WriteAllText(Path.Combine(book.BackupRoot, UpdatePolicy.FileName), """
            // 社内の共有フォルダから更新する
            { "source": "\\\\fs\\tools\\Sash", "checkOnStartup": true, }
            """);
        var p = UpdatePolicy.Load(book.BackupRoot)!;
        Assert.Equal(@"\\fs\tools\Sash", p.Source);
        Assert.True(p.CheckOnStartup);
        Assert.False(p.Disabled);

        File.WriteAllText(Path.Combine(book.BackupRoot, UpdatePolicy.FileName), "{ 壊れ");
        Assert.True(UpdatePolicy.Load(book.BackupRoot)!.Disabled);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("\"\\\\fs\\tools\"")]
    [InlineData("null")]
    public void オブジェクトでない設定ファイルは止める(string json)
    {
        using var book = new TestWorkbook();
        File.WriteAllText(Path.Combine(book.BackupRoot, UpdatePolicy.FileName), json);
        Assert.True(UpdatePolicy.Load(book.BackupRoot)!.Disabled);
    }
}
