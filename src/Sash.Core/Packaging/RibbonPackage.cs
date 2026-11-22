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
    /// </summary>
    public static void SaveCustomUI(string path, CustomUIVersion version, string xml) =>
        Save(path, [new CustomUIPartChange(version, xml, [], [])]);

    /// <summary>
    /// customUI パーツと画像をまとめて書き込む。1回の Open / Close で済ませ、途中で失敗したら何も書き込まない。
    /// </summary>
    public static void Save(string path, IReadOnlyList<CustomUIPartChange> changes)
    {
        ArgumentNullException.ThrowIfNull(changes);
        var fullPath = System.IO.Path.GetFullPath(path);

        // System.IO.Packaging は書き込み途中の失敗でファイルを壊しうるので、一時ファイルで作ってから置き換える
        var temp = fullPath + ".sash-tmp";
        File.Copy(fullPath, temp, overwrite: true);
        try
        {
            using (var package = Package.Open(temp, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                foreach (var change in changes)
                {
                    var part = WriteCustomUI(package, change.Version, change.Xml);
                    foreach (var id in change.RemoveImages)
                    {
                        RemoveImage(package, part, id);
                    }

                    foreach (var image in change.AddImages)
                    {
                        WriteImage(package, part, image);
                    }
                }
            }

            File.Copy(temp, fullPath, overwrite: true);
        }
        finally
        {
            File.Delete(temp);
        }
    }

    internal static PackagePart WriteCustomUI(Package package, CustomUIVersion version, string xml)
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
        return part;
    }

    /// <summary>画像を書き込む。同じ Id のリレーションがあれば中身を差し替え、なければ customUI/images に作る。</summary>
    private static void WriteImage(Package package, PackagePart customUIPart, NewImage image)
    {
        PackagePart imagePart;
        if (customUIPart.RelationshipExists(image.Id))
        {
            var rel = customUIPart.GetRelationship(image.Id);
            var uri = PackUriHelper.ResolvePartUri(customUIPart.Uri, rel.TargetUri);
            if (package.PartExists(uri))
            {
                package.DeletePart(uri);
            }

            imagePart = package.CreatePart(uri, image.ContentType, CompressionOption.NotCompressed);
        }
        else
        {
            var uri = UniqueImageUri(package, image.Id);
            imagePart = package.CreatePart(uri, image.ContentType, CompressionOption.NotCompressed);
            // customUI パーツからの相対パス（images/xxx.png）で登録する
            customUIPart.CreateRelationship(PackUriHelper.GetRelativeUri(customUIPart.Uri, uri), TargetMode.Internal,
                CustomUIConstants.ImageRelationshipType, image.Id);
        }

        using var stream = imagePart.GetStream(FileMode.Create, FileAccess.Write);
        stream.Write(image.Data);
    }

    private static Uri UniqueImageUri(Package package, string id)
    {
        var safe = string.Concat(id.Select(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' ? c : '_'));
        for (var n = 0; ; n++)
        {
            var name = n == 0 ? safe : $"{safe}_{n}";
            var uri = PackUriHelper.CreatePartUri(new Uri($"/customUI/images/{name}.png", UriKind.Relative));
            if (!package.PartExists(uri))
            {
                return uri;
            }
        }
    }

    /// <summary>画像を消す。ほかの customUI パーツからも参照されている画像パーツは残す。</summary>
    private static void RemoveImage(Package package, PackagePart customUIPart, string id)
    {
        if (!customUIPart.RelationshipExists(id))
        {
            return;
        }

        var rel = customUIPart.GetRelationship(id);
        var uri = PackUriHelper.ResolvePartUri(customUIPart.Uri, rel.TargetUri);
        customUIPart.DeleteRelationship(id);

        var stillUsed = package.GetParts()
            .Where(p => p.Uri != uri && !p.Uri.OriginalString.EndsWith(".rels", StringComparison.OrdinalIgnoreCase))
            .Any(p => SafeRelationships(p).Any(r => r.TargetMode == TargetMode.Internal &&
                                                   PackUriHelper.ResolvePartUri(p.Uri, r.TargetUri) == uri));
        if (!stillUsed && package.PartExists(uri))
        {
            package.DeletePart(uri);
        }
    }

    private static IEnumerable<PackageRelationship> SafeRelationships(PackagePart part)
    {
        try
        {
            return part.GetRelationships().ToList();
        }
        catch (InvalidOperationException)
        {
            return [];
        }
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
