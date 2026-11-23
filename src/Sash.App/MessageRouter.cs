using System.Runtime.Versioning;
using System.Text.Json;
using Sash.Core.CustomUI;
using Sash.Core.Packaging;
using Sash.Core.Settings;
using Sash.Core.Update;
using Sash.Excel;
using static Sash.Core.Localization.Text;

namespace Sash.App;

/// <summary>UI からの要求を種類ごとに処理する。要求と応答の型は ui/src/bridge.ts と対応させる。</summary>
[SupportedOSPlatform("windows")]
internal sealed class MessageRouter(IWin32Window owner, SettingsStore settings, RecipeStore recipes, Lazy<ExcelService> excel, Action closeWindow)
{
    private static readonly bool ExcelInstalled = ExcelService.IsInstalled;
    private readonly UpdateService _update = new(settings);
    private UpdateRelease? _lastRelease;

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
                "file.exportText" => ExportText(Read<ExportRequest>(body)),
                "file.recent" => RecentFiles(),
                "file.removeRecent" => RemoveRecent(Read<PathRequest>(body)),
                "settings.get" => ToDto(settings.Load()),
                "settings.set" => SetSettings(Read<SettingsDto>(body)),
                "excel.openWorkbooks" => ExcelInstalled ? await excel.Value.ListOpenWorkbooksAsync() : [],
                "excel.apply" => await ApplyAsync(Read<ApplyRequest>(body)),
                "excel.imageMso" => await ImageMsoAsync(Read<ImageMsoRequest>(body)),
                "update.check" => await CheckUpdateAsync(),
                "update.install" => await InstallUpdateAsync(),
                "update.status" => UpdateStatus(),
                "update.openPage" => OpenPage(Read<UrlRequest>(body)),
                "library.list" => LibraryList(),
                "library.get" => LibraryGet(Read<IdRequest>(body)),
                "library.save" => LibrarySave(Read<LibrarySaveRequest>(body)),
                "library.update" => LibraryUpdate(Read<LibraryUpdateRequest>(body)),
                "library.delete" => LibraryDelete(Read<IdRequest>(body)),
                "library.chooseFolder" => ChooseLibraryFolder(),
                "library.toggleFavorite" => ToggleFavorite(Read<IdRequest>(body)),
                "icons.fromExecutable" => IconsFromExecutable(),
                "recipes.list" => recipes.List(),
                "recipes.save" => SaveRecipe(body),
                "recipes.delete" => DeleteRecipe(Read<IdRequest>(body)),
                "vba.read" => await ReadVbaAsync(Read<PathRequest>(body)),
                "vba.insert" => await InsertVbaAsync(Read<VbaInsertRequest>(body)),
                "vba.replaceLine" => await ReplaceLineAsync(Read<VbaReplaceRequest>(body)),
                "excel.labels" => ExcelInstalled ? await excel.Value.GetLabelsAsync(Read<LabelsRequest>(body).Ids) : new Dictionary<string, string>(),
                _ => throw new InvalidOperationException(L($"不明な要求です：{request.Type}", $"Unknown request: {request.Type}")),
            };
            return new HostResponse(request.Id, true, payload, null);
        }
        catch (Exception ex)
        {
            return new HostResponse(request.Id, false, null, ex.InnerException is IOException io ? io.Message : ex.Message);
        }
    }

    private static T Read<T>(JsonElement? body) =>
        body is { } b ? b.Deserialize<T>(HostJson.Options) ?? throw new InvalidOperationException(L("要求の内容が空です。", "The request is empty.")) : throw new InvalidOperationException(L("要求の内容が空です。", "The request is empty."));

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
                Filter = L("Excel マクロブック / アドイン / テンプレート (*.xlsm;*.xlam;*.xltm;*.xlsb)|*.xlsm;*.xlam;*.xltm;*.xlsb", "Excel macro workbooks / add-ins / templates (*.xlsm;*.xlam;*.xltm;*.xlsb)|*.xlsm;*.xlam;*.xltm;*.xlsb"),
                Title = L("リボンを編集するブックを開く", "Open a workbook to edit its ribbon"),
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
            throw new InvalidOperationException(L(".xlsm / .xlam / .xltm / .xlsb のみ開けます。", "Only .xlsm / .xlam / .xltm / .xlsb files can be opened."));
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException(L($"ファイルが見つかりません：{path}", $"File not found: {path}"));
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
            throw new InvalidOperationException(L("Excelでこのブックが開かれているため保存できません。「反映（F5）」を使うと、Excelで閉じて書き込み、開き直します。", "This workbook is open in Excel and cannot be saved. Use Apply (F5) to close it in Excel, write the changes, and reopen it."));
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

    /// <summary>保存ダイアログを出してテキストを書き出す（.sash.json）。キャンセル時は null。</summary>
    private object? ExportText(ExportRequest req)
    {
        using var dialog = new SaveFileDialog
        {
            FileName = req.DefaultName,
            Filter = string.IsNullOrEmpty(req.Filter) ? L("すべてのファイル (*.*)|*.*", "All files (*.*)|*.*") : req.Filter,
            OverwritePrompt = true,
        };
        if (dialog.ShowDialog(owner) != DialogResult.OK)
        {
            return null;
        }

        File.WriteAllText(dialog.FileName, req.Content, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return dialog.FileName;
    }

    private object RecentFiles() =>
        settings.Load().RecentFiles.Select(p => new { path = p, exists = File.Exists(p) }).ToList();

    private object? RemoveRecent(PathRequest req)
    {
        settings.RemoveRecent(req.Path);
        return null;
    }

    // ---- アイコン ----

    private object? IconsFromExecutable()
    {
        using var dialog = new OpenFileDialog
        {
            Filter = L("アイコンを含むファイル (*.exe;*.dll;*.ocx;*.cpl;*.icl)|*.exe;*.dll;*.ocx;*.cpl;*.icl|すべてのファイル (*.*)|*.*", "Files with icons (*.exe;*.dll;*.ocx;*.cpl;*.icl)|*.exe;*.dll;*.ocx;*.cpl;*.icl|All files (*.*)|*.*"),
            Title = L("アイコンを取り出すファイルを選ぶ", "Choose a file to extract icons from"),
        };
        if (dialog.ShowDialog(owner) != DialogResult.OK)
        {
            return null;
        }

        var icons = IconExtractor.Extract(dialog.FileName);
        return new
        {
            fileName = Path.GetFileNameWithoutExtension(dialog.FileName),
            icons = icons.Select(i => new { name = i.Name, base64 = Convert.ToBase64String(i.Ico) }),
        };
    }

    // ---- 更新 ----

    private object UpdateStatus()
    {
        var (source, policy) = SafeSource();
        return new
        {
            current = UpdateService.CurrentVersionText,
            checkOnStartup = _update.ShouldCheckOnStartup(),
            source,
            managedByAdmin = policy?.Source is not null || policy?.CheckOnStartup is not null || policy?.Disabled == true,
            logPath = Path.Combine(AppPaths.Root, "logs", "update.log"),
        };
    }

    private (string Source, UpdatePolicy? Policy) SafeSource()
    {
        try
        {
            var (s, p) = _update.ResolveSource();
            return (s.Location, p);
        }
        catch (ArgumentException ex)
        {
            return (ex.Message, null);
        }
    }

    private async Task<object> CheckUpdateAsync()
    {
        var (result, release) = await _update.CheckAsync();
        _lastRelease = result.Status == "available" ? release : null;
        return result;
    }

    private async Task<object?> InstallUpdateAsync()
    {
        var release = _lastRelease ?? throw new InvalidOperationException(L("先に更新を確認してください。", "Check for updates first."));
        await _update.InstallAsync(release, closeWindow);
        return null;
    }

    /// <summary>リリースのページや共有フォルダを開く。https の URL と、存在するフォルダだけを開く。</summary>
    private static object? OpenPage(UrlRequest req)
    {
        var target = req.Url;
        var ok = (Uri.TryCreate(target, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps) || Directory.Exists(target);
        if (!ok)
        {
            throw new InvalidOperationException(L("開けない場所です。", "This location cannot be opened."));
        }

        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target) { UseShellExecute = true });
        return null;
    }

    // ---- アイコンライブラリ（仕様書 §6.4） ----

    private Sash.Core.Library.IconLibrary Library()
    {
        var path = settings.Load().IconLibraryPath;
        return new Sash.Core.Library.IconLibrary(string.IsNullOrWhiteSpace(path) ? AppPaths.Icons : path);
    }

    private object LibraryList()
    {
        var lib = Library();
        var favorites = settings.Load().IconFavorites.ToHashSet(StringComparer.Ordinal);
        return new
        {
            root = lib.Root,
            icons = lib.List().Select(i => new
            {
                id = i.Id,
                name = i.Name,
                tags = i.Tags,
                createdAt = i.CreatedAt,
                hasSource = i.SourceName is not null,
                favorite = favorites.Contains(i.Id),
                png = Convert.ToBase64String(lib.ReadPng(i.Id)),
            }),
        };
    }

    private object? LibraryGet(IdRequest req)
    {
        var lib = Library();
        var icon = lib.Get(req.Id);
        if (icon is null)
        {
            return null;
        }

        var source = lib.ReadSource(icon.Id);
        return new
        {
            id = icon.Id,
            name = icon.Name,
            tags = icon.Tags,
            png = Convert.ToBase64String(lib.ReadPng(icon.Id)),
            source = source is null ? null : Convert.ToBase64String(source),
            sourceName = icon.SourceName,
            sourceContentType = icon.SourceContentType,
            options = icon.Options,
        };
    }

    private object LibrarySave(LibrarySaveRequest req)
    {
        var options = req.Options is { ValueKind: JsonValueKind.Object } o ? System.Text.Json.Nodes.JsonNode.Parse(o.GetRawText()) as System.Text.Json.Nodes.JsonObject : null;
        var icon = Library().Add(req.Name, req.Tags ?? [], Convert.FromBase64String(req.Png),
            string.IsNullOrEmpty(req.Source) ? null : Convert.FromBase64String(req.Source), req.SourceName, req.SourceContentType, options);
        return new { id = icon.Id };
    }

    private object LibraryUpdate(LibraryUpdateRequest req) => Library().Update(req.Id, req.Name, req.Tags);

    private object? LibraryDelete(IdRequest req)
    {
        Library().Delete(req.Id);
        settings.Update(s => s with { IconFavorites = s.IconFavorites.Where(f => f != req.Id).ToList() });
        return null;
    }

    private object? ChooseLibraryFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = L("アイコンライブラリの場所（共有フォルダも選べます）", "Icon library location (a shared folder can be used)"),
            UseDescriptionForTitle = true,
            SelectedPath = Library().Root,
        };
        if (dialog.ShowDialog(owner) != DialogResult.OK)
        {
            return null;
        }

        settings.Update(s => s with { IconLibraryPath = dialog.SelectedPath });
        return dialog.SelectedPath;
    }

    private object ToggleFavorite(IdRequest req)
    {
        var next = settings.Update(s => s with
        {
            IconFavorites = s.IconFavorites.Contains(req.Id) ? s.IconFavorites.Where(f => f != req.Id).ToList() : [.. s.IconFavorites, req.Id],
        });
        return next.IconFavorites.Contains(req.Id);
    }

    // ---- レシピ ----

    private object? SaveRecipe(JsonElement? body)
    {
        if (body is not { ValueKind: JsonValueKind.Object } b || System.Text.Json.Nodes.JsonNode.Parse(b.GetRawText()) is not System.Text.Json.Nodes.JsonObject obj)
        {
            throw new InvalidOperationException(L("レシピの内容が不正です。", "The recipe is invalid."));
        }

        recipes.Save(obj);
        return null;
    }

    private object? DeleteRecipe(IdRequest req)
    {
        recipes.Delete(req.Id);
        return null;
    }

    // ---- 設定 ----

    private static SettingsDto ToDto(AppSettings s) =>
        new(s.Theme, s.XmlOnTop, s.IconSize, s.RibbonErrorsHintShown, s.CallbackPattern, s.CallbackShared, s.CallbackSharedPattern, s.CallbackModule, s.Language, string.IsNullOrWhiteSpace(s.IconLibraryPath) ? AppPaths.Icons : s.IconLibraryPath, s.UpdateCheckOnStartup, s.UpdateSource);

    private SettingsDto SetSettings(SettingsDto patch) => ToDto(SettingsLanguage.Apply(settings.Update(s => s with
    {
        Theme = patch.Theme ?? s.Theme,
        XmlOnTop = patch.XmlOnTop ?? s.XmlOnTop,
        IconSize = patch.IconSize is 32 or 64 ? patch.IconSize.Value : s.IconSize,
        RibbonErrorsHintShown = patch.RibbonErrorsHintShown ?? s.RibbonErrorsHintShown,
        CallbackPattern = string.IsNullOrWhiteSpace(patch.CallbackPattern) ? s.CallbackPattern : patch.CallbackPattern,
        CallbackShared = patch.CallbackShared ?? s.CallbackShared,
        CallbackSharedPattern = string.IsNullOrWhiteSpace(patch.CallbackSharedPattern) ? s.CallbackSharedPattern : patch.CallbackSharedPattern,
        CallbackModule = string.IsNullOrWhiteSpace(patch.CallbackModule) ? s.CallbackModule : patch.CallbackModule,
        Language = patch.Language is "ja" or "en" ? patch.Language : s.Language,
        UpdateCheckOnStartup = patch.UpdateCheckOnStartup ?? s.UpdateCheckOnStartup,
        UpdateSource = patch.UpdateSource is null ? s.UpdateSource : ValidSource(patch.UpdateSource),
    })));


    // ---- Excel ----

    private async Task<object> ApplyAsync(ApplyRequest req)
    {
        string? backup = null;
        void Write() => backup = BackupAndWrite(req.Path, req.Parts);

        if (!ExcelInstalled)
        {
            Write();
            return new { status = "written", message = L("Excelが見つからないため、ファイルに書き込みました", "Excel was not found, so the changes were written to the file"), backup };
        }

        var result = await excel.Value.ApplyAsync(req.Path, req.SaveIfDirty, Write, req.ActivateTab);
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

    private ExcelService RequireExcel() =>
        ExcelInstalled ? excel.Value : throw new InvalidOperationException(L("Excelが見つからないため、VBAを読み書きできません。", "Excel was not found, so VBA cannot be read or written."));

    private async Task<object> ReadVbaAsync(PathRequest req)
    {
        if (!ExcelInstalled)
        {
            return new { status = "noExcel", modules = Array.Empty<object>() };
        }

        var r = await excel.Value.ReadVbaAsync(req.Path);
        return new
        {
            status = r.Status switch
            {
                VbaReadStatus.Ok => "ok",
                VbaReadStatus.NotOpen => "notOpen",
                VbaReadStatus.TrustDenied => "trustDenied",
                _ => "locked",
            },
            modules = r.Modules.Select(m => new { name = m.Name, type = m.Type, code = m.Code }),
        };
    }

    private async Task<object> InsertVbaAsync(VbaInsertRequest req) =>
        await RequireExcel().InsertVbaAsync(req.Path, req.Module, req.Code, req.DocumentModule);

    private async Task<object> ReplaceLineAsync(VbaReplaceRequest req) =>
        await RequireExcel().ReplaceVbaLineAsync(req.Path, req.Module, req.Line, req.Expected, req.Replacement);

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

    private sealed record IdRequest(string Id);

    private sealed record UrlRequest(string Url);

    private sealed record LibrarySaveRequest(string Name, IReadOnlyList<string>? Tags, string Png, string? Source, string? SourceName, string? SourceContentType, JsonElement? Options);

    private sealed record LibraryUpdateRequest(string Id, string? Name, IReadOnlyList<string>? Tags);

    private sealed record ExportRequest(string DefaultName, string Filter, string Content);

    private sealed record ImageDto(string Id, string Base64);

    private sealed record PartDto(CustomUIVersion Version, string Xml, IReadOnlyList<ImageDto> AddImages, IReadOnlyList<string> RemoveImages);

    private sealed record SaveRequest(string Path, IReadOnlyList<PartDto> Parts);

    private sealed record ApplyRequest(string Path, IReadOnlyList<PartDto> Parts, bool SaveIfDirty, string? ActivateTab = null);

    private sealed record ImageMsoRequest(IReadOnlyList<string> Names, int Size);

    private sealed record LabelsRequest(IReadOnlyList<string> Ids);

    private sealed record VbaInsertRequest(string Path, string Module, string Code, bool DocumentModule);

    private sealed record VbaReplaceRequest(string Path, string Module, int Line, string Expected, string Replacement);

    internal sealed record SettingsDto(
        string? Theme,
        bool? XmlOnTop,
        int? IconSize,
        bool? RibbonErrorsHintShown,
        string? CallbackPattern,
        bool? CallbackShared,
        string? CallbackSharedPattern,
        string? CallbackModule,
        string? Language,
        string? IconLibraryPath,
        bool? UpdateCheckOnStartup,
        string? UpdateSource);

    /// <summary>更新の確認先として使えるかを確かめる（http などはここで断る）。</summary>
    private static string ValidSource(string text)
    {
        Sash.Core.Update.UpdateSource.Parse(text);
        return text.Trim();
    }
}
