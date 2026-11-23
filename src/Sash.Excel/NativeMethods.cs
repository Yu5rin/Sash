using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;

namespace Sash.Excel;

[SupportedOSPlatform("windows")]
internal static partial class NativeMethods
{
    [DllImport("ole32.dll")]
    public static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable prot);

    [DllImport("ole32.dll")]
    public static extern int CreateBindCtx(int reserved, out IBindCtx ppbc);

    [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
    public static extern int CLSIDFromProgID(string lpszProgID, out Guid pclsid);

    [DllImport("oleaut32.dll")]
    public static extern int GetActiveObject(ref Guid rclsid, IntPtr pvReserved, [MarshalAs(UnmanagedType.IUnknown)] out object ppunk);

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [DllImport("gdi32.dll")]
    public static extern int GetObject(IntPtr h, int c, out BITMAP bmp);

    [DllImport("gdi32.dll")]
    public static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, [Out] byte[] bits, ref BITMAPINFOHEADER bmi, uint usage);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

    // ---- imageMso を BMP のバイト列として受け取るためのメモリ上のストリーム ----

    [DllImport("ole32.dll")]
    public static extern int CreateStreamOnHGlobal(IntPtr hGlobal, [MarshalAs(UnmanagedType.Bool)] bool fDeleteOnRelease, out IStream ppstm);

    [DllImport("ole32.dll")]
    public static extern int GetHGlobalFromStream(IStream pstm, out IntPtr phglobal);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll")]
    public static extern UIntPtr GlobalSize(IntPtr hMem);
}

/// <summary>
/// OLE のピクチャ（ocidl.h の IPicture）。GetImageMso の戻り値（IPictureDisp）から QueryInterface で取る。
/// 使うのは SaveAsFile だけだが、vtable の順に並べないと別のメソッドを呼んでしまうので、すべてを宣言どおりの順に書く。
/// </summary>
[SupportedOSPlatform("windows")]
[ComImport]
[Guid("7BF80980-BF32-101A-8BBB-00AA00300CAB")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOlePicture
{
    [PreserveSig]
    int get_Handle(out uint handle);

    [PreserveSig]
    int get_hPal(out uint hPal);

    [PreserveSig]
    int get_Type(out short type);

    [PreserveSig]
    int get_Width(out int width);

    [PreserveSig]
    int get_Height(out int height);

    [PreserveSig]
    int Render(IntPtr hdc, int x, int y, int cx, int cy, int xSrc, int ySrc, int cxSrc, int cySrc, IntPtr prcWBounds);

    [PreserveSig]
    int set_hPal(uint hPal);

    [PreserveSig]
    int get_CurDC(out IntPtr hdc);

    [PreserveSig]
    int SelectPicture(IntPtr hdcIn, out IntPtr hdcOut, out uint hBmpOut);

    [PreserveSig]
    int get_KeepOriginalFormat([MarshalAs(UnmanagedType.Bool)] out bool keep);

    [PreserveSig]
    int put_KeepOriginalFormat([MarshalAs(UnmanagedType.Bool)] bool keep);

    [PreserveSig]
    int PictureChanged();

    [PreserveSig]
    int SaveAsFile(IStream stream, [MarshalAs(UnmanagedType.Bool)] bool fSaveMemCopy, out int cbSize);

    [PreserveSig]
    int get_Attributes(out uint attributes);
}

/// <summary>
/// IPersistStream（objidl.h）。IPicture を取れないときの次の手段。OLE のピクチャは "lt\0\0" と長さに続けて BMP を書く。
/// IPersist の GetClassID から順に宣言する。
/// </summary>
[SupportedOSPlatform("windows")]
[ComImport]
[Guid("00000109-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOlePersistStream
{
    [PreserveSig]
    int GetClassID(out Guid classId);

    [PreserveSig]
    int IsDirty();

    [PreserveSig]
    int Load(IStream stream);

    [PreserveSig]
    int Save(IStream stream, [MarshalAs(UnmanagedType.Bool)] bool clearDirty);

    [PreserveSig]
    int GetSizeMax(out long size);
}
