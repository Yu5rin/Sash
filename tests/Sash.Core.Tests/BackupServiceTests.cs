using Sash.Core.Packaging;

namespace Sash.Core.Tests;

public class BackupServiceTests
{
    private sealed class SteppingTime(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;

        public override DateTimeOffset GetUtcNow() => _now = _now.AddSeconds(1);

        public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;
    }

    [Fact]
    public void 指定した世代数を超えた古いバックアップは消える()
    {
        using var book = new TestWorkbook();
        var root = Path.Combine(book.BackupRoot, "backups");
        var service = new BackupService(root, generations: 3, new SteppingTime(new DateTimeOffset(2026, 11, 22, 9, 0, 0, TimeSpan.Zero)));

        var made = Enumerable.Range(0, 5).Select(_ => service.Backup(book.Path)).ToList();
        var kept = service.List(book.Path);

        Assert.Equal(3, kept.Count);
        Assert.Equal(made.TakeLast(3).Reverse(), kept);
    }
}
