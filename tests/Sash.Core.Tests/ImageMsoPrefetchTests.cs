using Sash.Core.Excel;

namespace Sash.Core.Tests;

public class ImageMsoPrefetchTests
{
    /// <summary>PNG の署名で始まるバイト列（キャッシュは署名のないファイルを壊れたものとして扱うため）。</summary>
    internal static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];

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
        Assert.Equal((3, 3, 2), (status.Done, status.Total, status.Cached));
        Assert.Equal("16.0.19029", status.ExcelVersion);
        Assert.NotNull(status.CachedAt);
        Assert.Null(status.Message);
        Assert.True(source.Ended);

        // 既定では表示に使う 32px だけを取り込む（16px は使われないので取らない）
        Assert.Equal([32], source.Batches.Select(b => b.Size));
        Assert.False(Directory.Exists(cache.SizeDirectory(16)));
        Assert.Null(cache.Lookup(["MissingOne"], 32).Found["MissingOne"]);
        Assert.Equal(Png, new ImageMsoCache(dir.Path).Lookup(["FileSave"], 32).Found["FileSave"]);

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
        Assert.True(status.Cancelled);
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

        // 起動の途中で失敗しても、起動しかけた Excel を残さないよう後片付けは呼ぶ
        Assert.True(source.Ended);
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

    [Fact]
    public async Task 指定した大きさだけを取り込む()
    {
        using var dir = new TempDir();
        var job = new ImageMsoPrefetch(new ImageMsoCache(dir.Path));
        var source = new FakeSource();

        job.Start(["AutoSum"], [32, 16], force: false, source);
        await job.Completion;

        Assert.Equal([32, 16], source.Batches.Select(b => b.Size));
    }

    [Fact]
    public async Task 取り込み直しを中止したら_前の記録が残っていても中止として知らせる()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        var job = new ImageMsoPrefetch(cache);
        job.Start(["AutoSum"], [32], force: false, new FakeSource());
        await job.Completion;
        Assert.False(job.GetStatus().Cancelled);

        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new FakeSource { Gate = gate };
        var events = new List<ImageMsoPrefetchStatus>();
        job.Changed += events.Add;
        job.Start(Enumerable.Range(0, ImageMsoPrefetch.BatchSize * 3).Select(i => $"Icon{i}").ToList(), [32], force: true, source);
        await source.Entered.Task;
        job.Cancel();
        gate.SetResult();
        await job.Completion;

        var status = job.GetStatus();
        Assert.Equal("done", status.State);
        Assert.True(status.Cancelled);
        Assert.True(events[^1].Cancelled);
        Assert.DoesNotContain(events, e => e.State == "running" && e.Cancelled);

        // 次に始めたら、中止の印は消える
        job.Start(["AutoSum"], [32], force: false, new FakeSource());
        await job.Completion;
        Assert.False(job.GetStatus().Cancelled);
    }

    [Fact]
    public async Task 失敗は記録に残り_同じ版のExcelでは次の起動でもfailedになる()
    {
        using var dir = new TempDir();
        var version = "16.0.19029.20000";
        var job = new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => version);
        job.Start(["AutoSum"], null, force: false, new FakeSource { FailOnBegin = new InvalidOperationException("起動できない") });
        await job.Completion;

        var record = new ImageMsoCache(dir.Path).ReadFailure();
        Assert.NotNull(record);
        Assert.Equal("16.0.19029", record.ExcelVersion);

        // 次の起動（新しいインスタンス）。同じ版なら failed のまま（UI は自動で始めない）
        var next = new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => "16.0.19029");
        var status = next.GetStatus();
        Assert.Equal("failed", status.State);
        Assert.Contains("起動できない", status.Message);

        // 版が分からなくても、同じ Excel とみなして failed のまま
        Assert.Equal("failed", new ImageMsoPrefetch(new ImageMsoCache(dir.Path)).GetStatus().State);

        // Excel が更新されていれば、もう一度自動で試せるよう none に戻る
        Assert.Equal("none", new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => "16.0.19127").GetStatus().State);
    }

    [Fact]
    public void 古い取り出し方で失敗した記録は当てはめず_もう一度自動で試せる()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);

        // 取り出し方を直す前の記録（Method のない JSON は 0 として読まれる）
        cache.WriteFailure(new ImageMsoFailureRecord("16.0.19029", DateTimeOffset.Now, "打ち切り"));
        Assert.Equal(0, cache.ReadFailure()!.Method);
        Assert.Equal("none", new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => "16.0.19029").GetStatus().State);

        // 2 は Sash から（別のプロセスから）GetImageMso を呼んでいたころの記録。Excel の中で取り出す 3 では当てはめない
        Assert.Equal(3, ImageMsoFailureRecord.CurrentMethod);
        cache.WriteFailure(new ImageMsoFailureRecord("16.0.19029", DateTimeOffset.Now, "打ち切り", 2));
        Assert.Equal(2, new ImageMsoCache(dir.Path).ReadFailure()!.Method);
        Assert.Equal("none", new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => "16.0.19029").GetStatus().State);

        // いまの取り出し方で失敗した記録なら、同じ版では自動で始めない
        cache.WriteFailure(new ImageMsoFailureRecord("16.0.19029", DateTimeOffset.Now, "打ち切り", ImageMsoFailureRecord.CurrentMethod));
        Assert.Equal("failed", new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => "16.0.19029").GetStatus().State);
    }

    [Fact]
    public async Task 打ち切りも記録に残り_手動で取り込めたら記録を消す()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        var job = new ImageMsoPrefetch(cache, null, () => "16.0.19029");
        job.Start(Enumerable.Range(0, 300).Select(i => $"Bad{i}").ToList(), [32], force: false, new FakeSource());
        await job.Completion;
        Assert.NotNull(cache.ReadFailure());
        Assert.Equal("failed", new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => "16.0.19029").GetStatus().State);

        // 設定画面から手動で始めて成功したら、失敗の記録は消えて done になる
        job.Start(["AutoSum"], [32], force: true, new FakeSource());
        await job.Completion;
        Assert.Null(cache.ReadFailure());
        Assert.Equal("done", job.GetStatus().State);
        Assert.Equal("done", new ImageMsoPrefetch(new ImageMsoCache(dir.Path), null, () => "16.0.19029").GetStatus().State);
    }

    [Fact]
    public async Task 取り込んだExcelの版はメジャーマイナービルドにそろえて記録する()
    {
        using var dir = new TempDir();
        var cache = new ImageMsoCache(dir.Path);
        var job = new ImageMsoPrefetch(cache);
        job.Start(["AutoSum"], [32], force: false, new VersionSource("16.0.19029.20000"));
        await job.Completion;

        Assert.Equal("16.0.19029", cache.ReadManifest()!.ExcelVersion);
    }

    private sealed class VersionSource(string version) : IImageMsoBatchSource
    {
        public Task<string?> BeginAsync(CancellationToken cancellationToken) => Task.FromResult<string?>(version);

        public Task<IReadOnlyList<ImageMsoFetchResult>> FetchAsync(IReadOnlyList<string> names, int size, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ImageMsoFetchResult>>(names.Select(n => new ImageMsoFetchResult(n, ImageMsoFetchKind.Found, Png)).ToList());

        public Task EndAsync() => Task.CompletedTask;
    }
}
