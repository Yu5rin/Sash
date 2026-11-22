using System.Buffers.Binary;

namespace Sash.Core.Imaging;

/// <summary>
/// EXE / DLL のアイコンリソース（RT_GROUP_ICON と RT_ICON）から .ico ファイルを組み立てる。
/// リソースの読み出しは OS に依存するので、ここではバイト列の組み立てだけを行う。
/// </summary>
public static class IcoBuilder
{
    private const int GroupHeaderSize = 6;
    private const int GroupEntrySize = 14;
    private const int IcoEntrySize = 16;

    /// <param name="group">RT_GROUP_ICON リソースの中身（GRPICONDIR）。</param>
    /// <param name="getIcon">RT_ICON の id から画像データを返す。見つからなければ null。</param>
    /// <returns>.ico のバイト列。画像が1つも取れなければ null。</returns>
    public static byte[]? FromGroup(ReadOnlySpan<byte> group, Func<ushort, byte[]?> getIcon)
    {
        if (group.Length < GroupHeaderSize || BinaryPrimitives.ReadUInt16LittleEndian(group[2..]) != 1)
        {
            return null;
        }

        int count = BinaryPrimitives.ReadUInt16LittleEndian(group[4..]);
        var entries = new List<(byte[] Header, byte[] Data)>();
        for (var i = 0; i < count; i++)
        {
            var o = GroupHeaderSize + i * GroupEntrySize;
            if (o + GroupEntrySize > group.Length)
            {
                break;
            }

            var e = group.Slice(o, GroupEntrySize);
            var id = BinaryPrimitives.ReadUInt16LittleEndian(e[12..]);
            var data = getIcon(id);
            if (data is null || data.Length == 0)
            {
                continue;
            }

            // 幅・高さ・色数・予約・プレーン・ビット数（12 バイト）はそのまま使い、サイズは実データに合わせる
            var header = new byte[IcoEntrySize];
            e[..8].CopyTo(header);
            BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(8), data.Length);
            entries.Add((header, data));
        }

        if (entries.Count == 0)
        {
            return null;
        }

        using var ms = new MemoryStream();
        Span<byte> head = stackalloc byte[GroupHeaderSize];
        BinaryPrimitives.WriteUInt16LittleEndian(head[2..], 1);
        BinaryPrimitives.WriteUInt16LittleEndian(head[4..], (ushort)entries.Count);
        ms.Write(head);

        var offset = GroupHeaderSize + entries.Count * IcoEntrySize;
        foreach (var (header, data) in entries)
        {
            BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(12), offset);
            ms.Write(header);
            offset += data.Length;
        }

        foreach (var (_, data) in entries)
        {
            ms.Write(data);
        }

        return ms.ToArray();
    }
}
