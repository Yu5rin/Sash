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
    [InlineData("a.xlsb", false)]
    public void 対応する拡張子を判定する(string path, bool expected) =>
        Assert.Equal(expected, RibbonPackage.IsSupported(path));
}
