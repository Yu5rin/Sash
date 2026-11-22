using System.Runtime.Versioning;
using System.Text.Json;
using Sash.Core.CustomUI;
using Sash.Core.Packaging;
using Sash.Core.Settings;
using Sash.Excel;

namespace Sash.App;

/// <summary>UI からの要求を種類ごとに処理する。要求と応答の型は ui/src/bridge.ts と対応させる。</summary>
[SupportedOSPlatform("windows")]
internal sealed class MessageRouter(IWin32Window owner, SettingsStore settings, Lazy<ExcelService> excel, Action closeWindow)
{
    private static readonly bool ExcelInstalled = ExcelService.IsInstalled;

    public async Task<HostResponse> HandleAsync(HostRequest request)
    {
        try
        {
            var body = request.Payload is { ValueKind: not JsonValueKind.Null } p ? p : (JsonElement?)null;
            object? payload = request.Type switch
            {
                "app.info" => GetAppInfo(),
                "app.close" => Close(),
                "file.open" => OpenFile(body),
                "file.save" => SaveFile(Read<SaveRequest>(body)),
                "file.recent" => RecentFiles(),
                "file.removeRecent" => RemoveRecent(Read<PathRequest>(body)),
                "settings.get" => ToDto(settings.Load()),
                "settings.set" => SetSettings(Read<SettingsDto>(body)),
                "excel.openWorkbooks" => ExcelInstalled ? await excel.Value.ListOpenWorkbooksAsync() : [],
                "excel.apply" => await ApplyAsync(Read<ApplyRequest>(body)),
                "excel.imageMso" => await ImageMsoAsync(Read<ImageMsoRequest>(body)),
                "excel.labels" => ExcelInstalled ? await excel.Value.GetLabelsAsync(Read<LabelsRequest>(body).Ids) : new Dictionary<string, string>(),
                _ => throw new InvalidOperationException($"不明な要求です：{request.Type}"),
            };
            return new HostResponse(request.Id, true, payload, null);
        }
        catch (Exception ex)
        {
            return new HostResponse(request.Id, false, null, ex.InnerException is IOException io ? io.Message : ex.Message);
        }
    }

    private static T Read<T>(JsonElement? body) =>
        body is { } b ? b.Deserialize<T>(HostJson.Options) ?? throw new InvalidOperationException("要求の内容が空です。") : throw new InvalidOperationException("要求の内容が空です。");

    private static object GetAppInfo() => new
    {
        version = typeof(MessageRouter).Assembly.GetName().Version?.ToString(3),
        excelInstalled = ExcelInstalled,
    };

    private object? Close()
    {
        closeWindow();
        return null;
    }

    // ---- ファイル ----

    /// <summary>パスが渡されなければファイルダイアログを出す。キャンセル時は null を返す。</summary>
    private object? OpenFile(JsonElement? body)
    {
        var path = body?.TryGetProperty("path", out var p) == true ? p.GetString() : null;
        if (string.IsNullOrEmpty(path))
        {
            using var dialog = new OpenFileDialog
            {
                Filter = "Excel マクロブック / アドイン (*.xlsm;*.xlam)|*.xlsm;*.xlam",
                Title = "リボンを編集するブックを開く",
            };
            if (dialog.ShowDialog(owner) != DialogResult.OK)
            {
                return null;
            }

            path = dialog.FileName;
        }

        return Open(path);
    }

    public object Open(string path)
    {
        if (!RibbonPackage.IsSupported(path))
        {
            throw new InvalidOperationException(".xlsm / .xlam のみ開けます。");
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"ファイルが見つかりません：{path}");
        }

