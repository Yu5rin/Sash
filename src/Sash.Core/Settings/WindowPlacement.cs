namespace Sash.Core.Settings;

/// <summary>保存しておくウィンドウの位置と大きさ（画面の座標。最大化していても、戻したときの値を持つ）。</summary>
public sealed record WindowBounds
{
    public int X { get; init; }

    public int Y { get; init; }

    public int Width { get; init; }

    public int Height { get; init; }

    public bool Maximized { get; init; }
}

/// <summary>作業領域（タスクバーを除いた画面の範囲）。</summary>
public readonly record struct ScreenArea(int X, int Y, int Width, int Height)
{
    public int Right => X + Width;

    public int Bottom => Y + Height;
}

/// <summary>
/// 起動時のウィンドウの位置と大きさを決める（総点検 W-1）。
/// 保存値が今の画面に十分掛かっていれば使い、画面が変わって外れていたら既定にする。
/// 既定は作業領域の 90%（上限 1440×900）で中央。作業領域の幅が 1440 未満の小さな画面では最大化で開く。
/// </summary>
public static class WindowPlacement
{
    public const int DefaultWidth = 1440;
    public const int DefaultHeight = 900;

    /// <summary>MainForm の MinimumSize と同じ。これより小さい保存値は使わない。</summary>
    public const int MinWidth = 960;

    public const int MinHeight = 600;

    /// <summary>保存した位置が「画面に掛かっている」とみなす、横・縦それぞれの最小の重なり（px）。</summary>
    public const int MinVisible = 100;

    public static WindowBounds Resolve(WindowBounds? saved, IReadOnlyList<ScreenArea> areas, ScreenArea primary)
    {
        if (saved is { Width: >= MinWidth, Height: >= MinHeight } s && areas.Any(a => Overlaps(s, a)))
        {
            return s;
        }

        var width = Math.Min(DefaultWidth, primary.Width * 9 / 10);
        var height = Math.Min(DefaultHeight, primary.Height * 9 / 10);
        // 小さな画面では、最小の大きさを割らない範囲にしてから最大化する
        width = Math.Max(width, Math.Min(MinWidth, primary.Width));
        height = Math.Max(height, Math.Min(MinHeight, primary.Height));
        return new WindowBounds
        {
            X = primary.X + (primary.Width - width) / 2,
            Y = primary.Y + (primary.Height - height) / 2,
            Width = width,
            Height = height,
            Maximized = primary.Width < DefaultWidth,
        };
    }

    private static bool Overlaps(WindowBounds b, ScreenArea a)
    {
        var overlapX = Math.Min(b.X + b.Width, a.Right) - Math.Max(b.X, a.X);
        var overlapY = Math.Min(b.Y + b.Height, a.Bottom) - Math.Max(b.Y, a.Y);
        return overlapX >= MinVisible && overlapY >= MinVisible;
    }
}
