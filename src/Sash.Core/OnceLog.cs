namespace Sash.Core;

/// <summary>
/// 同じ理由の記録を 1 回だけ書く。数千件のアイコンを取り込むとき、失敗のたびにログへ書くと
/// ログがすぐ上限に達して肝心の最初の失敗が消えてしまうので、理由（key）ごとに最初の 1 回だけ残す。
/// </summary>
public sealed class OnceLog(Action<string>? write)
{
    private readonly Lock _lock = new();
    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);

    /// <summary>key で初めての記録なら書いて true を返す。</summary>
    public bool Write(string key, string message)
    {
        lock (_lock)
        {
            if (!_seen.Add(key))
            {
                return false;
            }
        }

        try
        {
            write?.Invoke(message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            // 記録の失敗で本来の処理を止めない
        }

        return true;
    }
}