        var doc = RibbonPackage.Load(path);
        settings.AddRecent(doc.Path);
        return new
        {
            path = doc.Path,
            parts = doc.Parts.Select(part => new
            {
                version = part.Version,
                xml = part.Xml,
                images = part.Images.Select(i => new { id = i.RelationshipId, contentType = i.ContentType, base64 = Convert.ToBase64String(i.Data) }),
            }),
        };
    }

    private static List<CustomUIPartChange> ToChanges(IReadOnlyList<PartDto> parts) =>
        parts.Select(p => new CustomUIPartChange(
            p.Version,
            p.Xml,
            p.AddImages.Select(i => new NewImage(i.Id, Convert.FromBase64String(i.Base64))).ToList(),
            p.RemoveImages)).ToList();

    /// <summary>バックアップを取ってから書き込む。バックアップのパスを返す。</summary>
    private string BackupAndWrite(string path, IReadOnlyList<PartDto> parts)
    {
        var generations = settings.Load().BackupGenerations;
        var backup = new BackupService(AppPaths.Backups, Math.Max(1, generations)).Backup(path);
        RibbonPackage.Save(path, ToChanges(parts));
        return backup;
    }

    private object SaveFile(SaveRequest req)
    {
        if (ExcelInstalled && IsLockedByExcel(req.Path))
        {
            throw new InvalidOperationException("Excelでこのブックが開かれているため保存できません。「反映（F5）」を使うと、Excelで閉じて書き込み、開き直します。");
        }

        return new { backup = BackupAndWrite(req.Path, req.Parts) };
    }

    private static bool IsLockedByExcel(string path)
    {
        try
        {
            using var _ = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            return false;
        }
        catch (IOException)
        {
            return true;
        }
    }

    private object RecentFiles() =>
        settings.Load().RecentFiles.Select(p => new { path = p, exists = File.Exists(p) }).ToList();

    private object? RemoveRecent(PathRequest req)
    {
        settings.RemoveRecent(req.Path);
        return null;
    }

    // ---- 設定 ----

    private static SettingsDto ToDto(AppSettings s) => new(s.Theme, s.XmlOnTop, s.IconSize, s.RibbonErrorsHintShown);

    private SettingsDto SetSettings(SettingsDto patch) => ToDto(settings.Update(s => s with
    {
        Theme = patch.Theme ?? s.Theme,
        XmlOnTop = patch.XmlOnTop ?? s.XmlOnTop,
        IconSize = patch.IconSize is 32 or 64 ? patch.IconSize.Value : s.IconSize,
        RibbonErrorsHintShown = patch.RibbonErrorsHintShown ?? s.RibbonErrorsHintShown,
    }));

    // ---- Excel ----

    private async Task<object> ApplyAsync(ApplyRequest req)
    {
        string? backup = null;
        void Write() => backup = BackupAndWrite(req.Path, req.Parts);

        if (!ExcelInstalled)
        {
            Write();
            return new { status = "written", message = "Excelが見つからないため、ファイルに書き込みました", backup };
        }

        var result = await excel.Value.ApplyAsync(req.Path, req.SaveIfDirty, Write);
        return new
        {
            status = result.Status switch
            {
                ApplyStatus.Applied => "applied",
                ApplyStatus.Written => "written",
                ApplyStatus.NeedsSave => "needsSave",
                _ => "blocked",
            },
            message = result.Message,
            backup,
        };
    }

    private async Task<object> ImageMsoAsync(ImageMsoRequest req)
    {
        if (!ExcelInstalled)
        {
            return new Dictionary<string, string?>();
        }

        var images = await excel.Value.GetImageMsoAsync(req.Names, req.Size is >= 16 and <= 128 ? req.Size : 32);
        return images.ToDictionary(kv => kv.Key, kv => kv.Value is null ? null : Convert.ToBase64String(kv.Value));
    }

    // ---- 要求の型 ----

    private sealed record PathRequest(string Path);

    private sealed record ImageDto(string Id, string Base64);

    private sealed record PartDto(CustomUIVersion Version, string Xml, IReadOnlyList<ImageDto> AddImages, IReadOnlyList<string> RemoveImages);

    private sealed record SaveRequest(string Path, IReadOnlyList<PartDto> Parts);

    private sealed record ApplyRequest(string Path, IReadOnlyList<PartDto> Parts, bool SaveIfDirty);

    private sealed record ImageMsoRequest(IReadOnlyList<string> Names, int Size);

    private sealed record LabelsRequest(IReadOnlyList<string> Ids);

    internal sealed record SettingsDto(string? Theme, bool? XmlOnTop, int? IconSize, bool? RibbonErrorsHintShown);
}
