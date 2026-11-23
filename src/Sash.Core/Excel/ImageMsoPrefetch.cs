using static Sash.Core.Localization.Text;

namespace Sash.Core.Excel;

public enum ImageMsoFetchKind
{
    /// <summary>画像を取り出せた。</summary>
    Found,

    /// <summary>Excel にその名前のアイコンがない。</summary>
    Missing,

    /// <summary>名前はあるかもしれないが、画像にできなかった（変換の失敗や、Excel が一時的に応答しないなど）。</summary>
    Failed,
}

public sealed record ImageMsoFetchResult(string Name, ImageMsoFetchKind Kind, byte[]? Png = null);

/// <summary>
/// 取り込みでアイコンを取り出す相手（実際には Excel）。テストでは偽物に差し替える。
/// </summary>
public interface IImageMsoBatchSource
{
    /// <summary>取り出しの準備（取り込み専用の見えない Excel の起動）。Excel の版（例：16.0.19029）を返す。</summary>
    Task<string?> BeginAsync(CancellationToken cancellationToken);

    /// <summary>
    /// 名前のまとまりを取り出す。途中で中止されたら、そこまでの結果だけを返してよい。
    /// まとまりごとに呼ぶので、その合間にほかの Excel の操作（反映や VBA の読み込み）が割り込める。
    /// </summary>
    Task<IReadOnlyList<ImageMsoFetchResult>> FetchAsync(IReadOnlyList<string> names, int size, CancellationToken cancellationToken);

    /// <summary>後片付け（起動した Excel を終わらせる）。失敗しても取り込みの結果は変えない。</summary>
    Task EndAsync();
}

/// <summary>
/// 取り込みの状態。UI の icons.prefetchStatus の応答と同じ形（ui/src/bridge.ts の IconPrefetchStatus）。
/// </summary>
/// <param name="State">none（未取り込み）・running・done・failed。unavailable はホストが Excel の有無を見て決める。</param>
/// <param name="Done">今回の取り込みで処理した数（名前 × 大きさ）。</param>
/// <param name="Total">今回の取り込みで処理する数。</param>
/// <param name="Size">処理中（最後に処理した）大きさ（px）。</param>
/// <param name="Failed">画像にできなかった数。</param>
/// <param name="Cached">キャッシュにある画像の数（32px）。</param>
/// <param name="ExcelVersion">取り込み済みのキャッシュを作った Excel の版。</param>
/// <param name="CachedAt">取り込みを終えた日時。</param>
/// <param name="Message">利用者に見せる補足（失敗の理由、中止したことなど）。</param>
/// <param name="Cancelled">
/// 直前の取り込みが中止で終わったか。取り込み直しを中止すると、前の記録（manifest）が残っているので State は done になる。
/// それだけでは UI が「取り込みました」と出してしまうので、中止したことを別に知らせる。
/// </param>
public sealed record ImageMsoPrefetchStatus(
    string State,
    int Done,
    int Total,
    int Size,
    int Failed,
    int Cached,
    string? ExcelVersion,
    DateTimeOffset? CachedAt,
    string? Message,
    bool Cancelled = false);

/// <summary>
/// imageMso の一括の取り込み（初回起動時と、設定画面の「取り込み直す」）。
/// 数千件を 1 回の COM 呼び出しで処理すると、その間ほかの Excel の操作がすべて待たされるので、
/// <see cref="BatchSize"/> 件ずつに分けて呼ぶ。1 件ずつの失敗は数えるだけにし、最初の失敗の理由だけをログに残す。
/// </summary>
/// <param name="cache">取り込み先のキャッシュ。</param>
/// <param name="log">診断の記録の書き出し先。</param>
/// <param name="currentExcelVersion">
/// いま入っている Excel の版を返す（Excel を起動せずに読めるもの）。失敗の記録がこの版のものなら、自動では取り込み直さない。
/// </param>
public sealed class ImageMsoPrefetch(ImageMsoCache cache, Action<string>? log = null, Func<string?>? currentExcelVersion = null)
{
    public const int BatchSize = 50;

    /// <summary>
    /// UI はキャンバスもアイコンの一覧も 32px の画像を縮めて描く（小さいボタンも 32px を 16px に縮める）ので、32px だけを取り込む。
    /// 16px も取ると時間が倍かかるうえ、使われないファイルが数千個増えるだけになる。ほかの大きさは引数で指定できる。
    /// </summary>
    public static readonly IReadOnlyList<int> DefaultSizes = [32];

    /// <summary>
    /// これだけ処理して 1 件も画像にできなければ、変換の方法がこの PC で動いていないとみなして打ち切る
    /// （残りの数千件を同じ理由で失敗し続けて、利用者を待たせないため）。
    /// </summary>
    public const int GiveUpAfter = 100;

    private readonly Lock _gate = new();
    private bool _running;
    private bool _cancelled;
    private string? _failure;
    private string? _message;
    private int _done;
    private int _total;
    private int _size;
    private int _failed;
    private CancellationTokenSource? _cts;
    private Task _task = Task.CompletedTask;

