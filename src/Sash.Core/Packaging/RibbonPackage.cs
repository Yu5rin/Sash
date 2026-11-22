using System.IO.Packaging;
using System.Text;
using Sash.Core.CustomUI;

namespace Sash.Core.Packaging;

/// <summary>
/// .xlsm / .xlam の customUI パーツを読み書きする。
/// customUI と、それが参照する画像以外のパーツ（シート、VBA プロジェクトなど）には触れない。
/// </summary>
public static class RibbonPackage
{
    private static readonly string[] SupportedExtensions = [".xlsm", ".xlam"];

    public static bool IsSupported(string path) =>
        SupportedExtensions.Contains(System.IO.Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    /// <summary>ファイルからリボン定義を読み込む。customUI がないブックでも成功し、Parts は空になる。</summary>
    public static RibbonDocument Load(string path)
    {
        var fullPath = System.IO.Path.GetFullPath(path);
        using var package = Package.Open(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return new RibbonDocument(fullPath, ReadParts(package));
    }

    /// <summary>開いているパッケージから customUI パーツを読み取る。</summary>
    internal static IReadOnlyList<CustomUIPart> ReadParts(Package package)
    {
        var result = new List<CustomUIPart>();
        foreach (var version in new[] { CustomUIVersion.Office2010, CustomUIVersion.Office2007 })
        {
            var rel = package.GetRelationshipsByType(CustomUIConstants.RelationshipTypeOf(version)).FirstOrDefault();
            if (rel is null)
            {
                continue;
            }

            var partUri = PackUriHelper.ResolvePartUri(new Uri("/", UriKind.Relative), rel.TargetUri);
            if (!package.PartExists(partUri))
            {
                continue;
            }

            var part = package.GetPart(partUri);
            result.Add(new CustomUIPart(version, partUri, ReadText(part), ReadImages(package, part)));
        }

        return result;
    }

    /// <summary>
    /// customUI の XML を書き込む。パーツとパッケージ直下のリレーションがなければ作る。
    /// 画像の書き込みはここでは行わない（第 1 弾のアイコン設定で追加する）。
    /// </summary>
    public static void SaveCustomUI(string path, CustomUIVersion version, string xml)
    {
        ArgumentNullException.ThrowIfNull(xml);
        using var package = Package.Open(System.IO.Path.GetFullPath(path), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        WriteCustomUI(package, version, xml);
    }

    internal static void WriteCustomUI(Package package, CustomUIVersion version, string xml)
    {
        var relType = CustomUIConstants.RelationshipTypeOf(version);
        var rel = package.GetRelationshipsByType(relType).FirstOrDefault();

        PackagePart part;
        if (rel is not null)
        {
            var partUri = PackUriHelper.ResolvePartUri(new Uri("/", UriKind.Relative), rel.TargetUri);
            part = package.PartExists(partUri)
                ? package.GetPart(partUri)
                : package.CreatePart(partUri, CustomUIConstants.ContentType, CompressionOption.Normal);
        }
        else
        {
            var partUri = PackUriHelper.CreatePartUri(CustomUIConstants.DefaultPartUriOf(version));
            part = package.PartExists(partUri)
                ? package.GetPart(partUri)
                : package.CreatePart(partUri, CustomUIConstants.ContentType, CompressionOption.Normal);
            package.CreateRelationship(partUri, TargetMode.Internal, relType);
        }

        using var stream = part.GetStream(FileMode.Create, FileAccess.Write);
        // Office が書き出す customUI と同じく BOM なしの UTF-8 にする
        var bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(xml);
        stream.Write(bytes);
    }

    private static string ReadText(PackagePart part)
    {
        using var stream = part.GetStream(FileMode.Open, FileAccess.Read);
        // BOM があれば自動判定し、なければ UTF-8 として読む
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private static List<RibbonImage> ReadImages(Package package, PackagePart customUIPart)
    {
        var images = new List<RibbonImage>();
        foreach (var rel in customUIPart.GetRelationshipsByType(CustomUIConstants.ImageRelationshipType))
        {
            if (rel.TargetMode != TargetMode.Internal)
            {
                continue;
            }

            var imageUri = PackUriHelper.ResolvePartUri(customUIPart.Uri, rel.TargetUri);
            if (!package.PartExists(imageUri))
            {
                continue;
            }

            var imagePart = package.GetPart(imageUri);
            using var stream = imagePart.GetStream(FileMode.Open, FileAccess.Read);
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);
            images.Add(new RibbonImage(rel.Id, imageUri, imagePart.ContentType, buffer.ToArray()));
        }

        return images;
    }
}
