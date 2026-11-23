using Sash.Core.Update;
using static Sash.Core.Localization.Text;

namespace Sash.App;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // 前回の更新で退避した古い exe を片付ける
        if (Environment.ProcessPath is { } exe)
        {
            ExecutableReplacer.CleanupLeftovers(exe);
        }

        // 引数：開くファイル、または更新直後の印（--updated-from 1.2.3）
        string? file = null;
        string? updatedFrom = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--updated-from" && i + 1 < args.Length)
            {
                updatedFrom = args[++i];
            }
            else if (!args[i].StartsWith("--", StringComparison.Ordinal))
            {
                file ??= args[i];
            }
        }

        // 想定していない例外で黙って落ちないよう、記録してから知らせる。
        // UI スレッドの例外（async void のイベント処理を含む）は ThreadException に来るので、続けて使えるようにする
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) =>
        {
            AppLog.Write("UI スレッドの例外", e.Exception);
            ShowError(e.Exception);
        };

        // ほかのスレッドの例外は、ここに来た時点でプロセスが終わる。記録だけは残す
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception ex)
            {
                AppLog.Write("処理されなかった例外", ex);
                ShowError(ex);
            }
        };

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(file, updatedFrom));
    }

    private static void ShowError(Exception ex)
    {
        try
        {
            MessageBox.Show(
                L($"予期しないエラーが起きました：{ex.Message}\n\n詳しい内容は {AppLog.FilePath} に記録しました。", $"An unexpected error occurred: {ex.Message}\n\nDetails were written to {AppLog.FilePath}."),
                "Sash", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch (Exception showError) when (showError is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // メッセージを出せない状況（終了処理中など）では記録だけにとどめる
        }
    }
}
