using System.Buffers.Binary;
using Sash.Core.Imaging;

namespace Sash.Core.Tests;

public class IcoBuilderTests
{
    private static byte[] Group(params (byte Size, ushort Id)[] entries)
    {
        var g = new byte[6 + entries.Length * 14];
        BinaryPrimitives.WriteUInt16LittleEndian(g.AsSpan(2), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(g.AsSpan(4), (ushort)entries.Length);
        for (var i = 0; i < entries.Length; i++)
        {
            var o = 6 + i * 14;
            g[o] = entries[i].Size;
            g[o + 1] = entries[i].Size;
            BinaryPrimitives.WriteUInt16LittleEndian(g.AsSpan(o + 6), 32);
            BinaryPrimitives.WriteUInt16LittleEndian(g.AsSpan(o + 12), entries[i].Id);
        }

        return g;
    }

    [Fact]
    public void グループから正しいICOを組み立てる()
    {
        var icons = new Dictionary<ushort, byte[]> { [1] = [1, 1, 1], [2] = [2, 2] };

        var ico = IcoBuilder.FromGroup(Group((16, 1), (32, 2)), id => icons.GetValueOrDefault(id))!;

        Assert.Equal(2, BinaryPrimitives.ReadUInt16LittleEndian(ico.AsSpan(4)));
        Assert.Equal(16, ico[6]);
        Assert.Equal(3, BinaryPrimitives.ReadInt32LittleEndian(ico.AsSpan(6 + 8)));
        Assert.Equal(38, BinaryPrimitives.ReadInt32LittleEndian(ico.AsSpan(6 + 12)));
        Assert.Equal(41, BinaryPrimitives.ReadInt32LittleEndian(ico.AsSpan(22 + 12)));
        Assert.Equal(new byte[] { 1, 1, 1, 2, 2 }, ico[38..]);
    }

    [Fact]
    public void 画像が取れない項目は飛ばし全部なければnull()
    {
        var ico = IcoBuilder.FromGroup(Group((16, 1), (32, 9)), id => id == 1 ? [7] : null)!;
        Assert.Equal(1, BinaryPrimitives.ReadUInt16LittleEndian(ico.AsSpan(4)));
        Assert.Null(IcoBuilder.FromGroup(Group((16, 9)), _ => null));
    }
}
