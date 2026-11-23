using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using static Sash.Core.Localization.Text;

namespace Sash.Core.Packaging;

/// <summary>バックアップ 1 つ分の情報。</summary>
/// <param name="Path">バックアップのファイルのフルパス。</param>
/// <param name="CreatedAt">バックアップを取った日時（ファイル名の日時。読めなければファイルの更新日時）。</param>
/// <param name="Size">バイト数。</param>
public sealed record BackupEntry(string Path, DateTimeOffset CreatedAt, long Size);

/// <summary>
/// 保存前に元のファイルを世代つきでバックアップする（仕様書 §5.1、既定は 10 世代）。
/// バックアップ先は <c>&lt;バックアップフォルダ&gt;/&lt;ファイル名&gt;_&lt;フルパスの短いハッシュ&gt;/&lt;日時&gt;_&lt;ファイル名&gt;</c>。
/// フォルダ名にフルパスのハッシュを入れるのは、別のフォルダにある同じ名前のブック（Book1.xlsm など）の
/// バックアップが混ざり、互いの世代を消し合わないようにするため。元のフルパスは source.txt に書いておく。
/// </summary>
public sealed class BackupService
{
    public const int DefaultGenerations = 10;

    /// <summary>フォルダに置く、元のファイルのフルパスを書いたファイル。</summary>
    public const string SourceFileName = "source.txt";

    private const string StampFormat = "yyyyMMdd-HHmmss-fff";

    private readonly string _root;
    private readonly int _generations;
    private readonly TimeProvider _time;

    public BackupService(string root, int generations = DefaultGenerations, TimeProvider? time = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        ArgumentOutOfRangeException.ThrowIfLessThan(generations, 1);
        _root = root;
        _generations = generations;
        _time = time ?? TimeProvider.System;
    }

    /// <summary>そのファイルのバックアップを置くフォルダ。</summary>
    public string FolderOf(string path)
    {
        var fullPath = System.IO.Path.GetFullPath(path);
        return System.IO.Path.Combine(_root, $"{System.IO.Path.GetFileName(fullPath)}_{PathHash(fullPath)}");
    }

    /// <summary>
    /// ファイルをバックアップし、古い世代を削除する。作ったバックアップのパスを返す。
    /// 中身がいちばん新しいバックアップと同じなら新しくは作らず、そのパスを返す
    /// （書き込みのやり直しなどで同じ中身が何世代も並び、本当に戻したい古い世代が押し出されて消えるのを防ぐため）。
    /// </summary>
    public string Backup(string path)
    {
        var fullPath = System.IO.Path.GetFullPath(path);
        var fileName = System.IO.Path.GetFileName(fullPath);
        var dir = FolderOf(fullPath);
        Directory.CreateDirectory(dir);
        WriteSourceNote(dir, fullPath);

        var newest = Files(dir, fileName).FirstOrDefault();
        if (newest is not null && SameContent(newest, fullPath))
        {
            return newest;
        }

        var stamp = _time.GetLocalNow().ToString(StampFormat, CultureInfo.InvariantCulture);
        var dest = System.IO.Path.Combine(dir, $"{stamp}_{fileName}");
        // 同じミリ秒に 2 回取ったときは英字を足して別名にする（「_」より後ろの文字なので、新しい順の並びも崩れない）
        for (var c = 'a'; File.Exists(dest) && c <= 'z'; c++)
        {
            dest = System.IO.Path.Combine(dir, $"{stamp}{c}_{fileName}");
        }

        File.Copy(fullPath, dest, overwrite: false);
        // 読み取り専用のブックを写すと属性も付いてくる。そのままでは古い世代を消せないので外す
        File.SetAttributes(dest, File.GetAttributes(dest) & ~FileAttributes.ReadOnly);

        Prune(dir, fileName);
        return dest;
    }

    /// <summary>指定ファイルのバックアップを新しい順に返す。</summary>
    public IReadOnlyList<string> List(string path)
    {
        var fullPath = System.IO.Path.GetFullPath(path);
        var dir = FolderOf(fullPath);
        return Directory.Exists(dir) ? Files(dir, System.IO.Path.GetFileName(fullPath)) : [];
    }

