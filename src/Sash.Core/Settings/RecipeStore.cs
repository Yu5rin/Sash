using System.Text.Json;
using System.Text.Json.Nodes;

namespace Sash.Core.Settings;

/// <summary>
/// 利用者が保存したレシピ（仕様書 §9.2）。中身の形は UI が決めるので、ここでは id を持つ JSON オブジェクトとして扱う。
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
                if (!File.Exists(path))
                {
                    return [];
                }

                return JsonNode.Parse(File.ReadAllText(path)) is JsonArray arr ? arr.OfType<JsonObject>().Select(o => (JsonObject)o.DeepClone()).ToList() : [];
            }
            catch (Exception ex) when (ex is JsonException or IOException)
            {
                return [];
            }
        }
    }

    /// <summary>同じ id があれば置き換え、なければ末尾に追加する。</summary>
    public void Save(JsonObject recipe)
    {
        var id = recipe["id"]?.GetValue<string>() ?? throw new ArgumentException("レシピに id がありません。", nameof(recipe));
        Write(List().Where(r => r["id"]?.GetValue<string>() != id).Append(recipe));
    }

    public void Delete(string id) => Write(List().Where(r => r["id"]?.GetValue<string>() != id));

    private void Write(IEnumerable<JsonObject> recipes)
    {
        lock (_lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var arr = new JsonArray(recipes.Select(r => (JsonNode)r.DeepClone()).ToArray());
            var temp = path + ".tmp";
            File.WriteAllText(temp, arr.ToJsonString(Json));
            File.Move(temp, path, overwrite: true);
        }
    }
}
