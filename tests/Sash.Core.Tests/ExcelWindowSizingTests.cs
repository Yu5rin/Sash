using Sash.Core.Excel;

namespace Sash.Core.Tests;

public class ExcelWindowSizingTests
{
    [Theory]
    // 拡大率 100%：1920px はそのまま 1920 論理 px = 1440pt
    [InlineData(1920, 1.0, 1920, 1440)]
    // 拡大率 150%：1920px の画面は、アプリから見ると 1280 論理 px = 960pt
    [InlineData(1920, 1.5, 1280, 960)]
    // 拡大率 125%：1366px → 1092.8 論理 px = 819.6pt
    [InlineData(1366, 1.25, 1092.8, 819.6)]
    [InlineData(1280, 1.0, 1280, 960)]
    public void 画面の幅と拡大率からポイントを求める(int width, double scale, double logical, double points)
    {
        var plan = ExcelWindowSizing.Plan(width, scale, 10000, 96);
        Assert.Equal(logical, plan.LogicalWidth, 6);
        Assert.Equal(points, plan.Points, 2);
        Assert.True(plan.Fits);
    }

    [Fact]
    public void 作業領域は物理pxをモニターのDPIで論理pxに直して比べる()
    {
        // 3840px（物理）の 4K を 200%（192dpi）で使うと、作業領域は 1920 論理 px
        Assert.True(ExcelWindowSizing.Plan(1920, 1.0, 3840, 192).Fits);
        Assert.False(ExcelWindowSizing.Plan(2560, 1.0, 3840, 192).Fits);
        Assert.Equal(1920, ExcelWindowSizing.Plan(2560, 1.0, 3840, 192).WorkAreaLogicalWidth, 6);
        // 同じ 2560px でも拡大率 150% として測るなら 1706.7 論理 px で収まる
        Assert.True(ExcelWindowSizing.Plan(2560, 1.5, 3840, 192).Fits);
    }

    [Fact]
    public void 作業領域を超える幅は断り同じ幅は収まる()
    {
        // 1366 / 1.25 = 1092.8 論理 px。作業領域が 1092 論理 px（物理 1365、125%）なら 0.8px はみ出すので断る
        Assert.False(ExcelWindowSizing.Plan(1366, 1.25, 1365, 120).Fits);
        // 作業領域とちょうど同じ幅は収まる
        Assert.True(ExcelWindowSizing.Plan(1920, 1.0, 1920, 96).Fits);
    }

    [Theory]
    [InlineData(1.5, 1.5)]
    [InlineData(150, 1.5)]
    [InlineData(100, 1.0)]
    [InlineData(1.25, 1.25)]
    public void 拡大率はパーセントで渡されても倍率にそろえる(double input, double expected) =>
        Assert.Equal(expected, ExcelWindowSizing.NormalizeScale(input), 6);

    [Fact]
    public void DPIが取れないときは96とみなす() => Assert.Equal(1920, ExcelWindowSizing.PhysicalToLogical(1920, 0), 6);

    [Theory]
    [InlineData(100, 1.0)]
    [InlineData(20000, 1.0)]
    [InlineData(1920, 0.1)]
    [InlineData(1920, 9.0)]
    [InlineData(1920, double.NaN)]
    public void 範囲外の幅と拡大率は断る(int width, double scale) => Assert.NotNull(ExcelWindowSizing.Validate(width, scale));

    [Fact]
    public void 範囲内なら断らない() => Assert.Null(ExcelWindowSizing.Validate(1920, 1.5));

    [Theory]
    // 右に 100 物理 px はみ出した（96dpi）→ 左へ 75pt
    [InlineData(200, 2020, 0, 1920, 96, -75)]
    // 192dpi なら 100 物理 px は 50 論理 px = 37.5pt
    [InlineData(200, 2020, 0, 1920, 192, -37.5)]
    // 左にはみ出した → 右へ
    [InlineData(-40, 1000, 0, 1920, 96, 30)]
    // 収まっていれば動かさない
    [InlineData(10, 1000, 0, 1920, 96, 0)]
    // 2 枚目のモニター（左端が 1920）
    [InlineData(2100, 3940, 1920, 3840, 96, -75)]
    public void はみ出した分だけ左端を動かす(int left, int right, int workLeft, int workRight, int dpi, double expected) =>
        Assert.Equal(expected, ExcelWindowSizing.LeftAdjustmentPoints(left, right, workLeft, workRight, dpi), 6);
}