    /// <summary>指定ファイルのバックアップを、日時と大きさつきで新しい順に返す。</summary>
    public IReadOnlyList<BackupEntry> ListEntries(string path) =>
        List(path).Select(p =>
        {
            var info = new FileInfo(p);
            return new BackupEntry(p, StampOf(p) ?? new DateTimeOffset(info.LastWriteTime), info.Length);
        }).ToList();

    /// <summary>backupPath が targetPath のバックアップのフォルダの中にあるバックアップか。</summary>
    public bool IsBackupOf(string backupPath, string targetPath)
    {
        string full;
        try
        {
            full = System.IO.Path.GetFullPath(backupPath);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }

        // List と同じ一覧に入っているものだけを認める（フォルダの外や source.txt などを指されても戻さない）
        return List(targetPath).Contains(full, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// バックアップから元に戻す。戻す前に、今のファイルもバックアップしておく（戻したことも取り消せるように）。
    /// 今のファイルのバックアップのパスを返す（今のファイルがなければ null）。
    /// </summary>
    public string? Restore(string backupPath, string targetPath)
    {
        var target = System.IO.Path.GetFullPath(targetPath);
        if (!IsBackupOf(backupPath, target))
        {
            throw new UserFacingException(L("指定されたファイルは、このブックのバックアップではありません。", "The specified file is not a backup of this workbook."));
        }

        if (File.Exists(target) && new FileInfo(target).IsReadOnly)
        {
            throw new UserFacingException(L($"読み取り専用のファイルのため戻せません：{target}", $"The file is read-only and cannot be restored: {target}"));
        }

        // 先に、戻す中身を書き込み先と同じフォルダの一時ファイルへ写しておく。
        // 今のファイルをバックアップすると古い世代が消えることがあり、戻したい世代そのものが消えうるため
        var temp = target + "." + Guid.NewGuid().ToString("N") + ".sash-tmp";
        File.Copy(System.IO.Path.GetFullPath(backupPath), temp, overwrite: false);
        try
        {
            File.SetAttributes(temp, File.GetAttributes(temp) & ~FileAttributes.ReadOnly);
            var current = File.Exists(target) ? Backup(target) : null;
            File.Move(temp, target, overwrite: true);
            return current;
        }
        finally
        {
            TryDelete(temp);
        }
    }

    private static List<string> Files(string dir, string fileName) =>
        Directory.GetFiles(dir, $"*_{fileName}")
            .OrderDescending(StringComparer.Ordinal)
            .ToList();

    private void Prune(string dir, string fileName)
    {
        foreach (var old in Files(dir, fileName).Skip(_generations))
        {
            File.Delete(old);
        }
    }

    /// <summary>フルパスの短いハッシュ。Windows のパスは大文字と小文字を区別しないので、そろえてから計算する。</summary>
    internal static string PathHash(string fullPath)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(fullPath.ToUpperInvariant()));
        return Convert.ToHexStringLower(bytes)[..8];
    }

    private static void WriteSourceNote(string dir, string fullPath)
    {
        var note = System.IO.Path.Combine(dir, SourceFileName);
        if (File.Exists(note))
        {
            return;
        }

        try
        {
            File.WriteAllText(note, fullPath + Environment.NewLine, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 説明のためのファイルなので、書けなくてもバックアップは続ける
        }
    }

    private static bool SameContent(string a, string b)
    {
        try
        {
            if (new FileInfo(a).Length != new FileInfo(b).Length)
            {
                return false;
            }

            return HashOf(a).AsSpan().SequenceEqual(HashOf(b));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 比べられなければ、念のため新しく取る
            return false;
        }
    }

    private static byte[] HashOf(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return SHA256.HashData(fs);
    }

    private static DateTimeOffset? StampOf(string backupPath)
    {
        var name = System.IO.Path.GetFileName(backupPath);
        if (name.Length < StampFormat.Length)
        {
            return null;
        }

        return DateTime.TryParseExact(name[..StampFormat.Length], StampFormat, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var t)
            ? new DateTimeOffset(t)
            : null;
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
