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
        "End Sub\r\n" +
        "Sub WithDefault(Optional v As Variant = Array(1, 2), Optional s As String = \")(\")\r\n" +
        "End Sub\r\n" +
        "Function Nested(Optional x As Long = (1 + (2 * 3))) As Long\r\n" +
        "End Function\r\n";

    [Theory]
    [InlineData("集計する", "")]
    [InlineData("RIBBON_BTNRUN_ONACTION", "control As IRibbonControl")]
    [InlineData("Long_Args", "ByVal a As Long,     ByVal b As Long")]
    [InlineData("Arr", "values() As Variant")]
    [InlineData("NoArgs", "")]
    [InlineData("WithDefault", "Optional v As Variant = Array(1, 2), Optional s As String = \")(\"")]
    [InlineData("Nested", "Optional x As Long = (1 + (2 * 3))")]
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

    [Fact]
    public void 引数は括弧と文字列の外のカンマで分ける() =>
        Assert.Equal(["Optional v As Variant = Array(1, 2)", "s As String = \"a,b\"", "n As Long"], VbaProcedureLookup.SplitParameters("Optional v As Variant = Array(1, 2), s As String = \"a,b\", n As Long"));

    [Theory]
    [InlineData("", MacroCallShape.NoArguments)]
    [InlineData("   ", MacroCallShape.NoArguments)]
    [InlineData("control As IRibbonControl", MacroCallShape.RibbonControl)]
    [InlineData("ByVal control As Office.IRibbonControl", MacroCallShape.RibbonControl)]
    [InlineData("control As Object", MacroCallShape.RibbonControl)]
    [InlineData("control", MacroCallShape.RibbonControl)]
    [InlineData("Optional control As Variant = Empty", MacroCallShape.RibbonControl)]
    [InlineData("control As IRibbonControl, pressed As Boolean", MacroCallShape.Unsupported)]
    [InlineData("text As String", MacroCallShape.Unsupported)]
    [InlineData("values() As Variant", MacroCallShape.Unsupported)]
    [InlineData("ParamArray args() As Variant", MacroCallShape.Unsupported)]
    [InlineData("v As Variant = Array(1, 2)", MacroCallShape.RibbonControl)]
    public void 呼び方を決める(string parameters, MacroCallShape expected)
    {
        var shape = VbaProcedureLookup.Classify(parameters, out var reason);
        Assert.Equal(expected, shape);
        Assert.Equal(expected == MacroCallShape.Unsupported, reason is not null);
    }

    [Theory]
    [InlineData("Run", true)]
    [InlineData("集計する", true)]
    [InlineData("Module1", true)]
    [InlineData("Ribbon_btn_onAction", true)]
    [InlineData("_Run", false)]
    [InlineData("1Run", false)]
    [InlineData("Run()", false)]
    [InlineData("Run'", false)]
    [InlineData("a b", false)]
    [InlineData("Book.xlsm!Run", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void VBAの名前か(string? name, bool expected) => Assert.Equal(expected, VbaProcedureLookup.IsVbaIdentifier(name));
}
