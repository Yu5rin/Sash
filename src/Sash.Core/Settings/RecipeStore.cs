using System.Text.Json;
using System.Text.Json.Nodes;
using static Sash.Core.Localization.Text;

namespace Sash.Core.Settings;

/// <summary>
/// 利用者が保存したレシピ（仕様書 §9.2）。中身の形は UI が決めるので、ここでは id を持つ JSON オブジェクトとして扱う。
/// 一覧を読むだけのときは読めなければ空として扱うが、保存・削除のときは読めなければ中止する
/// （一時的に読めなかっただけのファイルを、空の一覧で上書きして消さないため）。
/// </summary>
public sealed class RecipeStore(string path)
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly Lock _lock = new();

    public IReadOnlyList<JsonObject> List()
    {
        lock (_lock)
        {
            try
            {
                var text = JsonFile.ReadText(path);
                return text is null ? [] : Parse(text) ?? [];
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                return [];
            }
        }
    }

    /// <summary>同じ id があれば置き換え、なければ末尾に追加する。</summary>
    public void Save(JsonObject recipe)
    {
        ArgumentNullException.ThrowIfNull(recipe);
        var id = IdOf(recipe) ?? throw UserErrors.Argument(L("レシピに id がありません。", "The recipe has no id."), nameof(recipe));
        lock (_lock)
        {
            Write(ListForUpdate().Where(r => IdOf(r) != id).Append(recipe));
        }
    }

    public void Delete(string id)
    {
        lock (_lock)
        {
            Write(ListForUpdate().Where(r => IdOf(r) != id));
        }
    }

    private static string? IdOf(JsonObject r) =>
        r["id"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>配列でなければ null（壊れている扱い）。</summary>
    private static List<JsonObject>? Parse(string text) =>
        JsonNode.Parse(text) is JsonArray arr ? arr.OfType<JsonObject>().Select(o => (JsonObject)o.DeepClone()).ToList() : null;

    private List<JsonObject> ListForUpdate()
    {
        var text = JsonFile.ReadTextForUpdate(path);
        if (text is null)
        {
            return [];
        }

        List<JsonObject>? list;
        try
        {
            list = Parse(text);
        }
        catch (JsonException)
        {
            list = null;
        }

        if (list is null)
        {
            // 壊れたファイルは消さずに .bak へ退避してから、空の一覧として書き直す
            JsonFile.MoveAside(path);
            return [];
        }

        return list;
    }

    private void Write(IEnumerable<JsonObject> recipes)
    {
        var arr = new JsonArray(recipes.Select(r => (JsonNode)r.DeepClone()).ToArray());
        JsonFile.WriteAtomic(path, arr.ToJsonString(Json));
    }
}
