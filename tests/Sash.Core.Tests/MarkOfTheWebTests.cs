using Sash.Core.CustomUI;
using Sash.Core.Packaging;

namespace Sash.Core.Tests;

public class MarkOfTheWebTests
{
    [Theory]
    [InlineData("[ZoneTransfer]\r\nZoneId=3\r\n", 3)]
    [InlineData("[ZoneTransfer]\nZoneId=4\nReferrerUrl=https://example.com/\n", 4)]
    [InlineData("[ZoneTransfer]\r\nzoneid = 2", null)]
    [InlineData("[ZoneTransfer]\r\nZoneId=abc\r\n", null)]
    [InlineData("", null)]
    public void ZoneId_を読む(string content, int? expected) => Assert.Equal(expected, MarkOfTheWeb.ZoneOf(content));

    [Fact]
    public void 印のない普通のファイルはfalse()
    {
        using var book = new TestWorkbook();

        Assert.False(MarkOfTheWeb.IsMarked(book.Path));
        Assert.False(MarkOfTheWeb.IsMarked(book.Path + ".none"));
    }

    [Fact]
    public void customUIのXMLファイルの世代を名前空間から決め_違うものは利用者向けの文言で断る()
    {
        Assert.Equal(CustomUIVersion.Office2010, CustomUIXml.DetectVersion($"<customUI xmlns=\"{CustomUIConstants.Namespace2010}\"/>"));
        Assert.Equal(CustomUIVersion.Office2007, CustomUIXml.DetectVersion($"<?xml version=\"1.0\"?><customUI xmlns=\"{CustomUIConstants.Namespace2007}\"/>"));
        Assert.Throws<UserFacingException>(() => CustomUIXml.DetectVersion("<customUI"));
        Assert.Throws<UserFacingException>(() => CustomUIXml.DetectVersion("<root/>"));
        Assert.Throws<UserFacingException>(() => CustomUIXml.DetectVersion("<customUI xmlns=\"http://example.com/\"/>"));
    }

    [Fact]
    public void 名前空間から世代を決める()
    {
        Assert.Equal(CustomUIVersion.Office2010, CustomUIConstants.VersionOfNamespace(CustomUIConstants.Namespace2010));
        Assert.Equal(CustomUIVersion.Office2007, CustomUIConstants.VersionOfNamespace(CustomUIConstants.Namespace2007));
        Assert.Null(CustomUIConstants.VersionOfNamespace("http://example.com/"));
        Assert.Null(CustomUIConstants.VersionOfNamespace(null));
    }
}
