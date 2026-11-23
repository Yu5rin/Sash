using System.IO.Packaging;
using System.Text;
using System.Text.RegularExpressions;
using Sash.Core.CustomUI;
using static Sash.Core.Localization.Text;

namespace Sash.Core.Packaging;

/// <summary>
/// .xlsm / .xlam / .xltm / .xlsb の customUI パーツを読み書きする（どれも OPC 形式で、customUI は同じ場所に入る）。
/// customUI と、それが参照する画像以外のパーツ（シート、VBA プロジェクトなど）には触れない。
/// </summary>
public static partial class RibbonPackage
{
    private static readonly string[] SupportedExtensions = [".xlsm", ".xlam", ".xltm", ".xlsb"];

    public static bool IsSupported(string path) =>
        SupportedExtensions.Contains(System.IO.Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    /// <summary>ファイルからリボン定義を読み込む。customUI がないブックでも成功し、Parts は空になる。</summary>
    public static RibbonDocument Load(string path)
    {
        var fullPath = System.IO.Path.GetFullPath(path);
        ThrowIfCompoundFile(fullPath);
        using var package = Package.Open(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return new RibbonDocument(fullPath, ReadParts(package));
    }

    /// <summary>OLE 複合ファイル（D0 CF 11 E0 A1 B1 1A E1）の先頭 8 バイト。</summary>
    private static readonly byte[] CompoundFileSignature = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

    /// <summary>
    /// パスワードで暗号化したブックは、拡張子が .xlsm でも中身は zip ではなく OLE 複合ファイルになる。
    /// そのまま Package.Open に渡すと「ファイルが壊れている」としか出ないので、先に見分けて理由を伝える。
    /// </summary>
    internal static void ThrowIfCompoundFile(string fullPath)
    {
        var head = new byte[CompoundFileSignature.Length];
        int read;
        using (var fs = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            read = fs.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
        }

        if (read == head.Length && head.AsSpan().SequenceEqual(CompoundFileSignature))
        {
            throw new UserFacingException(L(
                "このブックはパスワードで保護（暗号化）されているか、古い形式のファイルのため開けません。Excelで「ファイルを開くためのパスワード」を外してから開いてください。",
                "This workbook is password-protected (encrypted) or in an old file format, so it cannot be opened. Remove the password to open the file in Excel, then try again."));
        }
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
        var info = new FileInfo(fullPath);
        if (!info.Exists)
        {
            throw new FileNotFoundException(L($"ファイルが見つかりません：{fullPath}", $"File not found: {fullPath}"), fullPath);
        }

        // 読み取り専用のファイルは、一時ファイルの作成までは進めても最後の置き換えで失敗するので、先にわかる言葉で断る
        if (info.IsReadOnly)
        {
            throw new UserFacingException(L($"読み取り専用のファイルのため保存できません。ファイルのプロパティで「読み取り専用」を外してください：{fullPath}", $"The file is read-only and cannot be saved. Clear the Read-only attribute in the file properties: {fullPath}"));
        }

        ThrowIfCompoundFile(fullPath);

        // System.IO.Packaging は書き込み途中の失敗でファイルを壊しうるので、同じフォルダの一時ファイルで作ってから置き換える。
        // 名前に Guid を入れるのは、同時に 2 つ保存したときや、前回の残りがあるときに取り合わないようにするため
        var temp = fullPath + "." + Guid.NewGuid().ToString("N") + ".sash-tmp";
        File.Copy(fullPath, temp, overwrite: true);
        try
        {
            // 元の属性（隠しファイルなど）は写るが、読み取り専用が付いていると開けないので外す
            File.SetAttributes(temp, File.GetAttributes(temp) & ~FileAttributes.ReadOnly);
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

            ReplaceFile(temp, fullPath);
        }
        finally
        {
            // 片付けの失敗で、本当の失敗の理由（例外）が隠れないようにする
            try
            {
                if (File.Exists(temp))
                {
                    File.Delete(temp);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    /// <summary>
    /// 一時ファイルで本体を置き換える。File.Replace（ReplaceFile）は名前の付け替えで行うので、途中で止まっても
    /// 「半分だけ書かれたブック」が残らず、元のファイルの属性やアクセス権も引き継がれる。
    /// File.Copy での上書きは、置き換えに対応していないファイルシステムのときだけの代わりの手段。
    /// Windows では、NAS・Samba・WebDAV など ReplaceFile に対応していない場所だと PlatformNotSupportedException ではなく
    /// IOException になるので、それも代わりの手段に回す。ただし共有違反・ロック違反（Excel が開いているなど）は
    /// 上書きしても同じく失敗するうえ、呼び出し側が少し待ってやり直す（RetryOnLock）ので、そのまま投げる。
    /// 一時ファイルは呼び出し側の finally で消す（代わりの手段で写したあとも残るため）。
    /// </summary>
    internal static void ReplaceFile(string temp, string fullPath, Action<string, string>? replace = null)
    {
        try
        {
            (replace ?? ReplaceByRename)(temp, fullPath);
        }
        catch (PlatformNotSupportedException)
        {
            File.Copy(temp, fullPath, overwrite: true);
        }
        catch (IOException ex) when (ShouldFallBackToCopy(ex))
        {
            File.Copy(temp, fullPath, overwrite: true);
        }
    }

    private static void ReplaceByRename(string temp, string fullPath) =>
        File.Replace(temp, fullPath, destinationBackupFileName: null, ignoreMetadataErrors: true);

    /// <summary>
    /// File.Replace の IOException のうち、File.Copy での上書きに切り替えてよいものか。
    /// 共有違反（ERROR_SHARING_VIOLATION = 32）・ロック違反（ERROR_LOCK_VIOLATION = 33）は、ほかのプログラムが
    /// 開いているためなので切り替えない。ファイルやフォルダがない場合も、上書きでは直らないので切り替えない。
    /// </summary>
    internal static bool ShouldFallBackToCopy(IOException ex) =>
        ex is not FileNotFoundException and not DirectoryNotFoundException
        && ex.HResult is not unchecked((int)0x80070020) and not unchecked((int)0x80070021);

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
        var bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(ToUtf8Declaration(xml));
        stream.Write(bytes);
        return part;
    }

    /// <summary>
    /// 中身は BOM なしの UTF-8 で書くので、XML 宣言が別の文字コード（encoding="utf-16" など）を名乗っていたら
    /// UTF-8 に書き換える。そのままだと Excel が UTF-16 として読もうとしてリボンが出なくなる。
    /// 先頭の BOM 文字（U+FEFF）も、書き出すと BOM になってしまうので落とす。
    /// </summary>
    internal static string ToUtf8Declaration(string xml)
    {
        var s = xml.TrimStart('\uFEFF');
        var m = XmlDeclaration().Match(s);
        if (!m.Success)
        {
            return s;
        }

        var enc = m.Groups["enc"];
        if (!enc.Success || string.Equals(enc.Value, "utf-8", StringComparison.OrdinalIgnoreCase))
        {
            return s;
        }

        return s[..enc.Index] + "UTF-8" + s[(enc.Index + enc.Length)..];
    }

    [GeneratedRegex(@"^\s*<\?xml\b[^>]*?\bencoding\s*=\s*(?<q>[""'])(?<enc>[^""']*)\k<q>[^>]*\?>")]
    private static partial Regex XmlDeclaration();

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
