using System.Buffers.Binary;

namespace Sash.Core.Imaging;

/// <summary>BMP を読み解いた結果。画素は上の行から並んだ BGRA（アルファは BMP に入っていたまま。なければ 0）。</summary>
public sealed record BmpImage(int Width, int Height, int BitCount, int Compression, bool TopDown, byte[] Bgra)
{
    /// <summary>ログに残す短い説明（例：32bpp BI_RGB 32x32 bottom-up）。</summary>
    public string Describe() =>
        $"{BitCount}bpp {CompressionName(Compression)} {Width}x{Height} {(TopDown ? "top-down" : "bottom-up")}";

    private static string CompressionName(int c) => c switch
    {
        BmpDecoder.BiRgb => "BI_RGB",
        BmpDecoder.BiBitfields => "BI_BITFIELDS",
        BmpDecoder.BiAlphaBitfields => "BI_ALPHABITFIELDS",
        _ => $"compression={c}",
    };
}

/// <summary>
/// BMP（BITMAPFILEHEADER + DIB）を BGRA にする最小限のデコーダー。
/// Excel の GetImageMso が返す画像は、Excel が別のプロセスで動いていると HBITMAP を直接読めない（GDI のハンドルは
/// プロセスごとのもの）。そのときは IPicture.SaveAsFile や IPersistStream.Save で BMP のバイト列として受け取るので、
/// それを読むために使う。System.Drawing に頼らないのは、どの OS でもテストできるようにするため。
/// </summary>
public static class BmpDecoder
{
    public const int BiRgb = 0;
    public const int BiBitfields = 3;
    public const int BiAlphaBitfields = 6;

    /// <summary>imageMso は大きくても 128px。壊れたヘッダーで巨大な配列を確保しないよう、上限を設ける。</summary>
    private const int MaxDimension = 4096;

    private const int FileHeaderSize = 14;

    /// <summary>BMP を読む。読めない形式・壊れたデータは <see cref="FormatException"/>。</summary>
    public static BmpImage Decode(ReadOnlySpan<byte> data)
    {
        try
        {
            return DecodeCore(data);
        }
        catch (Exception ex) when (ex is ArgumentException or IndexOutOfRangeException or OverflowException)
        {
            // 長さの確認は DecodeCore で済ませているが、見落としがあっても呼び出し側には FormatException だけを返す
            // （取り込みでは 1 件の壊れた画像で、まとまり全体を失敗させないため）
            throw new FormatException($"BMP を読めませんでした（{ex.GetType().Name}）。", ex);
        }
    }

