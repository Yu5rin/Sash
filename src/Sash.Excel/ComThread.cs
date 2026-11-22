using System.Collections.Concurrent;
using System.Runtime.Versioning;

namespace Sash.Excel;

/// <summary>
/// Excel の COM 呼び出しを、専用の STA スレッドで順番に実行する。
/// UI スレッドを止めず、COM オブジェクトを作ったスレッドとは別のスレッドから触る事故も防ぐ。
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ComThread : IDisposable
{
    private readonly BlockingCollection<Action> _queue = new();
    private readonly Thread _thread;

    public ComThread()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "Sash.Excel.COM" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    private void Run()
    {
        foreach (var action in _queue.GetConsumingEnumerable())
        {
            action();
        }
    }

    public Task<T> InvokeAsync<T>(Func<T> func)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _queue.Add(() =>
        {
            try
            {
                tcs.SetResult(func());
            }
            catch (Exception ex)
            {
                tcs.SetException(ex);
            }
        });
        return tcs.Task;
    }

    public void Dispose()
    {
        _queue.CompleteAdding();
        _thread.Join(TimeSpan.FromSeconds(5));
        _queue.Dispose();
    }
}
