using Sash.Core.Settings;

namespace Sash.Core.Tests;

public class WindowPlacementTests
{
    private static readonly ScreenArea Big = new(0, 0, 1920, 1040);
    private static readonly ScreenArea Small = new(0, 0, 1366, 728);

    [Fact]
    public void 保存がなければ_広い画面では作業領域の9割_上限1440x900で中央()
    {
        var b = WindowPlacement.Resolve(null, [Big], Big);

        Assert.Equal(1440, b.Width);
        Assert.Equal(900, b.Height);
        Assert.Equal((1920 - 1440) / 2, b.X);
        Assert.False(b.Maximized);
    }

    [Fact]
    public void 保存がなければ_1366x768の画面では最大化で開き_大きさは画面を超えない()
    {
        var b = WindowPlacement.Resolve(null, [Small], Small);

        Assert.True(b.Maximized);
        Assert.True(b.Width <= Small.Width);
        Assert.True(b.Height <= Small.Height);
    }

    [Fact]
    public void 保存値が今の画面に掛かっていれば_そのまま使う()
    {
        var saved = new WindowBounds { X = 100, Y = 50, Width = 1200, Height = 800, Maximized = true };

        Assert.Equal(saved, WindowPlacement.Resolve(saved, [Big], Big));
    }

    [Fact]
    public void 保存した位置が外れたモニターなら_既定に戻す()
    {
        // 2 枚目のモニターを外した。保存値は x=2000 以降にあり、今の画面とは 100px も重ならない
        var saved = new WindowBounds { X = 2000, Y = 100, Width = 1200, Height = 800 };

        var b = WindowPlacement.Resolve(saved, [Big], Big);

        Assert.NotEqual(saved, b);
        Assert.True(b.X >= 0 && b.X < Big.Right);
    }

    [Fact]
    public void タイトルバーが画面の上に出ている保存値は使わない()
    {
        // 窓の大半は画面に掛かっているが、タイトルバーの帯（上端から 30px）が作業領域の外。掴めなくなる
        var saved = new WindowBounds { X = 100, Y = -200, Width = 1200, Height = 800 };

        var b = WindowPlacement.Resolve(saved, [Big], Big);

        Assert.NotEqual(saved, b);
        Assert.True(b.Y >= Big.Y);
    }

    [Fact]
    public void タイトルバーが画面の下に出ている保存値は使わない()
    {
        var saved = new WindowBounds { X = 100, Y = 1030, Width = 1200, Height = 800 };

        Assert.NotEqual(saved, WindowPlacement.Resolve(saved, [Big], Big));
    }

    [Fact]
    public void 画面より大きい保存値は_作業領域に収まるよう丸める()
    {
        // 大きな画面で保存した 1900x1000 を、1366x728 の画面で開く
        var saved = new WindowBounds { X = 50, Y = 20, Width = 1900, Height = 1000, Maximized = true };

        var b = WindowPlacement.Resolve(saved, [Small], Small);

        Assert.True(b.X >= Small.X && b.X + b.Width <= Small.Right);
        Assert.True(b.Y >= Small.Y && b.Y + b.Height <= Small.Bottom);
        Assert.True(b.Maximized);
    }

    [Fact]
    public void 下端がはみ出す保存値は_上へ寄せる()
    {
        var saved = new WindowBounds { X = 100, Y = 600, Width = 1200, Height = 800 };

        var b = WindowPlacement.Resolve(saved, [Big], Big);

        Assert.Equal(Big.Bottom - 800, b.Y);
        Assert.Equal(1200, b.Width);
    }

    [Fact]
    public void 二枚目のモニターにタイトルバーがあれば_そのモニターに収める()
    {
        var second = new ScreenArea(1920, 0, 1366, 728);
        var saved = new WindowBounds { X = 2000, Y = 10, Width = 1200, Height = 650 };

        Assert.Equal(saved, WindowPlacement.Resolve(saved, [Big, second], Big));
    }

    [Fact]
    public void 端に100px未満しか掛からない保存値は使わない()
    {
        var saved = new WindowBounds { X = 1900, Y = 100, Width = 1200, Height = 800 };

        Assert.NotEqual(saved, WindowPlacement.Resolve(saved, [Big], Big));
    }

    [Fact]
    public void 最小より小さい保存値は使わない()
    {
        var saved = new WindowBounds { X = 0, Y = 0, Width = 300, Height = 200 };

        Assert.NotEqual(saved, WindowPlacement.Resolve(saved, [Big], Big));
    }

    [Fact]
    public void 設定に保存して読み戻せる_壊れた大きさは捨てる()
    {
        using var book = new TestWorkbook();
        var path = Path.Combine(book.BackupRoot, "settings.json");
        var store = new SettingsStore(path);

        store.Update(s => s with { Window = new WindowBounds { X = 10, Y = 20, Width = 1000, Height = 700, Maximized = true } });
        var w = new SettingsStore(path).Load().Window;
        Assert.Equal(new WindowBounds { X = 10, Y = 20, Width = 1000, Height = 700, Maximized = true }, w);

        store.Update(s => s with { Window = new WindowBounds { Width = 0, Height = -5 } });
        Assert.Null(new SettingsStore(path).Load().Window);
    }
}
