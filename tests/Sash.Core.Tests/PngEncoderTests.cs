using Sash.Core.Imaging;

namespace Sash.Core.Tests;

public class PngEncoderTests
{
    [Fact]
    public void 正しいPNGの先頭とチャンクを書き出す()
    {
        byte[] bgra = [0, 0, 255, 255, 255, 0, 0, 128];

        var png = PngEncoder.EncodeBgra(bgra, 2, 1);

        Assert.Equal(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, png[..8]);
        Assert.Equal("IHDR"u8.ToArray(), png[12..16]);
        Assert.Equal(2, (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19]);
        Assert.Equal(6, png[25]);
        Assert.Equal("IEND"u8.ToArray(), png[^8..^4]);
    }

    [Fact]
    public void 画素が足りなければ例外()
    {
        Assert.Throws<ArgumentException>(() => PngEncoder.EncodeBgra(new byte[4], 2, 2));
    }
}