    private static BmpImage DecodeCore(ReadOnlySpan<byte> data)
    {
        // OLE のピクチャを IPersistStream.Save で書くと、先頭に "lt\0\0" とデータの長さ（4 バイト）が付く
        if (data.Length >= 8 && data[0] == (byte)'l' && data[1] == (byte)'t' && data[2] == 0 && data[3] == 0)
        {
            data = data[8..];
        }

        int dibStart;
        int? pixelOffset = null;
        if (data.Length >= 2 && data[0] == (byte)'B' && data[1] == (byte)'M')
        {
            Require(data, FileHeaderSize);
            dibStart = FileHeaderSize;
            var off = BinaryPrimitives.ReadInt32LittleEndian(data[10..]);
            if (off > 0)
            {
                pixelOffset = off;
            }
        }
        else
        {
            // ファイルヘッダーのない DIB（CF_DIB と同じ形）も受け付ける
            dibStart = 0;
        }

        Require(data, (long)dibStart + 4);
        var headerSize = BinaryPrimitives.ReadInt32LittleEndian(data[dibStart..]);
        if (headerSize != 12 && headerSize < 40)
        {
            throw new FormatException($"BMP のヘッダーの大きさが不正です（{headerSize}）。");
        }

        Require(data, (long)dibStart + headerSize);
        var h = data[dibStart..];
        int width, height, bitCount, compression = BiRgb, clrUsed = 0;
        if (headerSize == 12)
        {
            // BITMAPCOREHEADER（OS/2 形式）
            width = BinaryPrimitives.ReadUInt16LittleEndian(h[4..]);
            height = BinaryPrimitives.ReadInt16LittleEndian(h[6..]);
            bitCount = BinaryPrimitives.ReadUInt16LittleEndian(h[10..]);
        }
        else
        {
            width = BinaryPrimitives.ReadInt32LittleEndian(h[4..]);
            height = BinaryPrimitives.ReadInt32LittleEndian(h[8..]);
            bitCount = BinaryPrimitives.ReadUInt16LittleEndian(h[14..]);
            compression = BinaryPrimitives.ReadInt32LittleEndian(h[16..]);
            clrUsed = BinaryPrimitives.ReadInt32LittleEndian(h[32..]);
        }

        var topDown = height < 0;
        if (height == int.MinValue)
        {
            throw new FormatException("BMP の高さが不正です。");
        }

        height = Math.Abs(height);
        if (width < 1 || height < 1 || width > MaxDimension || height > MaxDimension)
        {
            throw new FormatException($"BMP の大きさが不正です（{width}x{height}）。");
        }

        if (compression is not (BiRgb or BiBitfields or BiAlphaBitfields))
        {
            throw new FormatException($"圧縮された BMP には対応していません（compression={compression}）。");
        }

        if (bitCount is not (1 or 4 or 8 or 16 or 24 or 32))
        {
            throw new FormatException($"対応していない色数です（{bitCount}bpp）。");
        }

        // 色のマスク。V4 / V5 ヘッダーはヘッダーの中に、BITMAPINFOHEADER はヘッダーの直後に置かれる
        var afterHeader = dibStart + headerSize;
        uint rMask = 0, gMask = 0, bMask = 0, aMask = 0;
        if (compression is BiBitfields or BiAlphaBitfields)
        {
            if (bitCount is not (16 or 32))
            {
                throw new FormatException($"BI_BITFIELDS は 16bpp か 32bpp だけです（{bitCount}bpp）。");
            }

            if (headerSize >= 52)
            {
                rMask = BinaryPrimitives.ReadUInt32LittleEndian(h[40..]);
                gMask = BinaryPrimitives.ReadUInt32LittleEndian(h[44..]);
                bMask = BinaryPrimitives.ReadUInt32LittleEndian(h[48..]);
                aMask = headerSize >= 56 ? BinaryPrimitives.ReadUInt32LittleEndian(h[52..]) : 0;
            }
            else
            {
                var maskCount = compression == BiAlphaBitfields ? 4 : 3;
                Require(data, (long)afterHeader + maskCount * 4);
                rMask = BinaryPrimitives.ReadUInt32LittleEndian(data[afterHeader..]);
                gMask = BinaryPrimitives.ReadUInt32LittleEndian(data[(afterHeader + 4)..]);
                bMask = BinaryPrimitives.ReadUInt32LittleEndian(data[(afterHeader + 8)..]);
                aMask = maskCount == 4 ? BinaryPrimitives.ReadUInt32LittleEndian(data[(afterHeader + 12)..]) : 0;
                afterHeader += maskCount * 4;
            }
        }
        else if (bitCount == 16)
        {
            // 16bpp の BI_RGB は 5-5-5
            rMask = 0x7C00;
            gMask = 0x03E0;
            bMask = 0x001F;
        }

        // パレット（8bpp 以下）
        byte[]? palette = null;
        var entrySize = headerSize == 12 ? 3 : 4;
        if (bitCount <= 8)
        {
            var count = clrUsed is > 0 and <= 256 ? clrUsed : 1 << bitCount;
            Require(data, (long)afterHeader + (long)count * entrySize);
            palette = new byte[256 * 4];
            for (var i = 0; i < count; i++)
            {
                var p = afterHeader + i * entrySize;
                palette[i * 4] = data[p];
                palette[i * 4 + 1] = data[p + 1];
                palette[i * 4 + 2] = data[p + 2];
            }

            afterHeader += count * entrySize;
        }

        var start = pixelOffset ?? afterHeader;
        var stride = (int)(((long)width * bitCount + 31) / 32 * 4);
        if (start < 0 || (long)start + (long)stride * height > data.Length)
        {
            throw new FormatException("BMP の画素のデータが足りません。");
        }

        var bgra = new byte[width * height * 4];
        for (var y = 0; y < height; y++)
        {
            // ふつうの BMP は下の行から並ぶ。高さが負なら上の行から
            var srcRow = data.Slice(start + (topDown ? y : height - 1 - y) * stride, stride);
            var dst = bgra.AsSpan(y * width * 4, width * 4);
            switch (bitCount)
            {
                case 32 when compression == BiRgb:
                    srcRow[..(width * 4)].CopyTo(dst);
                    break;
                case 32:
                    for (var x = 0; x < width; x++)
                    {
                        WriteMasked(dst[(x * 4)..], BinaryPrimitives.ReadUInt32LittleEndian(srcRow[(x * 4)..]), rMask, gMask, bMask, aMask);
                    }

                    break;
                case 24:
                    for (var x = 0; x < width; x++)
                    {
                        dst[x * 4] = srcRow[x * 3];
                        dst[x * 4 + 1] = srcRow[x * 3 + 1];
                        dst[x * 4 + 2] = srcRow[x * 3 + 2];
                    }

                    break;
                case 16:
                    for (var x = 0; x < width; x++)
                    {
                        WriteMasked(dst[(x * 4)..], BinaryPrimitives.ReadUInt16LittleEndian(srcRow[(x * 2)..]), rMask, gMask, bMask, aMask);
                    }

                    break;
                default:
                    for (var x = 0; x < width; x++)
                    {
                        var bit = x * bitCount;
                        var b = srcRow[bit / 8];
                        var shift = 8 - bitCount - bit % 8;
                        var index = (b >> shift) & ((1 << bitCount) - 1);
                        dst[x * 4] = palette![index * 4];
                        dst[x * 4 + 1] = palette[index * 4 + 1];
                        dst[x * 4 + 2] = palette[index * 4 + 2];
                    }

                    break;
            }
        }

        return new BmpImage(width, height, bitCount, compression, topDown, bgra);
    }

