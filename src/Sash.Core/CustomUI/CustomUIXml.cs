using System.Xml.Linq;
using static Sash.Core.Localization.Text;

namespace Sash.Core.CustomUI;

/// <summary>customUI の XML ファイル（Custom UI Editor や Office RibbonX Editor で作ったもの・他ツールや Git に置いたもの）の読み取り。</summary>
public static class CustomUIXml
{
    /// <summary>
    /// XML の名前空間から世代（customUI.xml か customUI14.xml か）を決める。
    /// XML として読めない・ルートが customUI でない・名前空間が customUI のものでないときは、利用者向けの文言で断る。
    /// </summary>
    public static CustomUIVersion DetectVersion(string xml)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(xml);
        }
        catch (System.Xml.XmlException ex)
        {
            throw new UserFacingException(L(
                $"XML として読めませんでした（{ex.LineNumber} 行目付近）。customUI の XML ファイルを選んでください。",
                $"This could not be read as XML (near line {ex.LineNumber}). Choose a customUI XML file."), ex);
        }

        var root = doc.Root;
        if (root is null || root.Name.LocalName != "customUI")
        {
            throw new UserFacingException(L("customUI の XML ではありません（ルート要素が customUI ではありません）。", "This is not a customUI XML file (the root element is not customUI)."));
        }

        return CustomUIConstants.VersionOfNamespace(root.Name.NamespaceName)
            ?? throw new UserFacingException(L(
                "customUI の名前空間（…/2009/07/customui または …/2006/01/customui）ではないため、リボンの定義として読めません。",
                "The namespace is not a customUI one (…/2009/07/customui or …/2006/01/customui), so it cannot be read as a ribbon definition."));
    }
}
