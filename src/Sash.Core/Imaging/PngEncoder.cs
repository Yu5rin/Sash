using System.Buffers.Binary;
using System.IO.Compression;
using System.IO.Hashing;

namespace Sash.Core.Imaging;

/// <summary>
/// BGRA の画素から PNG を作る最小限のエンコーダー。
/// imageMso の取得結果を PNG にするために使う（System.Drawing に依存しないため、どの OS でもテストできる）。
/// </summary>
public static class PngEncoder
{
    /// <param name="bgra">上の行から順に並んだ BGRA（1 画素 4 バイト、アルファはストレート）。</param>
    public static byte[] EncodeBgra(ReadOnlySpan<byte> bgra, int width, int height)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(width, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(height, 1);
        if (bgra.Length < width * height * 4)
        {
            throw new ArgumentException("画素数が足りません。", nameof(bgra));
        }

        // 各行の先頭にフィルター種別（0 = なし）を付けた RGBA
        var raw = new byte[height * (width * 4 + 1)];
        for (var y = 0; y < height; y++)
        {
            var row = y * (width * 4 + 1);
            for (var x = 0; x < width; x++)
            {
                var s = (y * width + x) * 4;
                var d = row + 1 + x * 4;
                raw[d] = bgra[s + 2];
                raw[d + 1] = bgra[s + 1];
                raw[d + 2] = bgra[s];
                raw[d + 3] = bgra[s + 3];
            }
        }

        using var output = new MemoryStream();
        output.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

        Span<byte> ihdr = stackalloc byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr, width);
        BinaryPrimitives.WriteInt32BigEndian(ihdr[4..], height);
        ihdr[8] = 8; // ビット深度
        ihdr[9] = 6; // RGBA
        WriteChunk(output, "IHDR"u8, ihdr);

        using (var compressed = new MemoryStream())
        {
            using (var z = new ZLibStream(compressed, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                z.Write(raw);
            }

            WriteChunk(output, "IDAT"u8, compressed.ToArray());
        }

        WriteChunk(output, "IEND"u8, []);
        return output.ToArray();
    }

    private static void WriteChunk(Stream s, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> len = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, data.Length);
        s.Write(len);
        s.Write(type);
        s.Write(data);

        var crc = new Crc32();
        crc.Append(type);
        crc.Append(data);
        Span<byte> sum = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(sum, crc.GetCurrentHashAsUInt32());
        s.Write(sum);
    }
}
