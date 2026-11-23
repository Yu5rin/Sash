using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using static Sash.Core.Localization.Text;

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
    private volatile bool _disposed;

    public ComThread()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "Sash.Excel.COM" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    private void Run()
    {
        // Excel がセルの編集中などで呼び出しを断ったとき（RPC_E_CALL_REJECTED）に、すぐ失敗せず少し待ってやり直すようにする
        var registered = MessageFilter.Register();
        try
        {
            foreach (var action in _queue.GetConsumingEnumerable())
            {
                action();

                // dynamic で触った COM オブジェクト（Workbooks、Item(i) の戻り値など）は、どこにも変数が残らない RCW として
                // 作られ、Release できない。GC に回収させないと Excel への参照が残り、Excel が終わらない・ファイルのロックが
                // 外れないことがある。ファイナライザーが RCW を解放した後にもう一段の参照が外れるので、2 回続けて行う
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
        }
        finally
        {
            if (registered)
            {
                MessageFilter.Revoke();
            }
        }
    }

    public Task<T> InvokeAsync<T>(Func<T> func)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (_disposed)
        {
            return Task.FromException<T>(new ObjectDisposedException(nameof(ComThread), L("Excel との連携は終了しています。", "The Excel connection has been closed.")));
        }

        try
        {
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
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            // 終了処理と行き違いになったとき。呼び出し側では例外として受け取れるようにする
            return Task.FromException<T>(new ObjectDisposedException(nameof(ComThread), L("Excel との連携は終了しています。", "The Excel connection has been closed.")));
        }

        return tcs.Task;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _queue.CompleteAdding();

        // Excel が応答せず処理が終わらないときは、キューを破棄しない（実行中の処理がキューに触れて落ちないように）。
        // スレッドはバックグラウンドなので、アプリの終了とともに終わる
        if (_thread.Join(TimeSpan.FromSeconds(5)))
        {
            _queue.Dispose();
        }
    }
}

/// <summary>
/// OLE のメッセージ フィルター。Excel が忙しいとき（セルの編集中、ダイアログの表示中など）の呼び出しは
/// 既定では即座に RPC_E_CALL_REJECTED（0x80010001）で失敗する。ここで「少し待ってやり直す」と答え、
/// 約 10 秒まで待つ。STA スレッドごとに登録が必要なので、COM 専用スレッドの開始時に登録する。
/// </summary>
[SupportedOSPlatform("windows")]
[ComVisible(true)]
internal sealed class MessageFilter : IOleMessageFilter
{
    private const int ServerCallIsHandled = 0;
    private const int PendingMsgWaitDefProcess = 2;
    private const int RetryIntervalMs = 100;
    private const int GiveUpAfterMs = 10_000;

    public static bool Register()
    {
        try
        {
            return CoRegisterMessageFilter(new MessageFilter(), out _) == 0;
        }
        catch (Exception ex) when (ex is COMException or EntryPointNotFoundException or DllNotFoundException)
        {
            // 登録できなくても、忙しいときにすぐ失敗するだけで動作はする
            return false;
        }
    }

    public static void Revoke()
    {
        try
        {
            CoRegisterMessageFilter(null, out _);
        }
        catch (Exception ex) when (ex is COMException or EntryPointNotFoundException or DllNotFoundException)
        {
        }
    }

    public int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo) => ServerCallIsHandled;

    // 断られた呼び出し（RETRYLATER も REJECTED も）を、100ms 後にやり直す。10 秒を超えたら -1 を返してあきらめる
    public int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType) =>
        dwTickCount < GiveUpAfterMs ? RetryIntervalMs : -1;

    public int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType) => PendingMsgWaitDefProcess;

    [DllImport("ole32.dll")]
    private static extern int CoRegisterMessageFilter(IOleMessageFilter? newFilter, out IOleMessageFilter? oldFilter);
}

[ComVisible(true)]
[ComImport]
[Guid("00000016-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOleMessageFilter
{
    [PreserveSig]
    int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo);

    [PreserveSig]
    int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType);

    [PreserveSig]
    int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType);
}
