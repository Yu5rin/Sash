using System.IO.Packaging;
using Sash.Core.CustomUI;
using Sash.Core.Packaging;

namespace Sash.Core.Tests;

public class RibbonPackageTests
{
    [Fact]
    public void customUIがないブックはPartsが空になる()
    {
        using var book = new TestWorkbook();

        var doc = RibbonPackage.Load(book.Path);

        Assert.Empty(doc.Parts);
        Assert.Null(doc.Primary);
        Assert.False(doc.HasBothVersions);
    }

    [Theory]
    [InlineData(CustomUIVersion.Office2010, "/customUI/customUI14.xml")]
    [InlineData(CustomUIVersion.Office2007, "/customUI/customUI.xml")]
    public void 新規保存でパーツとリレーションが作られ読み戻せる(CustomUIVersion version, string expectedUri)
    {
        using var book = new TestWorkbook();
        var xml = CustomUIConstants.EmptyDocument(version);

        RibbonPackage.SaveCustomUI(book.Path, version, xml);
        var doc = RibbonPackage.Load(book.Path);

        var part = Assert.Single(doc.Parts);
        Assert.Equal(version, part.Version);
        Assert.Equal(expectedUri, part.PartUri.ToString());
        Assert.Equal(xml, part.Xml);
    }

    [Fact]
    public void 上書き保存してもリレーションは増えない()
    {
        using var book = new TestWorkbook();

        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI/>");
        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI><ribbon/></customUI>");

        using (var package = Package.Open(book.Path, FileMode.Open, FileAccess.Read))
        {
            Assert.Single(package.GetRelationshipsByType(CustomUIConstants.RelationshipType2010));
        }

        Assert.Equal("<customUI><ribbon/></customUI>", RibbonPackage.Load(book.Path).Primary!.Xml);
    }

    [Fact]
    public void customUI以外のパーツには触れない()
    {
        using var book = new TestWorkbook(".xlam");

        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI/>");

        Assert.Equal(TestWorkbook.WorkbookContent, book.ReadWorkbookPart());
    }

    [Fact]
    public void 両方の世代があればHasBothVersionsが立ち2010以降を優先する()
    {
        using var book = new TestWorkbook();

        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2007, "<a/>");
        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<b/>");
        var doc = RibbonPackage.Load(book.Path);

