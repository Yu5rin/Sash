using Sash.Core.Localization;
using Sash.Core.Settings;

namespace Sash.App;

/// <summary>設定の言語を、ホスト側のメッセージにも反映する。</summary>
internal static class SettingsLanguage
{
    public static AppSettings Apply(AppSettings settings)
    {
        Text.Language = settings.Language;
        return settings;
    }
}
