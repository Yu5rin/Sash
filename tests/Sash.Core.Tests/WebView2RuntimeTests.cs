namespace Sash.Core.Tests;

public class WebView2RuntimeTests
{
    [Theory]
    [InlineData("109.0.1518.140", 109)]
    [InlineData("131.0.2903.70", 131)]
    [InlineData(" 120.0.2210.91 ", 120)]
    [InlineData("108", 108)]
    public void 主版数を読む(string text, int expected)
    {
        Assert.True(WebView2Runtime.TryGetMajorVersion(text, out var major));
        Assert.Equal(expected, major);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("abc")]
    [InlineData("x.109.0")]
    [InlineData("12abc.0")]
    [InlineData("-5.0")]
    [InlineData("99999999999.0")]
    public void 壊れた文字列は読まない(string? text) => Assert.False(WebView2Runtime.TryGetMajorVersion(text, out _));

    [Theory]
    [InlineData("109.0.1518.140", false)] // 下限ちょうどは古くない
    [InlineData("131.0.2903.70", false)]
    [InlineData("108.0.1462.54", true)]
    [InlineData("86.0.622.38", true)]
    public void 古すぎるかを判定する(string text, bool tooOld) => Assert.Equal(tooOld, WebView2Runtime.IsTooOld(text));

    [Theory]
    [InlineData(null)]
    [InlineData("壊れた")]
    public void 版が読めないときは古いと決めつけない(string? text) => Assert.False(WebView2Runtime.IsTooOld(text));
}