    /// <summary>BMP を PNG にする。アルファの扱いは <see cref="BgraAlpha.Normalize"/> と同じ。</summary>
    public static byte[] ToPng(ReadOnlySpan<byte> data, out BmpImage image)
    {
        image = Decode(data);
        BgraAlpha.Normalize(image.Bgra);
        return PngEncoder.EncodeBgra(image.Bgra, image.Width, image.Height);
    }

    /// <summary>
    /// 長さが足りるか確かめる。long で受けるのは、壊れたヘッダー（大きさが 0x7FFFFFFF 近く）を足したときに
    /// int があふれて負になり、確認をすり抜けて範囲外を読みにいかないようにするため。
    /// </summary>
    private static void Require(ReadOnlySpan<byte> data, long length)
    {
        if (data.Length < length)
        {
            throw new FormatException("BMP のデータが途中で切れています。");
        }
    }

    private static void WriteMasked(Span<byte> dst, uint value, uint r, uint g, uint b, uint a)
    {
        dst[0] = Channel(value, b);
        dst[1] = Channel(value, g);
        dst[2] = Channel(value, r);
        dst[3] = Channel(value, a);
    }

    /// <summary>マスクで取り出した値を 0〜255 に広げる（5 ビットの 31 → 255 のように）。</summary>
    private static byte Channel(uint value, uint mask)
    {
        if (mask == 0)
        {
            return 0;
        }

        var shift = System.Numerics.BitOperations.TrailingZeroCount(mask);
        var max = mask >> shift;
        var v = (value & mask) >> shift;

        // マスクが 32 ビットいっぱいなど壊れていても、掛け算があふれないよう 64 ビットで計算する
        return max == 255 ? (byte)v : (byte)(((ulong)v * 255 + max / 2) / max);
    }
}
