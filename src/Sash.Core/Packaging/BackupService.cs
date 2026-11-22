namespace Sash.Core.Packaging;

/// <summary>
/// 保存前に元のファイルを世代つきでバックアップする（仕様書 §5.1、既定は 10 世代）。
/// バックアップ先は <c>&lt;バックアップフォルダ&gt;/&lt;ファイル名&gt;/&lt;日時&gt;_&lt;ファイル名&gt;</c>。
/// </summary>
public sealed class BackupService
{
    public const int DefaultGenerations = 10;

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

    /// <summary>ファイルをバックアップし、古い世代を削除する。作ったバックアップのパスを返す。</summary>
    public string Backup(string path)
    {
        var fileName = Path.GetFileName(path);
        var dir = Path.Combine(_root, fileName);
        Directory.CreateDirectory(dir);

        var stamp = _time.GetLocalNow().ToString("yyyyMMdd-HHmmss-fff");
        var dest = Path.Combine(dir, $"{stamp}_{fileName}");
        File.Copy(path, dest, overwrite: false);

        Prune(dir, fileName);
        return dest;
    }

    /// <summary>指定ファイルのバックアップを新しい順に返す。</summary>
    public IReadOnlyList<string> List(string path)
    {
        var fileName = Path.GetFileName(path);
        var dir = Path.Combine(_root, fileName);
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory.GetFiles(dir, $"*_{fileName}")
            .OrderDescending(StringComparer.Ordinal)
            .ToList();
    }

    private void Prune(string dir, string fileName)
    {
        foreach (var old in Directory.GetFiles(dir, $"*_{fileName}")
                     .OrderDescending(StringComparer.Ordinal)
                     .Skip(_generations))
        {
            File.Delete(old);
        }
    }
}
