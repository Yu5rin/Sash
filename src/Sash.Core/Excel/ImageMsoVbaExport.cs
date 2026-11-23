using System.Buffers.Binary;
using System.Text;
using Sash.Core.Imaging;

namespace Sash.Core.Excel;

/// <summary>.bgra のファイルを読んだ結果（上の行から並んだ BGRA。アルファは Excel が書いたまま）。</summary>
public sealed record ImageMsoBgraImage(int Width, int Height, byte[] Bgra);

/// <summary>
/// imageMso を Excel の中（同じプロセス）で取り出すための、一時的な VBA モジュールとその出力の読み方（仕様書 §17.7）。
/// <para>
/// Sash（別のプロセス）から <c>CommandBars.GetImageMso</c> を呼ぶと、実機では E_UNEXPECTED（0x8000FFFF）が返り、
/// 取れても IPictureDisp の HBITMAP は Excel のプロセスのものなので Sash からは読めない。そこで、取り込み専用の
/// 見えない Excel の作業用のブックにこのモジュールを入れ、<c>Application.Run</c> で呼んで Excel の中で取り出させ、
/// 画素を一時フォルダのファイルに書かせる。ここは Excel に依存しない部分（VBA の文面、名前の一覧の書き出し、出力の読み込み）で、
/// Linux 上でも単体テストできるよう Sash.Core に置く。
/// </para>
/// </summary>
public static class ImageMsoVbaExport
{
    /// <summary>作業用のブックに入れる標準モジュールの名前。利用者のブックには入れない。</summary>
    public const string ModuleName = "SashImageMsoExport";

    /// <summary>モジュールが公開する関数。<c>SashExportImageMso(listPath, outDir, size) As Long</c>。</summary>
    public const string FunctionName = "SashExportImageMso";

    /// <summary>VBA に E_INVALIDARG として返る Err.Number（存在しない imageMso）。</summary>
    public const int InvalidNameError = unchecked((int)0x80070057);

    /// <summary>
    /// .bgra の 1 辺の上限。GetImageMso に渡す大きさは 16〜128 だが、Excel が倍の大きさで返しても読めるよう余裕を持たせ、
    /// それを超える値は壊れたファイルとして扱う（巨大な配列を確保しないため）。
    /// </summary>
    public const int MaxSide = 512;

    /// <summary>.bgra の先頭（幅と高さ、どちらも 4 バイトのリトルエンディアン）の長さ。</summary>
    public const int HeaderLength = 8;

    /// <summary>
    /// モジュールの VBA。行の区切りは CRLF（VBE がそのまま取り込めるように）。
    /// Declare は VBA7（Office 2010 以降。64bit も 32bit も）では PtrSafe と LongPtr、それより前では Long で宣言する。
    /// 構造体（Type）は使わず Long の配列で受け渡す。64bit の VBA では Type の中の LongPtr の並び（詰め物）が
    /// C と合うかを気にしなければならないが、必要なのは幅と高さだけで、BITMAPINFOHEADER にもポインターがないため。
    /// モジュールの変数は持たない（呼び出しの間に状態を残さない）。
    /// </summary>
    public static string ModuleSource { get; } = BuildModuleSource();

