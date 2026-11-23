namespace Sash.App;

/// <summary>
/// 想定していない失敗の記録（%AppData%\Sash\logs\app.log）。利用者から「落ちた」と言われたときの手がかりにする。
/// 記録そのものの失敗でアプリを止めないよう、書けなければ黙って諦める。
/// </summary>
internal static class AppLog
{
    private static readonly Lock Gate = new();

    public static string FilePath => Path.Combine(AppPaths.Root, "logs", "app.log");

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                // 大きくなりすぎないよう、1MB を超えたら作り直す
                if (File.Exists(FilePath) && new FileInfo(FilePath).Length > 1_000_000)
                {
                    File.Delete(FilePath);
                }

                File.AppendAllText(FilePath, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    public static void Write(string context, Exception ex) => Write($"{context}: {ex}");
}
