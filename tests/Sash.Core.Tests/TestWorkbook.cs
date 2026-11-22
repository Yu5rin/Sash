using System.IO.Packaging;

namespace Sash.Core.Tests;

/// <summary>テスト用に、ブックに似た最小のパッケージを一時フォルダに作る。</summary>
internal sealed class TestWorkbook : IDisposable
{
    public const string WorkbookContent = "<workbook/>";

    private readonly string _dir;

    public TestWorkbook(string extension = ".xlsm")
    {
        _dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "sash-tests", Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(_dir);
        Path = System.IO.Path.Combine(_dir, "book" + extension);

        using var package = Package.Open(Path, FileMode.Create, FileAccess.ReadWrite);
        var uri = PackUriHelper.CreatePartUri(new Uri("/xl/workbook.xml", UriKind.Relative));
        var part = package.CreatePart(uri, "application/xml", CompressionOption.Normal);
        using (var writer = new StreamWriter(part.GetStream(FileMode.Create, FileAccess.Write)))
        {
            writer.Write(WorkbookContent);
        }

        package.CreateRelationship(uri, TargetMode.Internal,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument");
    }

    public string Path { get; }

    public string BackupRoot => _dir;

    public string ReadWorkbookPart()
    {
        using var package = Package.Open(Path, FileMode.Open, FileAccess.Read);
        var part = package.GetPart(new Uri("/xl/workbook.xml", UriKind.Relative));
        using var reader = new StreamReader(part.GetStream());
        return reader.ReadToEnd();
    }

    public void Dispose()
    {
        try
        {
            System.IO.Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
