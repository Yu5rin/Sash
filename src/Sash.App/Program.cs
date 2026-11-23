using Sash.Core.Update;

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

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(file, updatedFrom));
    }
}
