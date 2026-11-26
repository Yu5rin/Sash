using Sash.Core.CustomUI;
using Sash.Core.Packaging;

namespace Sash.Core.Tests;

public class RibbonFingerprintTests
{
    private const string Ns = CustomUIConstants.Namespace2010;
    private static readonly IReadOnlyDictionary<string, string> NoImages = new Dictionary<string, string>();

    private static string Canon(string xml, IReadOnlyDictionary<string, string>? images = null) => RibbonFingerprint.Canonical(xml, images ?? NoImages);

    private static CustomUIPart Part(string xml, params (string Id, byte[] Data)[] images) =>
        new(CustomUIVersion.Office2010, new Uri("/customUI/customUI14.xml", UriKind.Relative), xml,
            images.Select(i => new RibbonImage(i.Id, new Uri($"/customUI/images/{i.Id}.png", UriKind.Relative), "image/png", i.Data)).ToList());

    [Fact]
    public void 属性の順_空白_XML宣言_接頭辞_コメントの違いは同じ内容として扱う()
    {
        var original = $"""<customUI xmlns="{Ns}"><ribbon><tabs><tab id="t" label="集計"><group id="g" label="G"><button id="b" label="B" onAction="Run"/></group></tab></tabs></ribbon></customUI>""";
        // Excel が保存し直したときに起こりうる書き換え：宣言の追加、改行と字下げ、属性の並び替え、接頭辞つきの名前空間、コメント
        var rewritten = $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <x:customUI xmlns:x="{Ns}">
              <!-- 編集者のメモ -->
              <x:ribbon>
                <x:tabs>
                  <x:tab label="集計" id="t">
                    <x:group label="G" id="g">
                      <x:button onAction="Run" label="B" id="b"></x:button>
                    </x:group>
                  </x:tab>
                </x:tabs>
              </x:ribbon>
            </x:customUI>
            """;

        Assert.Equal(Canon(original), Canon(rewritten));
    }

    [Fact]
    public void 属性の値_要素の並び_要素の追加_名前空間が違えば別の内容()
    {
        var baseXml = $"""<customUI xmlns="{Ns}"><ribbon><tabs><tab id="t"><group id="a"/><group id="b"/></tab></tabs></ribbon></customUI>""";

        Assert.NotEqual(Canon(baseXml), Canon(baseXml.Replace("id=\"t\"", "id=\"u\"", StringComparison.Ordinal)));
        Assert.NotEqual(Canon(baseXml), Canon(baseXml.Replace("<group id=\"a\"/><group id=\"b\"/>", "<group id=\"b\"/><group id=\"a\"/>", StringComparison.Ordinal)));
        Assert.NotEqual(Canon(baseXml), Canon(baseXml.Replace("</tab>", "<group id=\"c\"/></tab>", StringComparison.Ordinal)));
        Assert.NotEqual(Canon(baseXml), Canon(baseXml.Replace(Ns, CustomUIConstants.Namespace2007, StringComparison.Ordinal)));
    }

    [Fact]
    public void 属性の値の中の空白は区別する()
    {
        var a = $"""<customUI xmlns="{Ns}"><ribbon><tabs><tab id="t" label="集計 ツール"/></tabs></ribbon></customUI>""";
        var b = $"""<customUI xmlns="{Ns}"><ribbon><tabs><tab id="t" label="集計  ツール"/></tabs></ribbon></customUI>""";

        Assert.NotEqual(Canon(a), Canon(b));
    }

    [Fact]
    public void XMLとして読めなければ_改行をそろえた生の文字列で代用し_同じ中身なら同じ値になる()
    {
        Assert.Equal(Canon("<customUI>\r\n<oops"), Canon("<customUI>\n<oops"));
        Assert.NotEqual(Canon("<customUI><oops"), Canon("<customUI><oops2"));
    }

    [Fact]
    public void 画像の中身が変われば変更_Idの付け替えだけなら変更ではない()
    {
        string Xml(string imageId) => $"""<customUI xmlns="{Ns}"><ribbon><tabs><tab id="t"><group id="g"><button id="b" image="{imageId}"/></group></tab></tabs></ribbon></customUI>""";
        var png1 = new byte[] { 1, 2, 3, 4 };
        var png2 = new byte[] { 9, 9, 9, 9 };

        var original = RibbonFingerprint.Compute(Part(Xml("rId1"), ("rId1", png1)));
        // リレーション Id が振り直されても（XML の参照も一緒に変わる）、指している画像が同じなら同じ
        var renumbered = RibbonFingerprint.Compute(Part(Xml("rId7"), ("rId7", png1)));
        var changedImage = RibbonFingerprint.Compute(Part(Xml("rId1"), ("rId1", png2)));
        var extraImage = RibbonFingerprint.Compute(Part(Xml("rId1"), ("rId1", png1), ("rId2", png2)));
        // ボタンが指す画像を入れ替えた（中身は同じ 2 枚）
        var swapped = RibbonFingerprint.Compute(Part(Xml("rId2"), ("rId1", png1), ("rId2", png2)));
        var notSwapped = RibbonFingerprint.Compute(Part(Xml("rId1"), ("rId1", png1), ("rId2", png2)));

        Assert.Equal(original, renumbered);
        Assert.NotEqual(original, changedImage);
        Assert.NotEqual(original, extraImage);
        Assert.NotEqual(swapped, notSwapped);
    }

    [Fact]
    public void Same_パーツの種類も照合値も同じときだけtrue()
    {
        var a = new Dictionary<string, string> { ["office2010"] = "x" };

        Assert.True(RibbonFingerprint.Same(a, new Dictionary<string, string> { ["office2010"] = "x" }));
        Assert.False(RibbonFingerprint.Same(a, new Dictionary<string, string> { ["office2010"] = "y" }));
        Assert.False(RibbonFingerprint.Same(a, new Dictionary<string, string> { ["office2007"] = "x" }));
        Assert.False(RibbonFingerprint.Same(a, new Dictionary<string, string> { ["office2010"] = "x", ["office2007"] = "z" }));
        Assert.False(RibbonFingerprint.Same(a, null));
    }

    [Fact]
    public void ファイルに保存した内容を整形し直して書き込んでも_照合値は変わらず_中身を変えれば変わる()
    {
        using var book = new TestWorkbook();
        var xml = $"""<customUI xmlns="{Ns}"><ribbon><tabs><tab id="t" label="集計"><group id="g" label="G"><button id="b" label="B" onAction="Run"/></group></tab></tabs></ribbon></customUI>""";
        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, xml, [new NewImage("icon", [1, 2, 3])], [])]);
        var before = RibbonFingerprint.Compute(RibbonPackage.Load(book.Path));

        // ほかのプログラムが、同じ内容を整形し直して（宣言つき・字下げつき）書き込んだ
        var pretty = $"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<customUI xmlns=\"{Ns}\">\r\n  <ribbon>\r\n    <tabs>\r\n      <tab label=\"集計\" id=\"t\">\r\n        <group label=\"G\" id=\"g\">\r\n          <button onAction=\"Run\" label=\"B\" id=\"b\" />\r\n        </group>\r\n      </tab>\r\n    </tabs>\r\n  </ribbon>\r\n</customUI>";
        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, pretty, [], [])]);
        var afterReformat = RibbonFingerprint.Compute(RibbonPackage.Load(book.Path));

        Assert.True(RibbonFingerprint.Same(before, afterReformat));

        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, pretty.Replace("label=\"B\"", "label=\"B2\"", StringComparison.Ordinal), [], [])]);
        Assert.False(RibbonFingerprint.Same(before, RibbonFingerprint.Compute(RibbonPackage.Load(book.Path))));
    }

    [Fact]
    public void リボン以外_シートなど_が変わっても照合値は変わらない()
    {
        using var book = new TestWorkbook();
        RibbonPackage.Save(book.Path, [new CustomUIPartChange(CustomUIVersion.Office2010, $"""<customUI xmlns="{Ns}"/>""", [], [])]);
        var before = RibbonFingerprint.Compute(RibbonPackage.Load(book.Path));

        // ワークブックのパーツ（リボンの外）を書き換える
        using (var package = System.IO.Packaging.Package.Open(book.Path, FileMode.Open, FileAccess.ReadWrite))
        using (var writer = new StreamWriter(package.GetPart(new Uri("/xl/workbook.xml", UriKind.Relative)).GetStream(FileMode.Create, FileAccess.Write)))
        {
            writer.Write("<workbook changed=\"1\"/>");
        }

        Assert.True(RibbonFingerprint.Same(before, RibbonFingerprint.Compute(RibbonPackage.Load(book.Path))));
    }

    [Fact]
    public void customUIがないブックの照合値は空()
    {
        using var book = new TestWorkbook();

        Assert.Empty(RibbonFingerprint.Compute(RibbonPackage.Load(book.Path)));
    }
}
