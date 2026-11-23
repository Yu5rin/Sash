using static Sash.Core.Localization.Text;

namespace Sash.Core.Settings;

/// <summary>
/// 設定やレシピの JSON ファイルを、消してしまわないように読み書きするための共通処理。
/// 読むだけのときは失敗しても既定値で続けてよいが、「読んで → 変えて → 書く」ときに読み損ねたまま書くと、
/// 一時的に開けなかっただけ（ウイルス対策ソフトや同期ソフトが掴んでいる）のファイルを既定値で上書きしてしまう。
/// </summary>
internal static class JsonFile
{
    private const int ReadAttempts = 5;
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(100);

    /// <summary>ファイルの中身を読む。ないときは null。一時的な IOException は数回やり直し、それでも読めなければ投げる。</summary>
    public static string? ReadText(string path)
    {
        for (var i = 1; ; i++)
        {
            try
            {
                return File.Exists(path) ? File.ReadAllText(path) : null;
            }
            catch (IOException) when (i < ReadAttempts)
            {
                Thread.Sleep(RetryDelay);
            }
        }
    }

    /// <summary>書き換えの前に読む。読めないときは、上書きしないよう利用者向けの例外にして投げる。</summary>
    public static string? ReadTextForUpdate(string path)
    {
        try
        {
            return ReadText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new UserFacingException(L($"ファイルを読み込めないため、変更を保存しませんでした。しばらくしてからやり直してください：{path}（{ex.Message}）", $"The changes were not saved because the file could not be read. Please try again later: {path} ({ex.Message})"), ex);
        }
    }

    /// <summary>壊れたファイルを「名前.bak」（あれば「名前.1.bak」…）へ退避する。既定値で上書きしても中身を失わないようにするため。</summary>
    public static string? MoveAside(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var dest = path + ".bak";
        for (var n = 1; File.Exists(dest); n++)
        {
            dest = n <= 100 ? $"{path}.{n}.bak" : $"{path}.{Guid.NewGuid():N}.bak";
        }

        File.Move(path, dest);
        return dest;
    }

    /// <summary>同じフォルダの一時ファイルに書いてから置き換える。一時ファイルの名前は毎回変える（同時に書いても取り合わないように）。</summary>
    public static void WriteAtomic(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temp, content);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            try
            {
                if (File.Exists(temp))
                {
                    File.Delete(temp);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }
}
