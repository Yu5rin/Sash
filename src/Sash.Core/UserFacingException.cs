namespace Sash.Core;

/// <summary>
/// 利用者に見せるために書いたメッセージを持つ例外。
/// ホストは内側の例外（IOException など）の英語の技術的な文言より、こちらの文言を優先して画面に出す。
/// </summary>
public class UserFacingException : Exception
{
    public UserFacingException()
    {
    }

    public UserFacingException(string message)
        : base(message)
    {
    }

    public UserFacingException(string message, Exception? innerException)
        : base(message, innerException)
    {
    }
}
