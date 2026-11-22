namespace Sash.Core.CustomUI;

/// <summary>customUI パーツのスキーマ世代。</summary>
public enum CustomUIVersion
{
    /// <summary>Office 2007 形式（customUI/customUI.xml）。</summary>
    Office2007,

    /// <summary>Office 2010 以降の形式（customUI/customUI14.xml）。新規作成時の既定。</summary>
    Office2010,
}

/// <summary>customUI の世代ごとに決まる定数。</summary>
public static class CustomUIConstants
{
    /// <summary>2007 形式の名前空間。</summary>
    public const string Namespace2007 = "http://schemas.microsoft.com/office/2006/01/customui";

    /// <summary>2010 以降の形式の名前空間。</summary>
    public const string Namespace2010 = "http://schemas.microsoft.com/office/2009/07/customui";

    /// <summary>パッケージ直下から 2007 形式の customUI を指すリレーションの種類。</summary>
    public const string RelationshipType2007 = "http://schemas.microsoft.com/office/2006/relationships/ui/extensibility";

    /// <summary>パッケージ直下から 2010 以降の customUI を指すリレーションの種類。</summary>
    public const string RelationshipType2010 = "http://schemas.microsoft.com/office/2007/relationships/ui/extensibility";

    /// <summary>customUI パーツから画像を指すリレーションの種類。</summary>
    public const string ImageRelationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

    /// <summary>customUI パーツのコンテンツタイプ。</summary>
    public const string ContentType = "application/xml";

    public static string NamespaceOf(CustomUIVersion version) => version switch
    {
        CustomUIVersion.Office2007 => Namespace2007,
        CustomUIVersion.Office2010 => Namespace2010,
        _ => throw new ArgumentOutOfRangeException(nameof(version)),
    };

    public static string RelationshipTypeOf(CustomUIVersion version) => version switch
    {
        CustomUIVersion.Office2007 => RelationshipType2007,
        CustomUIVersion.Office2010 => RelationshipType2010,
        _ => throw new ArgumentOutOfRangeException(nameof(version)),
    };

    /// <summary>新規作成時に使うパーツの URI。</summary>
    public static Uri DefaultPartUriOf(CustomUIVersion version) => version switch
    {
        CustomUIVersion.Office2007 => new Uri("/customUI/customUI.xml", UriKind.Relative),
        CustomUIVersion.Office2010 => new Uri("/customUI/customUI14.xml", UriKind.Relative),
        _ => throw new ArgumentOutOfRangeException(nameof(version)),
    };

    /// <summary>空のリボン定義（新規作成用）。</summary>
    public static string EmptyDocument(CustomUIVersion version) =>
        $"""
        <customUI xmlns="{NamespaceOf(version)}">
          <ribbon>
            <tabs>
            </tabs>
          </ribbon>
        </customUI>
        """;
}
