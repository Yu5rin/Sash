using static Sash.Core.Localization.Text;

namespace Sash.Core.Update;

/// <summary>
/// 実行中の exe を新しい版に入れ替える。Windows では実行中のファイルは上書きできないが、名前は変えられる。
/// そこで「今の exe を .old に退避 → 新しい exe を本来の名前で置く」の順で行い、途中で失敗したら .old を戻す。
/// .old は次の起動で消す（Graft・Pane と同じ方式）。
/// </summary>
public static class ExecutableReplacer
{
    public const string BackupSuffix = ".old";

    /// <summary>入れ替える。失敗したら元の状態に戻してから例外を投げる。</summary>
    public static void Replace(string currentExe, string newExe)
    {
        var backup = currentExe + BackupSuffix;
        if (File.Exists(backup))
        {
            File.Delete(backup);
        }

        File.Move(currentExe, backup);
        try
        {
            File.Copy(newExe, currentExe, overwrite: false);
        }
        catch (Exception ex)
        {
            // 途中まで書かれたファイルを消し、退避した元の exe を戻す。消せなくても（ウイルス対策ソフトが掴んでいるなど）戻すことは必ず試す
            try
            {
                if (File.Exists(currentExe))
                {
                    File.Delete(currentExe);
                }
            }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException)
            {
            }

            try
            {
                File.Move(backup, currentExe);
            }
            catch (Exception restore) when (restore is IOException or UnauthorizedAccessException)
            {
                // 戻せなかったときは、元の exe がどこに残っているかを伝える（利用者が手で名前を戻せるように）
                throw new IOException(L(
                    $"更新の入れ替えに失敗し、元に戻すこともできませんでした。元の版は {backup} に残っています。名前を {Path.GetFileName(currentExe)} に戻してください。（{ex.Message} / {restore.Message}）",
                    $"Replacing the executable failed, and it could not be restored. The previous version remains at {backup}. Rename it back to {Path.GetFileName(currentExe)}. ({ex.Message} / {restore.Message})"), ex);
            }

            throw;
        }
    }

    /// <summary>前回の更新で残った .old を消す。まだ使われていて消せなければ、次の機会に回す。</summary>
    public static void CleanupLeftovers(string currentExe)
    {
        var backup = currentExe + BackupSuffix;
        try
        {
            if (File.Exists(backup))
            {
                File.Delete(backup);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>exe のフォルダに書き込めるか（Program Files などでは自分では入れ替えられない）。</summary>
    public static bool CanWriteTo(string directory)
    {
        try
        {
            var probe = Path.Combine(directory, $".sash-write-test-{Guid.NewGuid():N}");
            File.WriteAllBytes(probe, []);
            File.Delete(probe);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