    private static string BuildModuleSource()
    {
        // VBE に入る文面なので、コメントは VBA の書き方（'）で、VBA の中で読める日本語にする
        string[] lines =
        [
            "Option Explicit",
            "' Sash が Excel の組み込みアイコン（imageMso）を取り出すために一時的に入れたモジュールです。",
            "' 取り込みが終わると Sash が取り除き、作業用のブックは保存せずに閉じます。",
            "",
            "#If VBA7 Then",
            "Private Declare PtrSafe Function SashGetObject Lib \"gdi32\" Alias \"GetObjectA\" (ByVal hObject As LongPtr, ByVal nCount As Long, ByRef lpObject As Any) As Long",
            "Private Declare PtrSafe Function SashGetDC Lib \"user32\" Alias \"GetDC\" (ByVal hWnd As LongPtr) As LongPtr",
            "Private Declare PtrSafe Function SashReleaseDC Lib \"user32\" Alias \"ReleaseDC\" (ByVal hWnd As LongPtr, ByVal hDC As LongPtr) As Long",
            "Private Declare PtrSafe Function SashGetDIBits Lib \"gdi32\" Alias \"GetDIBits\" (ByVal hDC As LongPtr, ByVal hBitmap As LongPtr, ByVal nStartScan As Long, ByVal nNumScans As Long, ByRef lpBits As Any, ByRef lpBI As Any, ByVal wUsage As Long) As Long",
            "#Else",
            "Private Declare Function SashGetObject Lib \"gdi32\" Alias \"GetObjectA\" (ByVal hObject As Long, ByVal nCount As Long, ByRef lpObject As Any) As Long",
            "Private Declare Function SashGetDC Lib \"user32\" Alias \"GetDC\" (ByVal hWnd As Long) As Long",
            "Private Declare Function SashReleaseDC Lib \"user32\" Alias \"ReleaseDC\" (ByVal hWnd As Long, ByVal hDC As Long) As Long",
            "Private Declare Function SashGetDIBits Lib \"gdi32\" Alias \"GetDIBits\" (ByVal hDC As Long, ByVal hBitmap As Long, ByVal nStartScan As Long, ByVal nNumScans As Long, ByRef lpBits As Any, ByRef lpBI As Any, ByVal wUsage As Long) As Long",
            "#End If",
            "",
            "' listPath の 1 行に 1 つの名前（ASCII）。n 行目（0 から）の結果を outDir\\n.bgra / .missing / .err に書く。",
            "' 処理した行の数を返す。",
            $"Public Function {FunctionName}(ByVal listPath As String, ByVal outDir As String, ByVal size As Long) As Long",
            "    Dim f As Integer",
            "    Dim msoName As String",
            "    Dim index As Long",
            "    f = FreeFile",
            "    Open listPath For Input As #f",
            "    Do While Not EOF(f)",
            "        Line Input #f, msoName",
            "        If Len(msoName) > 0 Then",
            "            SashExportOne msoName, outDir & \"\\\" & CStr(index), size",
            "        End If",
            "        index = index + 1",
            "    Loop",
            "    Close #f",
            $"    {FunctionName} = index",
            "End Function",
            "",
            "Private Sub SashExportOne(ByVal msoName As String, ByVal basePath As String, ByVal size As Long)",
            "    Dim pic As Object",
            "    Dim errNumber As Long",
            "    Dim errText As String",
            "#If VBA7 Then",
            "    Dim hBitmap As LongPtr",
            "    Dim hDC As LongPtr",
            "#Else",
            "    Dim hBitmap As Long",
            "    Dim hDC As Long",
            "#End If",
            "    Dim info(0 To 7) As Long",
            "    Dim header(0 To 15) As Long",
            "    Dim bits() As Byte",
            "    Dim w As Long",
            "    Dim h As Long",
            "    Dim scans As Long",
            "    Dim f As Integer",
            "",
            "    On Error Resume Next",
            "    Set pic = Application.CommandBars.GetImageMso(msoName, size, size)",
            "    errNumber = Err.Number",
            "    errText = Err.Description",
            "    On Error GoTo 0",
            "    If errNumber <> 0 Then",
            "        If errNumber = &H80070057 Then",
            "            SashWriteText basePath & \".missing\", CStr(errNumber) & vbTab & errText",
            "        Else",
            "            SashWriteText basePath & \".err\", CStr(errNumber) & vbTab & errText",
            "        End If",
            "        Exit Sub",
            "    End If",
            "    If pic Is Nothing Then",
            "        SashWriteText basePath & \".err\", \"0\" & vbTab & \"GetImageMso returned Nothing\"",
            "        Exit Sub",
            "    End If",
            "",
            "    On Error GoTo Failed",
            "    hBitmap = pic.Handle",
            "    If SashGetObject(hBitmap, 32, info(0)) = 0 Then",
            "        SashWriteText basePath & \".err\", \"0\" & vbTab & \"GetObject failed\"",
            "        Exit Sub",
            "    End If",
            "    w = info(1)",
            "    h = Abs(info(2))",
            $"    If w <= 0 Or h <= 0 Or w > {MaxSide} Or h > {MaxSide} Then",
            "        SashWriteText basePath & \".err\", \"0\" & vbTab & \"Bad bitmap size \" & CStr(w) & \"x\" & CStr(h)",
            "        Exit Sub",
            "    End If",
            "",
            "    ' BITMAPINFOHEADER：40 バイト、幅、高さ（負の値で上の行から）、面 1 と 32bpp、BI_RGB",
            "    header(0) = 40",
            "    header(1) = w",
            "    header(2) = -h",
            "    header(3) = &H200001",
            "    header(4) = 0",
            "    ReDim bits(0 To w * h * 4 - 1)",
            "    hDC = SashGetDC(0)",
            "    scans = SashGetDIBits(hDC, hBitmap, 0, h, bits(0), header(0), 0)",
            "    SashReleaseDC 0, hDC",
            "    If scans <> h Then",
            "        SashWriteText basePath & \".err\", \"0\" & vbTab & \"GetDIBits returned \" & CStr(scans)",
            "        Exit Sub",
            "    End If",
            "",
            "    f = FreeFile",
            "    Open basePath & \".bgra\" For Binary Access Write As #f",
            "    Put #f, , w",
            "    Put #f, , h",
            "    Put #f, , bits",
            "    Close #f",
            "    Set pic = Nothing",
            "    Exit Sub",
            "",
            "Failed:",
            "    errNumber = Err.Number",
            "    errText = Err.Description",
            "    On Error Resume Next",
            "    If f <> 0 Then Close #f",
            "    Set pic = Nothing",
            "    SashWriteText basePath & \".err\", CStr(errNumber) & vbTab & errText",
            "End Sub",
            "",
            "' 文字列を UTF-16LE のままバイナリで書く（Print # だと ANSI になり、日本語のエラー文が化けるため）。",
            "Private Sub SashWriteText(ByVal path As String, ByVal text As String)",
            "    Dim f As Integer",
            "    Dim data() As Byte",
            "    On Error Resume Next",
            "    data = text",
            "    f = FreeFile",
            "    Open path For Binary Access Write As #f",
            "    If Len(text) > 0 Then Put #f, , data",
            "    Close #f",
            "End Sub",
        ];
        return string.Join("\r\n", lines) + "\r\n";
    }

