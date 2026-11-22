using System.IO.Packaging;
using Sash.Core.CustomUI;
using Sash.Core.Packaging;

namespace Sash.Core.Tests;

public class SaveWithImagesTests
{
    private static readonly byte[] Png1 = [0x89, 0x50, 0x4E, 0x47, 1];
    private static readonly byte[] Png2 = [0x89, 0x50, 0x4E, 0x47, 2];

    [Fact]
    public void 画像を追加するとcustomUIのrelsに登録され読み戻せる()
    {
        using var book = new TestWorkbook();

        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, "<customUI/>", [new NewImage("img_btn1", Png1)], [])]);

        var img = Assert.Single(RibbonPackage.Load(book.Path).Primary!.Images);
        Assert.Equal("img_btn1", img.RelationshipId);
        Assert.Equal("/customUI/images/img_btn1.png", img.PartUri.ToString());
        Assert.Equal("image/png", img.ContentType);
        Assert.Equal(Png1, img.Data);

        using var package = Package.Open(book.Path, FileMode.Open, FileAccess.Read);
        Assert.True(package.PartExists(new Uri("/customUI/_rels/customUI14.xml.rels", UriKind.Relative)));
    }

    [Fact]
    public void 同じIdの画像は差し替えられる()
    {
        using var book = new TestWorkbook();
        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, "<customUI/>", [new NewImage("img", Png1)], [])]);

        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, "<customUI/>", [new NewImage("img", Png2)], [])]);

        var img = Assert.Single(RibbonPackage.Load(book.Path).Primary!.Images);
        Assert.Equal(Png2, img.Data);
    }

    [Fact]
    public void 画像を削除するとパーツとリレーションが消える()
    {
        using var book = new TestWorkbook();
        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, "<customUI/>", [new NewImage("a", Png1), new NewImage("b", Png2)], [])]);

        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, "<customUI/>", [], ["a"])]);

        var img = Assert.Single(RibbonPackage.Load(book.Path).Primary!.Images);
        Assert.Equal("b", img.RelationshipId);
        using var package = Package.Open(book.Path, FileMode.Open, FileAccess.Read);
        Assert.False(package.PartExists(new Uri("/customUI/images/a.png", UriKind.Relative)));
    }

    [Fact]
    public void 両方のパーツを一度に書き込める()
    {
        using var book = new TestWorkbook();

        RibbonPackage.Save(book.Path,
        [
            new CustomUIPartChange(CustomUIVersion.Office2010, "<x14/>", [], []),
            new CustomUIPartChange(CustomUIVersion.Office2007, "<x12/>", [], []),
        ]);

        var doc = RibbonPackage.Load(book.Path);
        Assert.Equal("<x14/>", doc.Get(CustomUIVersion.Office2010)!.Xml);
        Assert.Equal("<x12/>", doc.Get(CustomUIVersion.Office2007)!.Xml);
        Assert.Equal(TestWorkbook.WorkbookContent, book.ReadWorkbookPart());
    }

    [Fact]
    public void 一時ファイルは残らない()
    {
        using var book = new TestWorkbook();

        RibbonPackage.SaveCustomUI(book.Path, CustomUIVersion.Office2010, "<customUI/>");

        Assert.Single(Directory.GetFiles(Path.GetDirectoryName(book.Path)!));
    }
}
