using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Sash.Core.Imaging;
using static Sash.Core.Localization.Text;

namespace Sash.App;

/// <summary>EXE / DLL に埋め込まれたアイコンを .ico として取り出す（仕様書 §6.1）。</summary>
[SupportedOSPlatform("windows")]
internal static partial class IconExtractor
{
    private const uint LoadLibraryAsDatafile = 0x00000002;
    private const uint LoadLibraryAsImageResource = 0x00000020;
    private static readonly IntPtr RtIcon = 3;
    private static readonly IntPtr RtGroupIcon = 14;

    /// <summary>取り出す数の上限（shell32.dll のように大量に持つファイルへの備え）。</summary>
    private const int MaxIcons = 300;

    public static List<(string Name, byte[] Ico)> Extract(string path)
    {
        var module = LoadLibraryEx(path, IntPtr.Zero, LoadLibraryAsDatafile | LoadLibraryAsImageResource);
        if (module == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), L("アイコンを読み出せないファイルです。", "Icons cannot be read from this file."));
        }

        try
        {
            // 文字列の名前を指すポインターは、コールバックの中でしか有効でない（EnumResourceNames が使い終わると解放する）。
            // そのため、コールバックの中で文字列を写し取っておき、後で FindResource には文字列として渡す
            var names = new List<(IntPtr Id, string? Name)>();
            EnumResourceNames(module, RtGroupIcon, (_, _, name, _) =>
            {
                names.Add(IsIntResource(name) ? (name, null) : (IntPtr.Zero, Marshal.PtrToStringUni(name)));
                return names.Count < MaxIcons;
            }, IntPtr.Zero);

            var result = new List<(string, byte[])>();
            foreach (var (id, name) in names)
            {
                if (id == IntPtr.Zero && name is null)
                {
                    continue;
                }

                var group = name is null ? ReadResource(module, id, RtGroupIcon) : ReadResource(module, name, RtGroupIcon);
                if (group is null)
                {
                    continue;
                }

                var ico = IcoBuilder.FromGroup(group, iconId => ReadResource(module, iconId, RtIcon));
                if (ico is not null)
                {
                    result.Add((name ?? $"#{id.ToInt64()}", ico));
                }
            }

            return result;
        }
        finally
        {
            FreeLibrary(module);
        }
    }

    private static bool IsIntResource(IntPtr p) => (p.ToInt64() >> 16) == 0;

    private static byte[]? ReadResource(IntPtr module, IntPtr name, IntPtr type) =>
        ReadFound(module, FindResource(module, name, type));

    private static byte[]? ReadResource(IntPtr module, string name, IntPtr type) =>
        ReadFound(module, FindResource(module, name, type));

    private static byte[]? ReadFound(IntPtr module, IntPtr res)
    {
        if (res == IntPtr.Zero)
        {
            return null;
        }

        var size = SizeofResource(module, res);
        var handle = LoadResource(module, res);
        var ptr = handle == IntPtr.Zero ? IntPtr.Zero : LockResource(handle);
        if (ptr == IntPtr.Zero || size == 0)
        {
            return null;
        }

        var bytes = new byte[size];
        Marshal.Copy(ptr, bytes, 0, (int)size);
        return bytes;
    }

    private delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr param);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "FindResourceW")]
    private static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "FindResourceW")]
    private static extern IntPtr FindResource(IntPtr module, string name, IntPtr type);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resInfo);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LockResource(IntPtr resData);

    [DllImport("kernel32.dll")]
    private static extern uint SizeofResource(IntPtr module, IntPtr resInfo);
}
