namespace Sash.Core;

/// <summary>
/// 利用者に見せるために文言を書いた ArgumentException・FormatException に印を付ける。
/// 例外の型は変えない（呼び出し側の catch・テストが型で受けているため）。印だけで、ホストが
/// 「.NET の英語の文」と区別して画面に出せるようにする（ホストの MessageRouter.DescribeError が見る）。
/// </summary>
public static class UserErrors
{
    private const string Key = "Sash.UserFacing";

    /// <summary>利用者向けの文言を持つ ArgumentException。</summary>
    /// <remarks>引数名は渡さない（渡すと Message に「 (Parameter 'id')」の英語が付いて画面に出るため）。</remarks>
    public static ArgumentException Argument(string message) => Mark(new ArgumentException(message));

    /// <summary>利用者向けの文言を持つ FormatException。</summary>
    public static FormatException Format(string message, Exception? inner = null) => Mark(new FormatException(message, inner));

    /// <summary>印を付ける。</summary>
    public static T Mark<T>(T ex) where T : Exception
    {
        ex.Data[Key] = true;
        return ex;
    }

    /// <summary>利用者向けの文言を持つ例外か（<see cref="UserFacingException"/> か、印のある例外）。</summary>
    public static bool IsUserFacing(Exception ex) => ex is UserFacingException || ex.Data.Contains(Key);
}
