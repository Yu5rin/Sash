using Sash.Core.CustomUI;

namespace Sash.Core.Packaging;

/// <summary>ブック（.xlsm / .xlam）から読み込んだリボン定義の一式。</summary>
public sealed class RibbonDocument
{
    internal RibbonDocument(string path, IReadOnlyList<CustomUIPart> parts)
    {
        Path = path;
        Parts = parts;
    }

    /// <summary>読み込んだファイルのフルパス。</summary>
    public string Path { get; }

    /// <summary>ファイル内にある customUI パーツ（0〜2 個）。</summary>
    public IReadOnlyList<CustomUIPart> Parts { get; }

    public CustomUIPart? Get(CustomUIVersion version) => Parts.FirstOrDefault(p => p.Version == version);

    /// <summary>
    /// 2007 形式と 2010 以降の形式が両方ある。
    /// この場合、2010 以降の Excel は customUI14 を優先する（仕様書 §5.1）。
    /// </summary>
    public bool HasBothVersions => Get(CustomUIVersion.Office2007) is not null && Get(CustomUIVersion.Office2010) is not null;

    /// <summary>
    /// 既定で編集対象にするパーツ。2010 以降の形式を優先し、なければ 2007 形式、どちらもなければ null。
    /// </summary>
    public CustomUIPart? Primary => Get(CustomUIVersion.Office2010) ?? Get(CustomUIVersion.Office2007);
}
