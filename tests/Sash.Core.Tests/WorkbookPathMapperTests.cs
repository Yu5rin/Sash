using Sash.Core.Excel;

namespace Sash.Core.Tests;

public class WorkbookPathMapperTests
{
    private static readonly SyncMount[] Mounts =
    [
        new("https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents/", @"C:\Users\user\OneDrive - Contoso"),
        new("https://contoso.sharepoint.com/sites/Team/Shared%20Documents", @"C:\Users\user\Contoso\Team - Documents"),
        new("https://contoso.sharepoint.com/sites/Team/Shared Documents/General", @"C:\Users\user\Contoso\Team - General"),
        new("https://d.docs.live.net/0123abcd", @"C:\Users\user\OneDrive"),
    ];

    [Theory]
    [InlineData("https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents/集計/売上 2026.xlsm", @"C:\Users\user\OneDrive - Contoso\集計\売上 2026.xlsm")]
    [InlineData("https://CONTOSO-MY.sharepoint.com/personal/user_contoso_com/Documents/a.xlam", @"C:\Users\user\OneDrive - Contoso\a.xlam")]
    [InlineData("https://d.docs.live.net/0123abcd/Documents/book.xlsm", @"C:\Users\user\OneDrive\Documents\book.xlsm")]
    [InlineData("https://d.docs.live.net/0123abcd/Documents/book%20x.xlsm", @"C:\Users\user\OneDrive\Documents\book x.xlsm")]
    [InlineData("https://contoso.sharepoint.com/sites/Team/Shared Documents/x.xlsm", @"C:\Users\user\Contoso\Team - Documents\x.xlsm")]
    [InlineData("https://contoso.sharepoint.com/sites/Team/Shared Documents/General/C# 100%.xlsm", @"C:\Users\user\Contoso\Team - General\C# 100%.xlsm")]
    public void 同期フォルダのURLをローカルのパスに直す(string url, string expected) =>
        Assert.Equal(expected, WorkbookPathMapper.ToLocalPath(url, Mounts));

    [Theory]
    [InlineData("https://contoso.sharepoint.com/sites/Other/Shared Documents/x.xlsm")]
    [InlineData("https://d.docs.live.net/0123abcdef/x.xlsm")]
    [InlineData("https://d.docs.live.net/0123abcd/")]
    [InlineData(@"C:\work\book.xlsm")]
    public void 当てはまらないものは直さない(string url) => Assert.Null(WorkbookPathMapper.ToLocalPath(url, Mounts));

    [Fact]
    public void ローカルのパスはそのまま比べる()
    {
        Assert.Equal(@"C:\work\book.xlsm", WorkbookPathMapper.Normalize(@"C:\work\book.xlsm", Mounts));
        Assert.True(WorkbookPathMapper.SamePath(@"c:\WORK\Book.xlsm", "C:/work/book.xlsm"));
        Assert.False(WorkbookPathMapper.SamePath(@"C:\work\book.xlsm", @"C:\work2\book.xlsm"));
        Assert.False(WorkbookPathMapper.SamePath(null, @"C:\work\book.xlsm"));
    }
}
