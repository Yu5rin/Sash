namespace Sash.Core.Imaging;

/// <summary>
/// GetImageMso の画素のアルファを PNG 向け（ストレート）にそろえる。
/// HBITMAP から読んだときも BMP のバイト列から読んだときも同じ扱いにするため、ここにまとめる。
/// </summary>
public static class BgraAlpha
{
    /// <summary>
    /// アルファがすべて 0 の画像は、アルファを持たない画像（24bpp や BI_RGB の X8R8G8B8）として不透明にする。
    /// そうでなければ、GetImageMso が返す乗算済みアルファをストレートに戻す。
    /// </summary>
    public static void Normalize(Span<byte> bgra)
    {
        var hasAlpha = false;
        for (var i = 3; i < bgra.Length; i += 4)
        {
            if (bgra[i] != 0)
            {
                hasAlpha = true;
                break;
            }
        }

        if (!hasAlpha)
        {
            for (var i = 3; i < bgra.Length; i += 4)
            {
                bgra[i] = 255;
            }

            return;
        }

        for (var i = 0; i + 3 < bgra.Length; i += 4)
        {
            int a = bgra[i + 3];
            if (a is > 0 and < 255)
            {
                bgra[i] = (byte)Math.Min(255, bgra[i] * 255 / a);
                bgra[i + 1] = (byte)Math.Min(255, bgra[i + 1] * 255 / a);
                bgra[i + 2] = (byte)Math.Min(255, bgra[i + 2] * 255 / a);
            }
        }
    }
}