        Assert.True(doc.HasBothVersions);
        Assert.Equal(CustomUIVersion.Office2010, doc.Primary!.Version);
    }

    [Fact]
    public void customUIから参照される画像を読み込む()
    {
        using var book = new TestWorkbook();
        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI/>");
        byte[] png = [0x89, 0x50, 0x4E, 0x47];

        using (var package = Package.Open(book.Path, FileMode.Open, FileAccess.ReadWrite))
        {
            var ui = package.GetPart(new Uri("/customUI/customUI14.xml", UriKind.Relative));
            var imageUri = PackUriHelper.CreatePartUri(new Uri("/customUI/images/img_btn.png", UriKind.Relative));
            var image = package.CreatePart(imageUri, "image/png");
            using (var s = image.GetStream(FileMode.Create))
            {
                s.Write(png);
            }

            ui.CreateRelationship(new Uri("images/img_btn.png", UriKind.Relative), TargetMode.Internal,
                CustomUIConstants.ImageRelationshipType, "img_btn");
        }

        var img = Assert.Single(RibbonPackage.Load(book.Path).Primary!.Images);
        Assert.Equal("img_btn", img.RelationshipId);
        Assert.Equal("/customUI/images/img_btn.png", img.PartUri.ToString());
        Assert.Equal(png, img.Data);
    }

    [Theory]
    [InlineData("a.xlsm", true)]
    [InlineData("a.XLAM", true)]
    [InlineData("a.xlsx", false)]
    [InlineData("a.xlsb", true)]
    [InlineData("a.xltm", true)]
    public void 対応する拡張子を判定する(string path, bool expected) =>
        Assert.Equal(expected, RibbonPackage.IsSupported(path));

    private static byte[] ReadCustomUIBytes(string path)
    {
        using var package = Package.Open(path, FileMode.Open, FileAccess.Read);
        using var stream = package.GetPart(new Uri("/customUI/customUI14.xml", UriKind.Relative)).GetStream();
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    [Fact]
    public void utf16と宣言したXMLはutf8の宣言に直して書く()
    {
        using var book = new TestWorkbook();

        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "\uFEFF<?xml version=\"1.0\" encoding=\"utf-16\" standalone=\"yes\"?><customUI/>");

        var bytes = ReadCustomUIBytes(book.Path);
        Assert.NotEqual(0xEF, bytes[0]);
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        Assert.Equal("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><customUI/>", text);
        Assert.Equal(text, RibbonPackage.Load(book.Path).Primary!.Xml);
    }

    [Theory]
    [InlineData("<?xml version=\"1.0\" encoding=\"UTF-8\"?><customUI/>")]
    [InlineData("<?xml version=\"1.0\"?><customUI/>")]
    [InlineData("<customUI/>")]
    public void utf8の宣言や宣言なしはそのまま書く(string xml) =>
        Assert.Equal(xml, RibbonPackage.ToUtf8Declaration(xml));

    [Fact]
    public void 一重引用符の宣言も直す() =>
        Assert.Equal("<?xml version='1.0' encoding='UTF-8'?><a/>", RibbonPackage.ToUtf8Declaration("<?xml version='1.0' encoding='Shift_JIS'?><a/>"));

    [Fact]
    public void 暗号化されたブックはわかる言葉で断る()
    {
        using var book = new TestWorkbook();
        File.WriteAllBytes(book.Path, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0]);

        Assert.Throws<UserFacingException>(() => RibbonPackage.Load(book.Path));
        Assert.Throws<UserFacingException>(() => RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI/>"));
    }

    [Fact]
    public void 読み取り専用のファイルには書き込まず一時ファイルも残さない()
    {
        using var book = new TestWorkbook();
        var before = File.ReadAllBytes(book.Path);
        File.SetAttributes(book.Path, FileAttributes.ReadOnly);
        try
        {
            Assert.Throws<UserFacingException>(() => RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI/>"));
            Assert.Equal(before, File.ReadAllBytes(book.Path));
        }
        finally
        {
            File.SetAttributes(book.Path, FileAttributes.Normal);
        }

        Assert.Empty(Directory.GetFiles(book.BackupRoot, "*.sash-tmp"));
    }

    [Fact]
    public void 保存した後に一時ファイルが残らない()
    {
        using var book = new TestWorkbook();

        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI/>");

        Assert.Equal(["book.xlsm"], Directory.GetFiles(book.BackupRoot).Select(Path.GetFileName));
    }

    [Fact]
    public void ないファイルには保存しない() =>
        Assert.Throws<FileNotFoundException>(() => RibbonPackage.SaveCustomUI(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".xlsm"), CustomUIVersion.Office2010, "<customUI/>"));

    // ---- 置き換えに対応していない場所（NAS・Samba・WebDAV）への保存 ----

    [Theory]
    [InlineData(unchecked((int)0x80070032))] // ERROR_NOT_SUPPORTED
    [InlineData(unchecked((int)0x80070001))] // ERROR_INVALID_FUNCTION
    [InlineData(unchecked((int)0x80131620))] // HResult を持たない IOException の既定値（COR_E_IO）
    public void 置き換えがIOExceptionで失敗したら上書きで書く(int hresult)
    {
        var dir = Directory.CreateTempSubdirectory("sash-replace-");
        try
        {
            var temp = Path.Combine(dir.FullName, "new.tmp");
            var target = Path.Combine(dir.FullName, "book.xlsm");
            File.WriteAllText(temp, "new");
            File.WriteAllText(target, "old");

            RibbonPackage.ReplaceFile(temp, target, (_, _) => throw new IOException("not supported", hresult));

            Assert.Equal("new", File.ReadAllText(target));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Theory]
    [InlineData(unchecked((int)0x80070020))] // ERROR_SHARING_VIOLATION
    [InlineData(unchecked((int)0x80070021))] // ERROR_LOCK_VIOLATION
    public void 共有違反とロック違反は上書きに切り替えずにそのまま投げる(int hresult)
    {
        var dir = Directory.CreateTempSubdirectory("sash-replace-");
        try
        {
            var temp = Path.Combine(dir.FullName, "new.tmp");
            var target = Path.Combine(dir.FullName, "book.xlsm");
            File.WriteAllText(temp, "new");
            File.WriteAllText(target, "old");

            var ex = Assert.Throws<IOException>(() => RibbonPackage.ReplaceFile(temp, target, (_, _) => throw new IOException("locked", hresult)));

            // 呼び出し側（Excel への反映の RetryOnLock）が待ってやり直せるよう、元の HResult のまま届く
            Assert.Equal(hresult, ex.HResult);
            Assert.Equal("old", File.ReadAllText(target));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void ファイルがないときは上書きに切り替えない()
    {
        Assert.False(RibbonPackage.ShouldFallBackToCopy(new FileNotFoundException("x")));
        Assert.False(RibbonPackage.ShouldFallBackToCopy(new DirectoryNotFoundException("x")));
        Assert.True(RibbonPackage.ShouldFallBackToCopy(new IOException("x")));
    }

    [Fact]
    public void 置き換えに対応していない環境では上書きで書く()
    {
        var dir = Directory.CreateTempSubdirectory("sash-replace-");
        try
        {
            var temp = Path.Combine(dir.FullName, "new.tmp");
            var target = Path.Combine(dir.FullName, "book.xlsm");
            File.WriteAllText(temp, "new");
            File.WriteAllText(target, "old");

            RibbonPackage.ReplaceFile(temp, target, (_, _) => throw new PlatformNotSupportedException());

            Assert.Equal("new", File.ReadAllText(target));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
