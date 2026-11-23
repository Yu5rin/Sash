using Sash.Core.Excel;

namespace Sash.Core.Tests;

public class VbaProcedureLookupTests
{
    private const string Code =
        "Option Explicit\r\n" +
        "' 引数のない Sub\r\n" +
        "Public Sub 集計する()\r\n" +
        "End Sub\r\n" +
        "\r\n" +
        "Sub Ribbon_btnRun_onAction(control As IRibbonControl)\r\n" +
        "End Sub\r\n" +
        "\r\n" +
        "Private Sub Long_Args(ByVal a As Long, _\r\n" +
        "    ByVal b As Long)\r\n" +
        "End Sub\r\n" +
        "\r\n" +
        "Public Function Arr(values() As Variant) As Long\r\n" +
        "End Function\r\n" +
        "Sub NoArgs ( ) ' コメント (x)\r\n" +
        "End Sub\r\n";

    [Theory]
    [InlineData("集計する", "")]
    [InlineData("RIBBON_BTNRUN_ONACTION", "control As IRibbonControl")]
    [InlineData("Long_Args", "ByVal a As Long,     ByVal b As Long")]
    [InlineData("Arr", "values() As Variant")]
    [InlineData("NoArgs", "")]
    public void 宣言の引数を返す(string name, string expected) => Assert.Equal(expected, VbaProcedureLookup.FindParameters(Code, name));

    [Theory]
    [InlineData("集計")]
    [InlineData("Ribbon_btnRun")]
    [InlineData("Missing")]
    public void ないものはnull(string name) => Assert.Null(VbaProcedureLookup.FindParameters(Code, name));

    [Theory]
    [InlineData("Run", null, "Run")]
    [InlineData("modRibbon.Run", "modRibbon", "Run")]
    [InlineData("Book.xlsm!Run", null, "Run")]
    [InlineData("'My Book.xlsm'!modA.Run", "modA", "Run")]
    public void モジュールとSubに分ける(string macro, string? module, string procedure) =>
        Assert.Equal((module, procedure), VbaProcedureLookup.Split(macro));

    [Theory]
    [InlineData("集計ツール.xlam", null, "Run", "'集計ツール.xlam'!Run")]
    [InlineData("Bob's.xlsm", "modA", "Run", "'Bob''s.xlsm'!modA.Run")]
    public void Runに渡す名前を作る(string book, string? module, string procedure, string expected) =>
        Assert.Equal(expected, VbaProcedureLookup.QualifiedName(book, module, procedure));
}
