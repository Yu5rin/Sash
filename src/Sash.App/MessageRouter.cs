using System.Text.Json;
using Sash.Core.CustomUI;
using Sash.Core.Packaging;
using Sash.Excel;

namespace Sash.App;

/// <summary>UI からの要求を種類ごとに処理する。</summary>
internal sealed class MessageRouter(IWin32Window owner)
{
    public async Task<HostResponse> HandleAsync(HostRequest request)
    {
        try
        {
            object? payload = request.Type switch
            {
                "app.info" => GetAppInfo(),
                "file.open" => await OpenFileAsync(request.Payload),
                "file.save" => SaveFile(request.Payload),
                _ => throw new InvalidOperationException($"不明な要求です：{request.Type}"),
            };
            return new HostResponse(request.Id, true, payload, null);
        }
        catch (Exception ex)
        {
            return new HostResponse(request.Id, false, null, ex.Message);
        }
    }

    private static object GetAppInfo() => new
    {
        version = typeof(MessageRouter).Assembly.GetName().Version?.ToString(3),
        excelInstalled = ExcelEnvironment.IsInstalled,
    };

    /// <summary>パスが渡されなければファイルダイアログを出す。キャンセル時は null を返す。</summary>
    private Task<object?> OpenFileAsync(JsonElement? payload)
    {
        var path = payload?.TryGetProperty("path", out var p) == true ? p.GetString() : null;
        if (string.IsNullOrEmpty(path))
        {
            using var dialog = new OpenFileDialog
            {
                Filter = "Excel マクロブック / アドイン (*.xlsm;*.xlam)|*.xlsm;*.xlam",
                Title = "リボンを編集するブックを開く",
            };
            if (dialog.ShowDialog(owner) != DialogResult.OK)
            {
                return Task.FromResult<object?>(null);
            }

            path = dialog.FileName;
        }

        if (!RibbonPackage.IsSupported(path))
        {
            throw new InvalidOperationException(".xlsm / .xlam のみ開けます。");
        }

        var doc = RibbonPackage.Load(path);
        return Task.FromResult<object?>(new
        {
            path = doc.Path,
            hasBothVersions = doc.HasBothVersions,
            parts = doc.Parts.Select(part => new
            {
                version = part.Version,
                partUri = part.PartUri.ToString(),
                xml = part.Xml,
                images = part.Images.Select(i => new { id = i.RelationshipId, partUri = i.PartUri.ToString() }),
            }),
        });
    }

    private static object SaveFile(JsonElement? payload)
    {
        if (payload is not { } body)
        {
            throw new InvalidOperationException("保存内容がありません。");
        }

        var path = body.GetProperty("path").GetString() ?? throw new InvalidOperationException("path がありません。");
        var xml = body.GetProperty("xml").GetString() ?? throw new InvalidOperationException("xml がありません。");
        var version = body.GetProperty("version").Deserialize<CustomUIVersion>(HostJson.Options);

        var backup = new BackupService(AppPaths.Backups).Backup(path);
        RibbonPackage.SaveCustomUI(path, version, xml);
        return new { backup };
    }
}
