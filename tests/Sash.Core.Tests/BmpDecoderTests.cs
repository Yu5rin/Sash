using System.Buffers.Binary;
using Sash.Core.Imaging;

namespace Sash.Core.Tests;

public class BmpDecoderTests
{
    /// <summary>
    /// テスト用の BMP を組み立てる。pixel は (x, y)（上の行が y = 0）の画素を、その色数の並びのバイトで返す。
    /// </summary>
    internal static byte[] Bmp(int w, int h, int bpp, Func<int, int, byte[]> pixel, bool topDown = false, int compression = 0,
        uint[]? masks = null, byte[]? palette = null, bool fileHeader = true)
    {
        var stride = (w * bpp + 31) / 32 * 4;
        var pixels = new byte[stride * h];
        for (var y = 0; y < h; y++)
        {
            var row = (topDown ? y : h - 1 - y) * stride;
            if (bpp >= 8)
            {
                for (var x = 0; x < w; x++)
                {
                    pixel(x, y).CopyTo(pixels, row + x * bpp / 8);
                }
            }
            else
            {
                for (var x = 0; x < w; x++)
                {
                    var bit = x * bpp;
                    pixels[row + bit / 8] |= (byte)(pixel(x, y)[0] << (8 - bpp - bit % 8));
                }
            }
        }

        var extra = (masks?.Length ?? 0) * 4 + (palette?.Length ?? 0);
        var dib = new byte[40 + extra];
        BinaryPrimitives.WriteInt32LittleEndian(dib, 40);
        BinaryPrimitives.WriteInt32LittleEndian(dib.AsSpan(4), w);
        BinaryPrimitives.WriteInt32LittleEndian(dib.AsSpan(8), topDown ? -h : h);
        BinaryPrimitives.WriteUInt16LittleEndian(dib.AsSpan(12), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(dib.AsSpan(14), (ushort)bpp);
        BinaryPrimitives.WriteInt32LittleEndian(dib.AsSpan(16), compression);
        BinaryPrimitives.WriteInt32LittleEndian(dib.AsSpan(20), pixels.Length);
        BinaryPrimitives.WriteInt32LittleEndian(dib.AsSpan(32), palette is null ? 0 : palette.Length / 4);
        var p = 40;
        foreach (var m in masks ?? [])
        {
            BinaryPrimitives.WriteUInt32LittleEndian(dib.AsSpan(p), m);
            p += 4;
        }

        palette?.CopyTo(dib, p);
        if (!fileHeader)
        {
            return [.. dib, .. pixels];
        }

        var file = new byte[14];
        file[0] = (byte)'B';
        file[1] = (byte)'M';
        BinaryPrimitives.WriteInt32LittleEndian(file.AsSpan(2), 14 + dib.Length + pixels.Length);
        BinaryPrimitives.WriteInt32LittleEndian(file.AsSpan(10), 14 + dib.Length);
        return [.. file, .. dib, .. pixels];
    }

    [Fact]
    public void 下から並んだ24bppを上から並んだBGRAにする_行の詰め物を飛ばす()
    {
        // 幅 3 の 24bpp は 1 行 9 バイトで、4 の倍数にするため 3 バイトの詰め物が付く
        var bmp = Bmp(3, 2, 24, (x, y) => [(byte)(x * 10), (byte)(y * 10), 200]);

        var image = BmpDecoder.Decode(bmp);

        Assert.Equal((3, 2, 24, false), (image.Width, image.Height, image.BitCount, image.TopDown));
        Assert.Equal(new byte[] { 0, 0, 200, 0, 10, 0, 200, 0, 20, 0, 200, 0 }, image.Bgra[..12]);
        Assert.Equal(new byte[] { 0, 10, 200, 0, 10, 10, 200, 0, 20, 10, 200, 0 }, image.Bgra[12..]);
    }

    [Fact]
    public void 上から並んだ32bppのアルファを保つ()
    {
        var bmp = Bmp(2, 2, 32, (x, y) => [1, 2, 3, (byte)(x == 0 && y == 0 ? 255 : 0)], topDown: true);

        var image = BmpDecoder.Decode(bmp);

        Assert.True(image.TopDown);
        Assert.Equal(new byte[] { 1, 2, 3, 255, 1, 2, 3, 0 }, image.Bgra[..8]);
    }

    [Fact]
    public void 下から並んだ32bppは行を入れ替える()
    {
        var bmp = Bmp(1, 3, 32, (_, y) => [(byte)y, 0, 0, 255]);

        var image = BmpDecoder.Decode(bmp);

        Assert.Equal(new byte[] { 0, 1, 2 }, new[] { image.Bgra[0], image.Bgra[4], image.Bgra[8] });
    }

    [Fact]
    public void BI_BITFIELDSのマスクで色とアルファを取り出す()
    {
        // ARGB の順のマスク（BI_ALPHABITFIELDS）。画素は 0xAARRGGBB の little endian
        uint[] masks = [0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000];
        var bmp = Bmp(1, 1, 32, (_, _) => [0x30, 0x20, 0x10, 0x80], compression: BmpDecoder.BiAlphaBitfields, masks: masks);

        var image = BmpDecoder.Decode(bmp);

        Assert.Equal(new byte[] { 0x30, 0x20, 0x10, 0x80 }, image.Bgra);
    }

    [Fact]
    public void BI_BITFIELDSでアルファのマスクがなければアルファは0()
    {
        uint[] masks = [0x00FF0000, 0x0000FF00, 0x000000FF];
        var bmp = Bmp(1, 1, 32, (_, _) => [0x30, 0x20, 0x10, 0x99], compression: BmpDecoder.BiBitfields, masks: masks);

        var image = BmpDecoder.Decode(bmp);

        Assert.Equal(new byte[] { 0x30, 0x20, 0x10, 0 }, image.Bgra);
    }

    [Fact]
    public void パレットの8bppと4bppと1bppを読む()
    {
        byte[] palette = [10, 20, 30, 0, 40, 50, 60, 0];
        foreach (var bpp in new[] { 1, 4, 8 })
        {
            var bmp = Bmp(3, 1, bpp, (x, _) => [(byte)(x % 2)], palette: palette);

            var image = BmpDecoder.Decode(bmp);

            Assert.Equal(new byte[] { 10, 20, 30, 0, 40, 50, 60, 0, 10, 20, 30, 0 }, image.Bgra);
        }
    }

    [Fact]
    public void ファイルヘッダーのないDIBとIPersistStreamの前置きを受け付ける()
    {
        var dib = Bmp(1, 1, 24, (_, _) => [1, 2, 3], fileHeader: false);
        Assert.Equal(new byte[] { 1, 2, 3, 0 }, BmpDecoder.Decode(dib).Bgra);

        var bmp = Bmp(1, 1, 24, (_, _) => [4, 5, 6]);
        byte[] persisted = [(byte)'l', (byte)'t', 0, 0, .. BitConverter.GetBytes(bmp.Length), .. bmp];
        Assert.Equal(new byte[] { 4, 5, 6, 0 }, BmpDecoder.Decode(persisted).Bgra);
    }

    [Fact]
    public void 壊れたデータはFormatException()
    {
        var bmp = Bmp(4, 4, 32, (_, _) => [1, 2, 3, 4]);

        Assert.Throws<FormatException>(() => BmpDecoder.Decode(bmp.AsSpan(0, bmp.Length - 1)));
        Assert.Throws<FormatException>(() => BmpDecoder.Decode([(byte)'B', (byte)'M', 0]));
        Assert.Throws<FormatException>(() => BmpDecoder.Decode([]));

        var rle = Bmp(1, 1, 8, (_, _) => [0], compression: 1, palette: [0, 0, 0, 0]);
        Assert.Throws<FormatException>(() => BmpDecoder.Decode(rle));

        var huge = Bmp(1, 1, 24, (_, _) => [0, 0, 0]);
        BinaryPrimitives.WriteInt32LittleEndian(huge.AsSpan(14 + 4), 100_000);
        Assert.Throws<FormatException>(() => BmpDecoder.Decode(huge));
    }

    [Fact]
    public void ToPngはアルファをそろえてPNGにする()
    {
        var bmp = Bmp(2, 1, 32, (x, _) => x == 0 ? [0, 0, 0, 0] : [64, 64, 64, 128]);

        var png = BmpDecoder.ToPng(bmp, out var image);

        Assert.Equal(0x89, png[0]);
        Assert.Equal("32bpp BI_RGB 2x1 bottom-up", image.Describe());

        // 乗算済み（64, α128）はストレート（127）に戻る
        Assert.Equal(new byte[] { 0, 0, 0, 0, 127, 127, 127, 128 }, image.Bgra);
    }
}

public class BgraAlphaTests
{
    [Fact]
    public void アルファがすべて0なら不透明にする()
    {
        byte[] bgra = [10, 20, 30, 0, 40, 50, 60, 0];

        BgraAlpha.Normalize(bgra);

        Assert.Equal(new byte[] { 10, 20, 30, 255, 40, 50, 60, 255 }, bgra);
    }

    [Fact]
    public void 乗算済みアルファをストレートに戻す()
    {
        byte[] bgra = [50, 100, 200, 200, 255, 255, 255, 255, 0, 0, 0, 0];

        BgraAlpha.Normalize(bgra);

        Assert.Equal(new byte[] { 63, 127, 255, 200, 255, 255, 255, 255, 0, 0, 0, 0 }, bgra);
    }
}
