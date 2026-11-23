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

    private static BackupService NewService(TestWorkbook book, int generations = 10) =>
        new(Path.Combine(book.BackupRoot, "backups"), generations, new SteppingTime(new DateTimeOffset(2026, 11, 22, 9, 0, 0, TimeSpan.Zero)));

    [Fact]
    public void 指定した世代数を超えた古いバックアップは消える()
    {
        using var book = new TestWorkbook();
        var service = NewService(book, generations: 3);

        var made = new List<string>();
        for (var i = 0; i < 5; i++)
        {
            File.AppendAllText(book.Path, "x");
            made.Add(service.Backup(book.Path));
        }

        var kept = service.List(book.Path);

        Assert.Equal(3, kept.Count);
        Assert.Equal(made.TakeLast(3).Reverse(), kept);
    }

    [Fact]
    public void 中身が最新のバックアップと同じなら新しく作らない()
    {
        using var book = new TestWorkbook();
        var service = NewService(book, generations: 2);

        File.AppendAllText(book.Path, "1");
        var first = service.Backup(book.Path);
        File.AppendAllText(book.Path, "2");
        var second = service.Backup(book.Path);

        // 書き込みのやり直しなどで同じ中身を何度バックアップしても、古い世代は押し出されない
        for (var i = 0; i < 11; i++)
        {
            Assert.Equal(second, service.Backup(book.Path));
        }

        Assert.Equal([second, first], service.List(book.Path));
    }

    [Fact]
    public void 同じ名前でも別のフォルダのブックは別々にバックアップする()
    {
        using var a = new TestWorkbook();
        using var b = new TestWorkbook();
        File.AppendAllText(b.Path, "別の中身");
        var service = NewService(a, generations: 1);

        var ba = service.Backup(a.Path);
        var bb = service.Backup(b.Path);

        Assert.Equal(Path.GetFileName(a.Path), Path.GetFileName(b.Path));
        Assert.NotEqual(Path.GetDirectoryName(ba), Path.GetDirectoryName(bb));
        Assert.Equal([ba], service.List(a.Path));
        Assert.Equal([bb], service.List(b.Path));
        Assert.StartsWith("book.xlsm_", Path.GetFileName(Path.GetDirectoryName(ba)), StringComparison.Ordinal);
        Assert.Equal(a.Path, File.ReadAllText(Path.Combine(service.FolderOf(a.Path), BackupService.SourceFileName)).Trim());
    }

    [Fact]
    public void 一覧に日時と大きさが付く()
    {
        using var book = new TestWorkbook();
        var service = NewService(book);

        var made = service.Backup(book.Path);

        var entry = Assert.Single(service.ListEntries(book.Path));
        Assert.Equal(made, entry.Path);
        Assert.Equal(new FileInfo(book.Path).Length, entry.Size);
        Assert.Equal(new DateTime(2026, 11, 22, 9, 0, 1), entry.CreatedAt.DateTime);
    }

    [Fact]
    public void バックアップから戻すと今のファイルもバックアップされる()
    {
        using var book = new TestWorkbook();
        var service = NewService(book, generations: 2);
        var original = File.ReadAllBytes(book.Path);
        var old = service.Backup(book.Path);
        File.AppendAllText(book.Path, "変更");
        var changed = File.ReadAllBytes(book.Path);
        // 世代がいっぱいの状態で戻す（今のファイルのバックアップで、戻したい世代が押し出されても戻せること）
        File.AppendAllText(book.Path, "さらに変更");
        service.Backup(book.Path);
        File.WriteAllBytes(book.Path, changed);

        var current = service.Restore(old, book.Path);

        Assert.Equal(original, File.ReadAllBytes(book.Path));
        Assert.NotNull(current);
        Assert.Equal(changed, File.ReadAllBytes(current));
        Assert.Empty(Directory.GetFiles(book.BackupRoot, "*.sash-tmp"));
    }

    [Fact]
    public void ほかのファイルのバックアップやフォルダの外のファイルからは戻さない()
    {
        using var a = new TestWorkbook();
        using var b = new TestWorkbook();
        var service = NewService(a);
        var ofB = service.Backup(b.Path);
        var outside = Path.Combine(a.BackupRoot, "outside.xlsm");
        File.Copy(a.Path, outside);
        var note = Path.Combine(service.FolderOf(b.Path), BackupService.SourceFileName);

        Assert.False(service.IsBackupOf(ofB, a.Path));
        Assert.False(service.IsBackupOf(outside, a.Path));
        Assert.False(service.IsBackupOf(note, b.Path));
        Assert.True(service.IsBackupOf(ofB, b.Path));
        Assert.Throws<UserFacingException>(() => service.Restore(ofB, a.Path));
        Assert.Throws<UserFacingException>(() => service.Restore(outside, a.Path));
    }

    [Fact]
    public void 読み取り専用のブックのバックアップも古い世代を消せる()
    {
        using var book = new TestWorkbook();
        var service = NewService(book, generations: 1);
        File.SetAttributes(book.Path, FileAttributes.ReadOnly);
        try
        {
            var first = service.Backup(book.Path);
            Assert.False(new FileInfo(first).IsReadOnly);
            File.SetAttributes(book.Path, FileAttributes.Normal);
            File.AppendAllText(book.Path, "x");
            var second = service.Backup(book.Path);
            Assert.Equal([second], service.List(book.Path));
        }
        finally
        {
            File.SetAttributes(book.Path, FileAttributes.Normal);
        }
    }
}