    /// <summary>状態が変わるたび（まとまりを 1 つ処理するたび）に呼ぶ。スレッド プールから呼ばれる。</summary>
    public event Action<ImageMsoPrefetchStatus>? Changed;

    /// <summary>実行中の取り込み（テストで終わりを待つため）。</summary>
    public Task Completion
    {
        get
        {
            lock (_gate)
            {
                return _task;
            }
        }
    }

    public bool IsRunning
    {
        get
        {
            lock (_gate)
            {
                return _running;
            }
        }
    }

    public ImageMsoPrefetchStatus GetStatus()
    {
        bool running, cancelled;
        string? failure, message;
        int done, total, size, failed;
        lock (_gate)
        {
            (running, cancelled, failure, message, done, total, size, failed) = (_running, _cancelled, _failure, _message, _done, _total, _size, _failed);
        }

        // 前の起動で失敗したまま、Excel の版が変わっていなければ failed として返す。
        // UI は failed では自動で取り込みを始めないので、起動のたびに見えない Excel を起動して失敗し直すことがなくなる
        if (!running && failure is null && cache.ReadFailure() is { } record && FailureApplies(record))
        {
            failure = record.Message ?? L("前回、アイコンを取り込めませんでした。", "The icons could not be imported last time.");
        }

        var manifest = cache.ReadManifest();
        var state = running ? "running" : failure is not null ? "failed" : manifest is not null ? "done" : "none";
        return new ImageMsoPrefetchStatus(state, done, total, size, failed, cache.ImageCount(ImageMsoCache.PrimarySize),
            manifest?.ExcelVersion, manifest?.CompletedAt, failure ?? message, !running && cancelled);
    }

    /// <summary>
    /// 取り込みを始める。すでに実行中なら何もせず false。
    /// force が false なら、キャッシュにある名前（画像か、存在しない記録）は飛ばす。true なら Excel から取り直す。
    /// </summary>
    public bool Start(IReadOnlyList<string> names, IReadOnlyList<int>? sizes, bool force, IImageMsoBatchSource source)
    {
        ArgumentNullException.ThrowIfNull(names);
        ArgumentNullException.ThrowIfNull(source);
        var validNames = names.Where(ImageMsoCache.IsValidName).Distinct(StringComparer.Ordinal).ToList();
        var validSizes = (sizes is { Count: > 0 } ? sizes : DefaultSizes).Where(s => s is >= 16 and <= 128).Distinct().ToList();
        if (validSizes.Count == 0)
        {
            validSizes = [.. DefaultSizes];
        }

        CancellationTokenSource cts;
        lock (_gate)
        {
            if (_running)
            {
                return false;
            }

            _running = true;
            _cancelled = false;
            _failure = null;
            _message = null;
            _done = 0;
            _total = 0;
            _failed = 0;
            _size = validSizes[0];
            _cts?.Dispose();
            _cts = cts = new CancellationTokenSource();
            _task = Task.Run(() => RunAsync(validNames, validSizes, force, source, cts.Token));
        }

        return true;
    }

    /// <summary>実行中の取り込みを止める。取り込めた分はキャッシュに残る。</summary>
    public bool Cancel()
    {
        lock (_gate)
        {
            if (!_running || _cts is null)
            {
                return false;
            }

            _cts.Cancel();
            return true;
        }
    }

    /// <summary>
    /// 失敗の記録が、いまの Excel にも当てはまるか。Excel が更新されていれば（両方の版が分かっていて違えば）当てはまらない
    /// （更新で直っているかもしれないので、もう一度自動で試してよい）。どちらかが分からなければ、同じ Excel とみなす。
    /// </summary>
    private bool FailureApplies(ImageMsoFailureRecord record)
    {
        if (record.Method < ImageMsoFailureRecord.CurrentMethod)
        {
            return false;
        }

        var current = ImageMsoCache.NormalizeExcelVersion(SafeCurrentVersion());
        var recorded = ImageMsoCache.NormalizeExcelVersion(record.ExcelVersion);
        return current is null || recorded is null || string.Equals(current, recorded, StringComparison.Ordinal);
    }

    private string? SafeCurrentVersion()
    {
        try
        {
            return currentExcelVersion?.Invoke();
        }
        catch (Exception ex)
        {
            // 版が読めなくても状態は返す（版が分からないものとして扱う）
            log?.Invoke($"Excel の版を読めなかった: {ex.Message}");
            return null;
        }
    }

