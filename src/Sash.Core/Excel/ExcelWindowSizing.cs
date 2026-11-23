namespace Sash.Core.Excel;

/// <summary>
/// Excel のウィンドウの幅を「画面の幅（px）と拡大率」から決める計算（仕様書 §18.1）。COM に触らない部分だけを置き、単体テストできるようにする。
/// </summary>
/// <remarks>
/// 単位の考え方：
/// <list type="bullet">
/// <item>UI が送る width は、拡大率をかける前の画面の幅（物理 px。例：1920）。scale は Windows の拡大率（例：1.5 = 150%）。</item>
/// <item>アプリから見える幅（論理 px、96 dpi を 1 倍とする単位）は width / scale（例：1920 / 1.5 = 1280）。
/// リボンが何 px で畳まれるかは、この論理 px で決まる。</item>
/// <item>Application.Width はポイント（1/72 インチ）。論理 px は 1/96 インチなので、拡大率に関係なく 論理 px × 72/96 = × 0.75 になる。
/// 拡大率は「1 インチを何物理 px で描くか」を変えるだけで、論理 px とポイントの比は変えないため。</item>
/// <item>モニターの作業領域は、DPI を認識するプロセス（Sash は PerMonitorV2）からは物理 px で見える。
/// 比べるときはそのモニターの DPI で論理 px に直す（物理 px × 96 / dpi）。</item>
/// </list>
/// Windows 実機の Excel で、Application.Width が本当にこの換算どおりの幅になるかは確かめていない（仕様書 §18.7）。
/// </remarks>
public static class ExcelWindowSizing
{
    /// <summary>ポイント / 論理 px（72 / 96）。</summary>
    public const double PointsPerLogicalPixel = 0.75;

    /// <summary>受け付ける画面の幅の範囲（物理 px）。極端な値で Excel のウィンドウを潰したり巨大にしたりしないため。</summary>
    public const int MinWidth = 320;

    public const int MaxWidth = 10000;

    /// <summary>受け付ける拡大率の範囲（Windows の設定で選べるのは 100%〜500%）。</summary>
    public const double MinScale = 0.5;

    public const double MaxScale = 5.0;

    /// <summary>
    /// 拡大率を倍率（1.5）にそろえる。10 以上なら %（150）で渡されたものとみなして 100 で割る。
    /// UI のプレビューは拡大率を % で持つので、どちらで渡されても同じ結果になるようにする（倍率で 10 倍以上はありえないため）。
    /// </summary>
    public static double NormalizeScale(double scale) => scale >= 10 ? scale / 100 : scale;

    /// <summary>width / scale を論理 px にする。</summary>
    public static double LogicalWidth(int width, double scale) => width / scale;

    /// <summary>論理 px をポイントにする。</summary>
    public static double LogicalToPoints(double logicalPixels) => logicalPixels * PointsPerLogicalPixel;

    /// <summary>物理 px を、そのモニターの DPI で論理 px にする。dpi が 0 以下なら 96 とみなす。</summary>
    public static double PhysicalToLogical(int physicalPixels, int dpi) => physicalPixels * 96.0 / (dpi > 0 ? dpi : 96);

    /// <summary>width と scale が受け付けられる範囲か。外れていれば利用者向けの理由、よければ null。</summary>
    public static string? Validate(int width, double scale)
    {
        if (width < MinWidth || width > MaxWidth)
        {
            return Localization.Text.L($"幅は {MinWidth}〜{MaxWidth} px で指定してください（{width} px）。", $"The width must be between {MinWidth} and {MaxWidth} px ({width} px).");
        }

        if (double.IsNaN(scale) || scale < MinScale || scale > MaxScale)
        {
            return Localization.Text.L($"拡大率は {MinScale * 100:0}%〜{MaxScale * 100:0}% で指定してください。", $"The scale must be between {MinScale * 100:0}% and {MaxScale * 100:0}%.");
        }

        return null;
    }

    /// <summary>
    /// 合わせ方を決める。workAreaPhysicalWidth はモニターの作業領域の幅（物理 px）、monitorDpi はそのモニターの DPI。
    /// 論理 px にした幅が作業領域より広ければ Fits = false（ウィンドウが画面からはみ出し、Windows に縮められて正しく測れないため）。
    /// 小数点以下の誤差で断らないよう、0.5px までは収まるものとして扱う。
    /// </summary>
    public static WindowSizePlan Plan(int width, double scale, int workAreaPhysicalWidth, int monitorDpi)
    {
        var logical = LogicalWidth(width, scale);
        var workLogical = PhysicalToLogical(workAreaPhysicalWidth, monitorDpi);
        var points = Math.Round(LogicalToPoints(logical), 2);
        return new WindowSizePlan(logical, workLogical, points, logical <= workLogical + 0.5);
    }

    /// <summary>
    /// ウィンドウの位置を作業領域に収めるために、左端をどれだけ動かすか（ポイント）。
    /// 右にはみ出していれば負の値（左へ）、左にはみ出していれば正の値（右へ）。収まっていれば 0。
    /// 引数はすべて物理 px（GetWindowRect と rcWork の値）。
    /// </summary>
    public static double LeftAdjustmentPoints(int windowLeft, int windowRight, int workLeft, int workRight, int dpi)
    {
        int deltaPhysical = 0;
        if (windowRight > workRight)
        {
            deltaPhysical = workRight - windowRight;
        }

        if (windowLeft + deltaPhysical < workLeft)
        {
            deltaPhysical = workLeft - windowLeft;
        }

        return deltaPhysical == 0 ? 0 : LogicalToPoints(PhysicalToLogical(deltaPhysical, dpi));
    }
}

/// <summary>ウィンドウの幅の合わせ方。</summary>
/// <param name="LogicalWidth">合わせる幅（論理 px）。</param>
/// <param name="WorkAreaLogicalWidth">モニターの作業領域の幅（論理 px）。</param>
/// <param name="Points">Application.Width に入れる値（ポイント）。</param>
/// <param name="Fits">作業領域に収まるか。</param>
public sealed record WindowSizePlan(double LogicalWidth, double WorkAreaLogicalWidth, double Points, bool Fits);
