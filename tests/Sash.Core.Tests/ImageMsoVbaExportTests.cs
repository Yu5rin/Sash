using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Sash.Core.Excel;

namespace Sash.Core.Tests;

public class ImageMsoVbaExportTests
{
    /// <summary>VBA が書く .bgra と同じ形（幅・高さを 4 バイトずつ、続けて BGRA）を作る。</summary>
    private static byte[] Bgra(int width, int height, params byte[] pixels)
    {
        var data = new byte[8 + pixels.Length];
        BinaryPrimitives.WriteInt32LittleEndian(data, width);
        BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(4), height);
        pixels.CopyTo(data, 8);
        return data;
    }

    /// <summary>PngEncoder が書いた PNG（フィルターなし・RGBA）の画素を RGBA で読む。</summary>
    private static (int Width, int Height, byte[] Rgba) DecodePng(byte[] png)
    {
        var idat = new MemoryStream();
        int width = 0, height = 0;
        for (var pos = 8; pos < png.Length;)
        {
            var length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(pos));
            var type = Encoding.ASCII.GetString(png, pos + 4, 4);
            if (type == "IHDR")
            {
                width = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(pos + 8));
                height = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(pos + 12));
            }
            else if (type == "IDAT")
            {
                idat.Write(png, pos + 8, length);
            }

            pos += 12 + length;
        }

        idat.Position = 0;
        using var z = new ZLibStream(idat, CompressionMode.Decompress);
        var raw = new MemoryStream();
        z.CopyTo(raw);
        var bytes = raw.ToArray();
        var rgba = new byte[width * height * 4];
        for (var y = 0; y < height; y++)
        {
            Assert.Equal(0, bytes[y * ((width * 4) + 1)]);
            Array.Copy(bytes, (y * ((width * 4) + 1)) + 1, rgba, y * width * 4, width * 4);
        }

        return (width, height, rgba);
    }

    [Fact]
    public void 正しいbgraを読む()
    {
        var image = ImageMsoVbaExport.ParseBgra(Bgra(2, 1, 1, 2, 3, 4, 5, 6, 7, 8), out var error);

        Assert.NotNull(image);
        Assert.Equal(string.Empty, error);
        Assert.Equal(2, image.Width);
        Assert.Equal(1, image.Height);
        Assert.Equal(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }, image.Bgra);
    }

    [Theory]
    [InlineData(0)] // 何も書かれていない
    [InlineData(7)] // 先頭（幅と高さ）の途中で切れている
    public void 先頭が足りなければ読まない(int length)
    {
        Assert.Null(ImageMsoVbaExport.ParseBgra(new byte[length], out var error));
        Assert.Contains("短すぎる", error, StringComparison.Ordinal);
    }

    [Fact]
    public void 画素が途中で切れていれば読まない()
    {
        // 2x2 なら 16 バイトの画素が要るのに 12 バイトしかない（VBA が書く途中で止まった）
        Assert.Null(ImageMsoVbaExport.ParseBgra(Bgra(2, 2, new byte[12]), out var error));
        Assert.Contains("長さが合わない", error, StringComparison.Ordinal);
    }

    [Fact]
    public void 画素が余っていても読まない()
    {
        Assert.Null(ImageMsoVbaExport.ParseBgra(Bgra(1, 1, new byte[8]), out var error));
        Assert.Contains("長さが合わない", error, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(0, 32)]
    [InlineData(32, 0)]
    [InlineData(-32, 32)]
    [InlineData(32, -32)]
    [InlineData(ImageMsoVbaExport.MaxSide + 1, 1)]
    [InlineData(int.MaxValue, int.MaxValue)]
    public void 大きさがおかしければ読まない(int width, int height)
    {
        Assert.Null(ImageMsoVbaExport.ParseBgra(Bgra(width, height, new byte[16]), out var error));
        Assert.Contains("大きさが不正", error, StringComparison.Ordinal);
    }

    [Fact]
    public void 乗算済みのアルファをストレートに戻してPNGにする()
    {
        // 1 画素目：半透明（A=128）の乗算済み BGRA (64, 32, 0)。2 画素目：不透明。3 画素目：透明
        var png = ImageMsoVbaExport.BgraToPng(Bgra(3, 1, 64, 32, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0), out var error);

        Assert.NotNull(png);
        Assert.Equal(string.Empty, error);
        var (w, h, rgba) = DecodePng(png);
        Assert.Equal((3, 1), (w, h));

        // ストレートに戻すと B=64*255/128=127、G=32*255/128=63（RGBA の並びで読む）
        Assert.Equal(new byte[] { 0, 63, 127, 128, 30, 20, 10, 255, 0, 0, 0, 0 }, rgba);
    }

    [Fact]
    public void アルファがすべて0なら不透明にする()
    {
        var png = ImageMsoVbaExport.BgraToPng(Bgra(2, 1, 1, 2, 3, 0, 4, 5, 6, 0), out _);

        var (_, _, rgba) = DecodePng(png!);
        Assert.Equal(new byte[] { 3, 2, 1, 255, 6, 5, 4, 255 }, rgba);
    }

    [Fact]
    public void 壊れたbgraはPNGにしない()
    {
        Assert.Null(ImageMsoVbaExport.BgraToPng(Bgra(2, 2, new byte[3]), out var error));
        Assert.NotEmpty(error);
    }

    [Fact]
    public void エラーの文面はUTF16の番号とタブと説明()
    {
        var (number, description) = ImageMsoVbaExport.ParseErrorText(Encoding.Unicode.GetBytes("-2147418113\t予期しないエラーです。"));

        Assert.Equal(unchecked((int)0x8000FFFF), number);
        Assert.Equal("予期しないエラーです。", description);

        var (none, text) = ImageMsoVbaExport.ParseErrorText(Encoding.Unicode.GetBytes("壊れた"));
        Assert.Null(none);
        Assert.Equal("壊れた", text);
    }

    [Fact]
    public void 結果のファイルを名前の順に読んで消す()
    {
        using var dir = new TempDir();
        Directory.CreateDirectory(dir.Path);
        File.WriteAllBytes(Path.Combine(dir.Path, "0.bgra"), Bgra(1, 1, 1, 2, 3, 255));
        File.WriteAllBytes(Path.Combine(dir.Path, "1.missing"), Encoding.Unicode.GetBytes("-2147024809\tThe parameter is incorrect."));
        File.WriteAllBytes(Path.Combine(dir.Path, "2.err"), Encoding.Unicode.GetBytes("-2147418113\tUnexpected"));
        File.WriteAllBytes(Path.Combine(dir.Path, "4.bgra"), Bgra(2, 2, new byte[5]));
        var notes = new List<(string Key, string Message)>();

        var results = ImageMsoVbaExport.ReadResults(dir.Path, ["FileSave", "NoSuchIcon", "Paste", "NotWritten", "Broken"], 32, (k, m) => notes.Add((k, m)));

        Assert.Equal(["FileSave", "NoSuchIcon", "Paste", "NotWritten", "Broken"], results.Select(r => r.Name));
        Assert.Equal(
            [ImageMsoFetchKind.Found, ImageMsoFetchKind.Missing, ImageMsoFetchKind.Failed, ImageMsoFetchKind.Failed, ImageMsoFetchKind.Failed],
            results.Select(r => r.Kind));
        Assert.Equal(0x89, results[0].Png![0]);
        Assert.Empty(Directory.GetFiles(dir.Path));

        // 最初の .err の中身（番号と説明）が記録に出る
        Assert.Contains(notes, n => n.Key == "vba-err:8000FFFF" && n.Message.Contains("Unexpected", StringComparison.Ordinal));
        Assert.Contains(notes, n => n.Key == "vba-none");
        Assert.Contains(notes, n => n.Key.StartsWith("vba-bgra:", StringComparison.Ordinal));

        // 要求と違う大きさ（1x1）で返ったことも記録する
        Assert.Contains(notes, n => n.Key == "vba-size:1x1");
    }

    [Fact]
    public void 名前の一覧はASCIIとCRLFで書く()
    {
        using var dir = new TempDir();
        Directory.CreateDirectory(dir.Path);
        var path = Path.Combine(dir.Path, "names.txt");

        ImageMsoVbaExport.WriteNameList(path, ["FileSave", "Paste"]);

        Assert.Equal("FileSave\r\nPaste\r\n"u8.ToArray(), File.ReadAllBytes(path));
        Assert.Throws<ArgumentException>(() => ImageMsoVbaExport.WriteNameList(path, ["保存"]));
    }

    [Theory]
    [InlineData("FileSave", true)]
    [InlineData("A1", true)]
    [InlineData("保存", false)]
    [InlineData("File Save", false)]
    [InlineData("", false)]
    [InlineData("a\\b", false)]
    public void VBAに渡せる名前はASCIIの表示できる文字だけ(string name, bool expected)
    {
        Assert.Equal(expected, ImageMsoVbaExport.CanSend(name));
    }

    [Fact]
    public void VBAのモジュールは64bitと32bitの宣言と関数を持つ()
    {
        var source = ImageMsoVbaExport.ModuleSource;
        var lines = source.Split("\r\n");

        // 行の区切りは CRLF だけ（LF だけの行があると VBE の取り込みで行がつながる）
        Assert.DoesNotContain('\n', source.Replace("\r\n", string.Empty, StringComparison.Ordinal));
        Assert.Equal("Option Explicit", lines[0]);
        Assert.Contains($"Public Function {ImageMsoVbaExport.FunctionName}(ByVal listPath As String, ByVal outDir As String, ByVal size As Long) As Long", lines);
        Assert.Contains("    Set pic = Application.CommandBars.GetImageMso(msoName, size, size)", lines);
        Assert.Contains("        If errNumber = &H80070057 Then", lines);
        Assert.Contains("    header(2) = -h", lines); // 上の行から
        Assert.Contains("    Put #f, , bits", lines);

        // #If VBA7 の側は PtrSafe と LongPtr、#Else の側（Office 2007 以前）は使わない
        var vba7 = lines.SkipWhile(l => l != "#If VBA7 Then").Skip(1).TakeWhile(l => l != "#Else").ToList();
        var legacy = lines.SkipWhile(l => l != "#If VBA7 Then").SkipWhile(l => l != "#Else").Skip(1).TakeWhile(l => l != "#End If").ToList();
        Assert.Equal(4, vba7.Count);
        Assert.All(vba7, l => Assert.StartsWith("Private Declare PtrSafe Function Sash", l, StringComparison.Ordinal));
        Assert.All(vba7, l => Assert.Contains("LongPtr", l, StringComparison.Ordinal));
        Assert.Equal(4, legacy.Count);
        Assert.All(legacy, l => Assert.DoesNotContain("PtrSafe", l, StringComparison.Ordinal));
        Assert.All(legacy, l => Assert.DoesNotContain("LongPtr", l, StringComparison.Ordinal));

        // 条件付きのコンパイルと手続きの開始・終了がそろっている
        Assert.Equal(lines.Count(l => l.Trim() == "#If VBA7 Then"), lines.Count(l => l.Trim() == "#End If"));
        Assert.Equal(lines.Count(l => l.Contains(" Function ", StringComparison.Ordinal) && !l.Contains("Declare", StringComparison.Ordinal)), lines.Count(l => l == "End Function"));
        Assert.Equal(lines.Count(l => l.StartsWith("Private Sub ", StringComparison.Ordinal)), lines.Count(l => l == "End Sub"));

        // モジュールの変数（状態）は持たない：手続きの外にあるのは Option・コメント・条件付きのコンパイル・Declare だけ
        var depth = 0;
        foreach (var line in lines)
        {
            if (line.StartsWith("Public Function ", StringComparison.Ordinal) || line.StartsWith("Private Sub ", StringComparison.Ordinal))
            {
                depth++;
                continue;
            }

            if (line is "End Function" or "End Sub")
            {
                depth--;
                continue;
            }

            if (depth == 0 && line.Length > 0)
            {
                Assert.True(
                    line == "Option Explicit" || line.StartsWith('\'') || line.StartsWith('#') || line.StartsWith("Private Declare ", StringComparison.Ordinal),
                    $"手続きの外に置けない行: {line}");
            }
        }

        Assert.Equal(0, depth);
    }
}
