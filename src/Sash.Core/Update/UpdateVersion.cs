using System.Globalization;

namespace Sash.Core.Update;

/// <summary>
/// 版（1.2.3）。タグの v の有無や、前後の空白は無視する。比較は数値の大小で行う（1.10.0 &gt; 1.9.0）。
/// 「-beta」などの付いた版は、正式版と混ぜないよう解釈しない。
/// </summary>
public readonly record struct UpdateVersion(int Major, int Minor, int Patch) : IComparable<UpdateVersion>
{
    public static bool TryParse(string? text, out UpdateVersion version)
    {
        version = default;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var s = text.Trim();
        if (s.StartsWith('v') || s.StartsWith('V'))
        {
            s = s[1..];
        }

        // ビルド番号（1.2.3.0）は 4 つ目を無視する。アセンブリの版が 4 桁で来るため
        var parts = s.Split('.');
        if (parts.Length is < 2 or > 4)
        {
            return false;
        }

        var nums = new int[3];
        for (var i = 0; i < Math.Min(parts.Length, 3); i++)
        {
            if (!int.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out nums[i]))
            {
                return false;
            }
        }

        if (parts.Length == 4 && !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out _))
        {
            return false;
        }

        version = new UpdateVersion(nums[0], nums[1], nums[2]);
        return true;
    }

    public int CompareTo(UpdateVersion other) =>
        Major != other.Major ? Major.CompareTo(other.Major)
        : Minor != other.Minor ? Minor.CompareTo(other.Minor)
        : Patch.CompareTo(other.Patch);

    public static bool operator >(UpdateVersion a, UpdateVersion b) => a.CompareTo(b) > 0;

    public static bool operator <(UpdateVersion a, UpdateVersion b) => a.CompareTo(b) < 0;

    public static bool operator >=(UpdateVersion a, UpdateVersion b) => a.CompareTo(b) >= 0;

    public static bool operator <=(UpdateVersion a, UpdateVersion b) => a.CompareTo(b) <= 0;

    public override string ToString() => $"{Major}.{Minor}.{Patch}";
}
