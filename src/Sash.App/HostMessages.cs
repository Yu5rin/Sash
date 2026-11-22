using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sash.App;

/// <summary>UI からホストへの要求。ui/src/bridge.ts の型と対応させる。</summary>
internal sealed record HostRequest(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("payload")] JsonElement? Payload);

/// <summary>ホストから UI への応答。</summary>
internal sealed record HostResponse(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("payload")] object? Payload,
    [property: JsonPropertyName("error")] string? Error);

internal static class HostJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };
}
