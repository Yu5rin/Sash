using Sash.Core.Excel;

namespace Sash.Core.Tests;

public class ImageMsoPrefetchTests
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47];

    /// <summary>Excel の代わり。名前が "Missing" で始まれば存在しない、"Bad" で始まれば変換に失敗とする。</summary>
    private sealed class FakeSource : IImageMsoBatchSource
    {
        public List<(int Size, string[] Names)> Batches { get; } = [];

        public bool Begun { get; private set; }

        public bool Ended { get; private set; }

        public Exception? FailOnBegin { get; init; }

        /// <summary>まとまりを返す前に待つ（中止のテスト用）。</summary>
        public TaskCompletionSource? Gate { get; set; }

        /// <summary>最初のまとまりの処理に入ったら完了する。</summary>
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<string?> BeginAsync(CancellationToken cancellationToken)
        {
            Begun = true;
            return FailOnBegin is null ? Task.FromResult<string?>("16.0.19029") : Task.FromException<string?>(FailOnBegin);
        }

        public async Task<IReadOnlyList<ImageMsoFetchResult>> FetchAsync(IReadOnlyList<string> names, int size, CancellationToken cancellationToken)
        {
            Batches.Add((size, names.ToArray()));
            Entered.TrySetResult();
            if (Gate is { } gate)
            {
                await gate.Task;
            }

            return names.Select(n => n.StartsWith("Missing", StringComparison.Ordinal)
                ? new ImageMsoFetchResult(n, ImageMsoFetchKind.Missing)
                : n.StartsWith("Bad", StringComparison.Ordinal)
                    ? new ImageMsoFetchResult(n, ImageMsoFetchKind.Failed)
                    : new ImageMsoFetchResult(n, ImageMsoFetchKind.Found, Png)).ToList();
        }

        public Task EndAsync()
        {
            Ended = true;
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task 取り込んで画像と存在しない名前とmanifestを残す()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        var job = new ImageMsoPrefetch(cache);
        var source = new FakeSource();
        var events = new List<ImageMsoPrefetchStatus>();
        job.Changed += events.Add;

        Assert.Equal("none", job.GetStatus().State);
        Assert.True(job.Start(["AutoSum", "MissingOne", "FileSave", "AutoSum"], null, force: false, source));
        await job.Completion;

        var status = job.GetStatus();
        Assert.Equal("done", status.State);
        Assert.Equal((6, 6, 2), (status.Done, status.Total, status.Cached));
        Assert.Equal("16.0.19029", status.ExcelVersion);
        Assert.NotNull(status.CachedAt);
        Assert.Null(status.Message);
        Assert.True(source.Ended);

        // 32px を先に、次に 16px
        Assert.Equal([32, 16], source.Batches.Select(b => b.Size));
        Assert.Null(cache.Lookup(["MissingOne"], 16).Found["MissingOne"]);
        Assert.Equal(Png, new ImageMsoCache(dir.Path).Lookup(["FileSave"], 16).Found["FileSave"]);

        var manifest = cache.ReadManifest()!;
        Assert.Equal((2, 1, 3), (manifest.Images, manifest.Missing, manifest.Requested));
        Assert.Contains(events, e => e.State == "running");
        Assert.Equal("done", events[^1].State);
    }

    [Fact]
    public async Task 取り込み済みの名前は飛ばし_forceなら取り直す()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        cache.Store("AutoSum", 32, Png);
        cache.MarkMissing("MissingOne", 32);
        var job = new ImageMsoPrefetch(cache);

        var source = new FakeSource();
        job.Start(["AutoSum", "MissingOne", "FileSave"], [32], force: false, source);
        await job.Completion;
        Assert.Equal(["FileSave"], source.Batches.SelectMany(b => b.Names));
        Assert.Equal(1, job.GetStatus().Total);

        var again = new FakeSource();
        job.Start(["AutoSum", "MissingOne", "FileSave"], [32], force: true, again);
        await job.Completion;
        Assert.Equal(3, again.Batches.SelectMany(b => b.Names).Count());
    }

    [Fact]
    public async Task まとまりに分けて呼ぶ()
    {
        using var dir = new TempDir();
        var job = new ImageMsoPrefetch(new ImageMsoCache(dir.Path));
        var source = new FakeSource();
        var names = Enumerable.Range(0, ImageMsoPrefetch.BatchSize * 2 + 3).Select(i => $"Icon{i}").ToList();

        job.Start(names, [32], force: false, source);
        await job.Completion;

        Assert.Equal([ImageMsoPrefetch.BatchSize, ImageMsoPrefetch.BatchSize, 3], source.Batches.Select(b => b.Names.Length));
    }

    [Fact]
    public async Task 中止すると取り込めた分を残し_manifestは書かない()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        var job = new ImageMsoPrefetch(cache);
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new FakeSource { Gate = gate };
        var names = Enumerable.Range(0, ImageMsoPrefetch.BatchSize * 3).Select(i => $"Icon{i}").ToList();

        job.Start(names, [32], force: false, source);
        Assert.False(job.Start(names, [32], force: false, new FakeSource()));
        Assert.Equal("running", job.GetStatus().State);
        await source.Entered.Task;
        Assert.True(job.Cancel());
        gate.SetResult();
        await job.Completion;

        var status = job.GetStatus();
        Assert.Equal("none", status.State);
        Assert.NotNull(status.Message);
        Assert.Single(source.Batches);
        Assert.Equal(ImageMsoPrefetch.BatchSize, status.Cached);
        Assert.Null(cache.ReadManifest());
        Assert.True(source.Ended);
        Assert.False(job.Cancel());
    }

    [Fact]
    public async Task Excelを起動できなければfailedにして理由を残す()
    {
        using var dir = new TempDir();
        var log = new List<string>();
        var job = new ImageMsoPrefetch(new ImageMsoCache(dir.Path), log.Add);
        var source = new FakeSource { FailOnBegin = new InvalidOperationException("起動できない") };

        job.Start(["AutoSum"], null, force: false, source);
        await job.Completion;

        var status = job.GetStatus();
        Assert.Equal("failed", status.State);
        Assert.Contains("起動できない", status.Message);
        Assert.False(source.Ended);
        Assert.Contains(log, l => l.Contains("起動できない", StringComparison.Ordinal));
    }

    [Fact]
    public async Task 画像に1件もできないまま続けば打ち切る()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        var job = new ImageMsoPrefetch(cache);
        var source = new FakeSource();
        var names = Enumerable.Range(0, 500).Select(i => $"Bad{i}").ToList();

        job.Start(names, [32], force: false, source);
        await job.Completion;

        var status = job.GetStatus();
        Assert.Equal("failed", status.State);
        Assert.Equal(ImageMsoPrefetch.GiveUpAfter, status.Failed);
        Assert.True(source.Batches.Count < 10);
        Assert.Null(cache.ReadManifest());
        Assert.True(source.Ended);
    }

    [Fact]
    public async Task 一部だけ失敗したら完了にして件数を知らせる()
    {
        using var dir = new TempDir();
        var job = new ImageMsoPrefetch(new ImageMsoCache(dir.Path));

        job.Start(["AutoSum", "Bad1"], [32], force: false, new FakeSource());
        await job.Completion;

        var status = job.GetStatus();
        Assert.Equal("done", status.State);
        Assert.Equal(1, status.Failed);
        Assert.NotNull(status.Message);
    }
}
