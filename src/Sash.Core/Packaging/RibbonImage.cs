namespace Sash.Core.Packaging;

/// <summary>customUI パーツから参照される画像。</summary>
/// <param name="RelationshipId">image 属性に書く値（リレーションの Id）。</param>
/// <param name="PartUri">パッケージ内の画像パーツの URI。</param>
/// <param name="ContentType">画像のコンテンツタイプ（例：image/png）。</param>
/// <param name="Data">画像のバイト列。</param>
public sealed record RibbonImage(string RelationshipId, Uri PartUri, string ContentType, byte[] Data);
