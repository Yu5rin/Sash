using System.Text.Json;

namespace Sash.Core.Update;

/// <summary>
/// 管理者が exe の横に置く設定ファイル（Sash.update.json）。会社でまとめて配るときに、
/// 更新の確認先を社内の共有フォルダなどに固定するために使う。ここで決めた項目は、利用者の設定より優先する。
/// 例：{ "source": "\\\\fileserver\\tools\\Sash", "checkOnStartup": true }
/// </summary>
public sealed record UpdatePolicy(string? Source, bool? CheckOnStartup, bool Disabled)
{
    public const string FileName = "Sash.update.json";

    public static UpdatePolicy? Load(string exeDirectory)
    {
        var path = Path.Combine(exeDirectory, FileName);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object)
            {
                // { … } でないもの（配列や文字列だけ）は書き間違い。壊れているときと同じく安全側に倒して止める
                return new UpdatePolicy(null, false, true);
            }

            string? source = r.TryGetProperty("source", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
            bool? check = r.TryGetProperty("checkOnStartup", out var c) && c.ValueKind is JsonValueKind.True or JsonValueKind.False ? c.GetBoolean() : null;
            var disabled = r.TryGetProperty("disabled", out var d) && d.ValueKind == JsonValueKind.True;
            return new UpdatePolicy(source, check, disabled);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            // 壊れていたら、更新を止めて理由を出す（意図しない確認先へ行かないよう、安全側に倒す）
            return new UpdatePolicy(null, false, true);
        }
    }
}
