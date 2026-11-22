using Sash.Core.CustomUI;

namespace Sash.Core.Packaging;

/// <summary>ブックから読み込んだ customUI パーツ 1 つ分。</summary>
/// <param name="Version">スキーマ世代。</param>
/// <param name="PartUri">パッケージ内のパーツの URI。</param>
/// <param name="Xml">customUI の XML テキスト（読み込んだまま、整形しない）。</param>
/// <param name="Images">このパーツから参照される画像。</param>
public sealed record CustomUIPart(
    CustomUIVersion Version,
    Uri PartUri,
    string Xml,
    IReadOnlyList<RibbonImage> Images);