    /// <summary>
    /// VBA に渡してよい名前か。VBA のファイルの入出力は ANSI なので、ASCII の表示できる文字だけにする
    /// （imageMso の名前は ASCII なので、それ以外の名前は Excel にも存在しない）。
    /// </summary>
    public static bool CanSend(string? name)
    {
        if (string.IsNullOrEmpty(name) || !ImageMsoCache.IsValidName(name))
        {
            return false;
        }

        foreach (var c in name)
        {
            if (c is <= ' ' or > '~')
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>名前の一覧を ASCII・CRLF で書く。名前はすべて <see cref="CanSend"/> を満たしていること。</summary>
    public static void WriteNameList(string path, IReadOnlyList<string> names)
    {
        ArgumentNullException.ThrowIfNull(names);
        var sb = new StringBuilder();
        foreach (var name in names)
        {
            if (!CanSend(name))
            {
                throw new ArgumentException($"VBA に渡せない名前です: {name}", nameof(names));
            }

            sb.Append(name).Append("\r\n");
        }

        File.WriteAllBytes(path, Encoding.ASCII.GetBytes(sb.ToString()));
    }

    /// <summary>
    /// .bgra のバイト列を読む。形は「幅（4 バイト）・高さ（4 バイト）・幅×高さ×4 バイトの BGRA（上の行から）」。
    /// 長さが合わない・大きさがおかしいなら null と理由（途中で書くのをやめたファイルを、画像として取り込まないため）。
    /// </summary>
    public static ImageMsoBgraImage? ParseBgra(ReadOnlySpan<byte> data, out string error)
    {
        if (data.Length < HeaderLength)
        {
            error = $"短すぎる（{data.Length} バイト）";
            return null;
        }

        var width = BinaryPrimitives.ReadInt32LittleEndian(data);
        var height = BinaryPrimitives.ReadInt32LittleEndian(data[4..]);
        if (width is <= 0 or > MaxSide || height is <= 0 or > MaxSide)
        {
            error = $"大きさが不正（{width}x{height}）";
            return null;
        }

        var expected = HeaderLength + (width * height * 4);
        if (data.Length != expected)
        {
            error = $"長さが合わない（{width}x{height} なら {expected} バイトのはずが {data.Length} バイト）";
            return null;
        }

        error = string.Empty;
        return new ImageMsoBgraImage(width, height, data[HeaderLength..].ToArray());
    }

    /// <summary>.bgra のバイト列を PNG にする。アルファは <see cref="BgraAlpha.Normalize"/> でストレートにそろえる。</summary>
    public static byte[]? BgraToPng(ReadOnlySpan<byte> data, out string error)
    {
        var image = ParseBgra(data, out error);
        if (image is null)
        {
            return null;
        }

        BgraAlpha.Normalize(image.Bgra);
        return PngEncoder.EncodeBgra(image.Bgra, image.Width, image.Height);
    }

    /// <summary>.err / .missing の中身（UTF-16LE の「番号 タブ 説明」）を読む。番号が読めなければ null。</summary>
    public static (int? Number, string Description) ParseErrorText(ReadOnlySpan<byte> data)
    {
        var text = Encoding.Unicode.GetString(data).TrimStart('﻿').Trim();
        var tab = text.IndexOf('\t', StringComparison.Ordinal);
        var head = tab < 0 ? text : text[..tab];
        var description = tab < 0 ? string.Empty : text[(tab + 1)..].Trim();
        return int.TryParse(head, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out var number)
            ? (number, description)
            : (null, text);
    }

    /// <summary>
    /// VBA が outDir に書いた結果を、names の順に読む（n 番目の名前は n.bgra / n.missing / n.err）。読んだファイルは消す。
    /// 名前ではなく番号をファイル名にするのは、Windows のファイル名が大文字と小文字を区別せず、
    /// 大文字と小文字だけが違う名前が同じファイルに上書きされるのを避けるため。
    /// </summary>
    /// <param name="outDir">VBA に渡した出力先。</param>
    /// <param name="names">VBA に渡した名前（一覧のファイルと同じ順）。</param>
    /// <param name="size">要求した大きさ（違う大きさで返ったときに記録するため）。</param>
    /// <param name="note">診断の記録（key, 文面）。同じ key は呼ぶ側で 1 回だけ書く。</param>
    public static List<ImageMsoFetchResult> ReadResults(string outDir, IReadOnlyList<string> names, int size, Action<string, string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(names);
        var results = new List<ImageMsoFetchResult>(names.Count);
        for (var i = 0; i < names.Count; i++)
        {
            results.Add(ReadOne(Path.Combine(outDir, i.ToString(System.Globalization.CultureInfo.InvariantCulture)), names[i], size, note));
        }

        return results;
    }

    private static ImageMsoFetchResult ReadOne(string basePath, string name, int size, Action<string, string>? note)
    {
        var bgraPath = basePath + ".bgra";
        var missingPath = basePath + ".missing";
        var errPath = basePath + ".err";
        try
        {
            if (File.Exists(bgraPath))
            {
                var data = File.ReadAllBytes(bgraPath);
                var png = BgraToPng(data, out var error);
                if (png is null)
                {
                    note?.Invoke($"vba-bgra:{error}", $"imageMso: VBA が書いた画素を読めなかった（{name}）: {error}");
                    return new ImageMsoFetchResult(name, ImageMsoFetchKind.Failed);
                }

                var w = BinaryPrimitives.ReadInt32LittleEndian(data);
                var h = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(4));
                note?.Invoke("vba-found", $"imageMso: Excel の中（VBA）で取り出せた（{name}、{w}x{h}）");
                if (w != size || h != size)
                {
                    note?.Invoke($"vba-size:{w}x{h}", $"imageMso: 要求した {size}px と違う大きさで返った（{name}、{w}x{h}）。そのまま使う");
                }

                return new ImageMsoFetchResult(name, ImageMsoFetchKind.Found, png);
            }

            if (File.Exists(missingPath))
            {
                var (number, description) = ParseErrorText(File.ReadAllBytes(missingPath));
                note?.Invoke("vba-missing", $"imageMso: 存在しない名前として扱った（{name}）: Err.Number={number?.ToString("X8", System.Globalization.CultureInfo.InvariantCulture) ?? "?"} {description}");
                return new ImageMsoFetchResult(name, ImageMsoFetchKind.Missing);
            }

            if (File.Exists(errPath))
            {
                var (number, description) = ParseErrorText(File.ReadAllBytes(errPath));
                var code = number?.ToString("X8", System.Globalization.CultureInfo.InvariantCulture) ?? "?";
                note?.Invoke($"vba-err:{code}", $"imageMso: Excel の中（VBA）で取り出せなかった（{name}）: Err.Number=0x{code} {description}");
                return new ImageMsoFetchResult(name, ImageMsoFetchKind.Failed);
            }

            note?.Invoke("vba-none", $"imageMso: VBA が結果のファイルを書かなかった（{name}）");
            return new ImageMsoFetchResult(name, ImageMsoFetchKind.Failed);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            note?.Invoke($"vba-io:{ex.GetType().Name}", $"imageMso: 結果のファイルを読めなかった（{name}）: {ex.GetType().Name} {ex.Message}");
            return new ImageMsoFetchResult(name, ImageMsoFetchKind.Failed);
        }
        finally
        {
            foreach (var p in new[] { bgraPath, missingPath, errPath })
            {
                TryDelete(p);
            }
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 一時フォルダは最後にまとめて消すので、ここで消せなくてもよい
        }
    }
}