    private async Task RunAsync(List<string> names, List<int> sizes, bool force, IImageMsoBatchSource source, CancellationToken ct)
    {
        string? version = null;
        string? failure = null;
        string? message = null;
        var cancelled = false;
        try
        {
            // 取り込む分を先に決める（ここまでは Excel を起動しない）
            var work = sizes.Select(size => (Size: size, Names: force ? names : names.Where(n => !cache.IsKnown(n, size)).ToList())).ToList();
            lock (_gate)
            {
                _total = work.Sum(w => w.Names.Count);
            }

            Raise();
            version = ImageMsoCache.NormalizeExcelVersion(await source.BeginAsync(ct).ConfigureAwait(false));
            var found = 0;
            var gaveUp = false;
            foreach (var (size, list) in work)
            {
                lock (_gate)
                {
                    _size = size;
                }

                for (var i = 0; i < list.Count && !gaveUp; i += BatchSize)
                {
                    ct.ThrowIfCancellationRequested();
                    var chunk = list.GetRange(i, Math.Min(BatchSize, list.Count - i));
                    var results = await source.FetchAsync(chunk, size, ct).ConfigureAwait(false);
                    var failedNow = 0;
                    foreach (var r in results)
                    {
                        switch (r.Kind)
                        {
                            case ImageMsoFetchKind.Found when r.Png is { Length: > 0 }:
                                cache.Store(r.Name, size, r.Png);
                                found++;
                                break;
                            case ImageMsoFetchKind.Missing:
                                cache.MarkMissing(r.Name, size, persist: false);
                                break;
                            default:
                                failedNow++;
                                break;
                        }
                    }

                    cache.Flush();
                    int failedTotal;
                    lock (_gate)
                    {
                        _done += results.Count;
                        _failed += failedNow;
                        failedTotal = _failed;
                    }

                    Raise();
                    if (found == 0 && failedTotal >= GiveUpAfter)
                    {
                        gaveUp = true;
                    }

                    // まとまりの途中で中止されたときは、残りを処理しない
                    ct.ThrowIfCancellationRequested();
                }
            }

            if (gaveUp)
            {
                // 取り出し方そのものが動いていない。理由（VBA の Err.Number など）は取り出し口が最初の 1 回だけ app.log に書いている
                failure = L("Excel のアイコンを画像に変換できませんでした。詳しい理由は %AppData%\\Sash\\logs\\app.log に記録しました。",
                    "Could not convert Excel's icons to images. The details were written to %AppData%\\Sash\\logs\\app.log.");
                log?.Invoke($"imageMso の取り込みを打ち切り: {GiveUpAfter} 件以上続けて画像にできなかった");
                return;
            }

            int failedCount;
            lock (_gate)
            {
                failedCount = _failed;
            }

            var primary = sizes.Contains(ImageMsoCache.PrimarySize) ? ImageMsoCache.PrimarySize : sizes[0];
            cache.WriteManifest(new ImageMsoManifest(version, sizes, cache.ImageCount(primary), cache.MissingCount(primary), names.Count, DateTimeOffset.Now));
            cache.ClearFailure();
            // 実機で結果を確かめられるよう、失敗がなくても集計を残す
            log?.Invoke($"imageMso の取り込みを完了（今回 {found} 件を画像にした、画像にできなかったもの {failedCount} 件、キャッシュの画像 {cache.ImageCount(primary)} 件・存在しない名前 {cache.MissingCount(primary)} 件）");
            if (failedCount > 0)
            {
                message = L($"{failedCount} 件は画像にできませんでした。必要になったときに取り直します。", $"{failedCount} icons could not be converted. They will be retried when needed.");
            }
        }
        catch (OperationCanceledException)
        {
            cache.Flush();
            cancelled = true;
            message = L("取り込みを中止しました。取り込めた分は使えます。", "Import cancelled. The icons imported so far can be used.");
        }
        catch (Exception ex)
        {
            // Excel を起動できない、Excel が途中で終わった、など。理由を見せて、取り込めた分は残す
            cache.Flush();
            log?.Invoke($"imageMso の取り込みに失敗: {ex}");
            failure = L($"アイコンを取り込めませんでした：{ex.Message}", $"Could not import the icons: {ex.Message}");
        }
        finally
        {
            // BeginAsync が途中で失敗しても（Excel を起動した後の設定で例外が出たなど）、起動した Excel が残らないよう
            // 必ず後片付けを呼ぶ。起動していなければ後片付けは何もしない
            try
            {
                await source.EndAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                log?.Invoke($"imageMso の取り込みの後片付けに失敗: {ex}");
            }

            if (failure is not null)
            {
                // 失敗をファイルに残し、次の起動から同じ版の Excel では自動で始めない（設定画面からは始められる）
                cache.WriteFailure(new ImageMsoFailureRecord(ImageMsoCache.NormalizeExcelVersion(SafeCurrentVersion()) ?? version, DateTimeOffset.Now, failure, ImageMsoFailureRecord.CurrentMethod));
            }

            lock (_gate)
            {
                _running = false;
                _cancelled = cancelled;
                _failure = failure;
                _message = message;
            }

            Raise();
        }
    }

    private void Raise()
    {
        var handler = Changed;
        if (handler is null)
        {
            return;
        }

        try
        {
            handler(GetStatus());
        }
        catch (Exception ex)
        {
            // 知らせる側の失敗（画面がもう閉じているなど）で取り込みを止めない
            log?.Invoke($"imageMso の取り込みの進み具合を知らせられなかった: {ex.Message}");
        }
    }
}
