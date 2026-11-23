using System.Runtime.Versioning;
using System.Text.Json;
using Sash.Core;
using Sash.Core.CustomUI;
using Sash.Core.Excel;
using Sash.Core.Packaging;
using Sash.Core.Settings;
using Sash.Core.Update;
using Sash.Excel;
using static Sash.Core.Localization.Text;

namespace Sash.App;

/// <summary>UI からの要求を種類ごとに処理する。要求と応答の型は ui/src/bridge.ts と対応させる。</summary>
[SupportedOSPlatform("windows")]
internal sealed class MessageRouter(IWin32Window owner, SettingsStore settings, RecipeStore recipes, Lazy<ExcelService> excel, ImageMsoCache iconCache, Action closeWindow, Action<object> postEvent)
{
    private static readonly bool ExcelInstalled = ExcelService.IsInstalled;

    /// <summary>入っている Excel の版。取り込み済みのアイコンを作った版と違えば、取り込み直しを勧める。</summary>
    private static readonly Lazy<string?> InstalledExcelVersion = new(() => ExcelInstalled ? ExcelEnvironment.InstalledVersion() : null);

    private readonly ImageMsoPrefetch _prefetch = CreatePrefetch(iconCache, postEvent);
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
                "icons.prefetchStatus" => PrefetchStatus(_prefetch.GetStatus()),
                "icons.prefetchStart" => PrefetchStart(Read<PrefetchStartRequest>(body)),
                "icons.prefetchCancel" => PrefetchCancel(),
                "recipes.list" => recipes.List(),
                "recipes.save" => SaveRecipe(body),
                "recipes.delete" => DeleteRecipe(Read<IdRequest>(body)),
                "vba.read" => await ReadVbaAsync(Read<PathRequest>(body)),
                "vba.insert" => await InsertVbaAsync(Read<VbaInsertRequest>(body)),
                "vba.replaceLine" => await ReplaceLineAsync(Read<VbaReplaceRequest>(body)),
                "vba.reveal" => await RevealVbaAsync(Read<VbaRevealRequest>(body)),
                "excel.setWindowWidth" => await SetWindowWidthAsync(Read<WindowWidthRequest>(body)),
                "excel.runMacro" => await RunMacroAsync(Read<RunMacroRequest>(body)),
                "excel.labels" => ExcelInstalled ? await excel.Value.GetLabelsAsync(Read<LabelsRequest>(body).Ids) : new Dictionary<string, string>(),
                "backup.list" => BackupList(Read<PathRequest>(body)),
                "backup.restore" => BackupRestore(Read<BackupRestoreRequest>(body)),
                _ => throw new InvalidOperationException(L($"不明な要求です：{request.Type}", $"Unknown request: {request.Type}")),
            };
            return new HostResponse(request.Id, true, payload, null);
        }
        catch (Exception ex)
        {
            return new HostResponse(request.Id, false, null, DescribeError(ex));
        }
    }

    /// <summary>
    /// 失敗を利用者向けの文言にする。利用者向けに書いた文言（UserFacingException）があればそれを優先し、
    /// Excel が忙しいときやファイルが別のプログラムに開かれているときは、何をすればよいかがわかる文言にする。
    /// </summary>
    private static string DescribeError(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is UserFacingException)
            {
                return e.Message;
            }
        }

        if (ExcelService.IsBusy(ex))
        {
            return ExcelService.BusyMessage;
        }

        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is IOException io && IsSharingViolation(io))
            {
                return L("ファイルが別のプログラム（Excelなど）で開かれているため、書き込めません。Excelで開いている場合は「反映（F5）」を使うか、Excelでブックを閉じてからやり直してください。",
                    "The file is open in another program (such as Excel) and cannot be written. If it is open in Excel, use Apply (F5), or close the workbook in Excel and try again.");
            }
        }

        if (ex is UnauthorizedAccessException)
        {
            return L($"ファイルにアクセスする権限がありません：{ex.Message}", $"Access to the file was denied: {ex.Message}");
        }

        return ex.Message;
    }

    /// <summary>共有違反（ERROR_SHARING_VIOLATION = 32）かロック違反（ERROR_LOCK_VIOLATION = 33）か。</summary>
    private static bool IsSharingViolation(IOException ex) =>
        ex.HResult is unchecked((int)0x80070020) or unchecked((int)0x80070021);

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
        try
        {
            settings.AddRecent(doc.Path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or UserFacingException)
        {
            // 最近使ったファイルに載せられないだけなので、開くことは続ける
        }

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

    private BackupService Backups() =>
        new(AppPaths.Backups, Math.Max(1, settings.Load().BackupGenerations));

    /// <summary>
    /// 保存・反映の前に、書き込める状態かを確かめる。ないファイルや読み取り専用のファイルは、
    /// バックアップを取ったり Excel のブックを閉じたりする前に、わかる言葉で断る。
    /// </summary>
    private static string CheckWritable(string path)
    {
        var full = Path.GetFullPath(path);
        var info = new FileInfo(full);
        if (!info.Exists)
        {
            throw new UserFacingException(L($"ファイルが見つかりません：{full}", $"File not found: {full}"));
        }

        if (info.IsReadOnly)
        {
            throw new UserFacingException(L($"読み取り専用のファイルのため保存できません。ファイルのプロパティで「読み取り専用」を外してください：{full}", $"The file is read-only and cannot be saved. Clear the Read-only attribute in the file properties: {full}"));
        }

        return full;
    }

    private object SaveFile(SaveRequest req)
    {
        var path = CheckWritable(req.Path);
        var changes = ToChanges(req.Parts);
        if (ExcelInstalled)
        {
            ThrowIfOpenElsewhere(path, L("Excelでこのブックが開かれているため保存できません。「反映（F5）」を使うと、Excelで閉じて書き込み、開き直します。", "This workbook is open in Excel and cannot be saved. Use Apply (F5) to close it in Excel, write the changes, and reopen it."));
        }

        var backup = Backups().Backup(path);
        RibbonPackage.Save(path, changes);
        return new { backup };
    }

    /// <summary>
    /// ほかのプログラム（ふつうは Excel）がファイルを開いていれば、message で断る。
    /// 共有違反のときだけを「開かれている」とみなす（ないファイルや権限がないときは、その理由のまま伝える）。
    /// </summary>
    private static void ThrowIfOpenElsewhere(string path, string message)
    {
        try
        {
            using var _ = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            throw new UserFacingException(message, ex);
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
            // .icl は 16 ビットの NE 形式で LoadLibraryEx では読めないので、候補に出さない
            Filter = L("アイコンを含むファイル (*.exe;*.dll;*.ocx;*.cpl)|*.exe;*.dll;*.ocx;*.cpl|すべてのファイル (*.*)|*.*", "Files with icons (*.exe;*.dll;*.ocx;*.cpl)|*.exe;*.dll;*.ocx;*.cpl|All files (*.*)|*.*"),
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
        var icons = new List<object>();
        foreach (var i in lib.List())
        {
            byte[] png;
            try
            {
                png = lib.ReadPng(i.Id);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                // 共有フォルダで別の人が消している途中など。1 つ読めないだけで一覧全体を失敗させない
                continue;
            }

            icons.Add(new
            {
                id = i.Id,
                name = i.Name,
                tags = i.Tags,
                createdAt = i.CreatedAt,
                hasSource = i.SourceName is not null,
                favorite = favorites.Contains(i.Id),
                png = Convert.ToBase64String(png),
            });
        }

        return new { root = lib.Root, icons };
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
        Theme = patch.Theme is "system" or "light" or "dark" ? patch.Theme : s.Theme,
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
        var path = CheckWritable(req.Path);
        var changes = ToChanges(req.Parts);
        var service = Backups();
        string? backup = null;

        // バックアップと書き込みは分けて渡す。書き込みはロックが外れるまでやり直されるが、バックアップは 1 回だけ取る
        void Backup() => backup = service.Backup(path);
        void Write() => RibbonPackage.Save(path, changes);

        if (!ExcelInstalled)
        {
            Backup();
            Write();
            return new { status = "written", message = L("Excelが見つからないため、ファイルに書き込みました", "Excel was not found, so the changes were written to the file"), backup };
        }

        var result = await excel.Value.ApplyAsync(path, req.SaveIfDirty, Backup, Write, req.ActivateTab);
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

    // ---- バックアップ（仕様書 §5.1） ----
    //
    // 要求と応答の形（UI の bridge.ts 側はまだない。つなぐときはこれに合わせる）:
    //   "backup.list"    要求 { path: string }
    //                    応答 { path: string; createdAt: string（ISO 8601）; size: number }[]（新しい順）
    //   "backup.restore" 要求 { path: string; backupPath: string }
    //                    応答 { backup: string | null }（戻す前に取った、今のファイルのバックアップ。今のファイルがなければ null）
    // backupPath は backup.list が返したもの（そのブックのバックアップのフォルダの中のもの）だけを受け付ける。
    // Excel でブックを開いているときは戻さずに断る（開き直しはしない）。

    private object BackupList(PathRequest req) =>
        Backups().ListEntries(Path.GetFullPath(req.Path))
            .Select(e => new { path = e.Path, createdAt = e.CreatedAt, size = e.Size })
            .ToList();

    private object BackupRestore(BackupRestoreRequest req)
    {
        var target = Path.GetFullPath(req.Path);
        if (!RibbonPackage.IsSupported(target))
        {
            throw new UserFacingException(L(".xlsm / .xlam / .xltm / .xlsb のみ戻せます。", "Only .xlsm / .xlam / .xltm / .xlsb files can be restored."));
        }

        var service = Backups();
        if (!service.IsBackupOf(req.BackupPath, target))
        {
            throw new UserFacingException(L("指定されたファイルは、このブックのバックアップではありません。", "The specified file is not a backup of this workbook."));
        }

        if (ExcelInstalled && File.Exists(target))
        {
            ThrowIfOpenElsewhere(target, L("Excelでこのブックが開かれているため戻せません。Excelでブックを閉じてからやり直してください。", "This workbook is open in Excel and cannot be restored. Close it in Excel and try again."));
        }

        try
        {
            return new { backup = service.Restore(req.BackupPath, target) };
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            // 共通の文言は「反映（F5）を使う」を勧めるが、復元は反映では代われないので、閉じてからのやり直しだけを案内する
            throw new UserFacingException(L("ブックかバックアップが別のプログラム（Excelなど）で開かれているため、戻せません。開いているプログラムでファイルを閉じてからやり直してください。",
                "The workbook or the backup is open in another program (such as Excel) and cannot be restored. Close the file in that program and try again."), ex);
        }
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

    /// <summary>VBE で Sub の宣言行を表示する（仕様書 §18.5）。</summary>
    private async Task<object> RevealVbaAsync(VbaRevealRequest req) =>
        await RequireExcel().RevealVbaAsync(req.Path, req.Module, req.Procedure);

    private async Task<object> ReplaceLineAsync(VbaReplaceRequest req) =>
        await RequireExcel().ReplaceVbaLineAsync(req.Path, req.Module, req.Line, req.Expected, req.Replacement);

    /// <summary>Excel のウィンドウの幅を合わせる（仕様書 §18.1）。Excel がない PC では理由を返す。</summary>
    private async Task<object> SetWindowWidthAsync(WindowWidthRequest req)
    {
        if (!ExcelInstalled)
        {
            throw new UserFacingException(L("Excel が見つからないため、ウィンドウの幅を合わせられません。", "Excel was not found, so the window width cannot be set."));
        }

        var r = await excel.Value.SetWindowWidthAsync(req.Path, req.Width, req.Scale);
        return new { points = r.Points, logicalWidth = r.LogicalWidth, workAreaWidth = r.WorkAreaWidth, workbook = r.Workbook };
    }

    /// <summary>開いているブックのマクロを実行する（試しに押す。仕様書 §18.4）。</summary>
    private async Task<object> RunMacroAsync(RunMacroRequest req)
    {
        if (!ExcelInstalled)
        {
            throw new UserFacingException(L("Excel が見つからないため、マクロを実行できません。", "Excel was not found, so the macro cannot be run."));
        }

        return await excel.Value.RunMacroAsync(req.Path, req.Macro);
    }

    private async Task<object> ImageMsoAsync(ImageMsoRequest req)
    {
        var size = req.Size is >= 16 and <= 128 ? req.Size : 32;

        // Excel がない PC でも、前に取り込んだキャッシュ（Excel をアンインストールした、など）があれば使う。
        // キャッシュにない名前は結果に含めない（存在しないと決めつけず、Lint の警告も出さない）
        var images = ExcelInstalled
            ? await excel.Value.GetImageMsoAsync(req.Names ?? [], size)
            : await Task.Run(() => iconCache.Lookup(req.Names ?? [], size).Found);
        return images.ToDictionary(kv => kv.Key, kv => kv.Value is null ? null : Convert.ToBase64String(kv.Value));
    }

    // ---- imageMso の取り込み（仕様書 §17.7） ----

    private static ImageMsoPrefetch CreatePrefetch(ImageMsoCache cache, Action<object> post)
    {
        var prefetch = new ImageMsoPrefetch(cache, AppLog.Write, () => InstalledExcelVersion.Value);
        prefetch.Changed += status =>
        {
            var dto = PrefetchStatus(status);
            post(new { @event = "iconPrefetch", dto.State, dto.Done, dto.Total, dto.Size, dto.Failed, dto.Cached, dto.Message, dto.Cancelled });
        };
        return prefetch;
    }

    /// <summary>取り込みの状態を UI 向けにする。Excel がなくキャッシュもなければ unavailable（取り込めない）。</summary>
    private static PrefetchStatusDto PrefetchStatus(ImageMsoPrefetchStatus s)
    {
        var state = s.State == "none" && !ExcelInstalled && s.Cached == 0 ? "unavailable" : s.State;
        // キャッシュの版は取り込んだ Excel（Application.Version と Build）から、いまの版は EXCEL.EXE のファイルの版から読む。
        // 形が違っても同じ Excel を「更新された」と言い続けないよう、メジャー.マイナー.ビルドにそろえて比べる
        var current = ImageMsoCache.NormalizeExcelVersion(InstalledExcelVersion.Value);
        var cachedVersion = ImageMsoCache.NormalizeExcelVersion(s.ExcelVersion);
        var outdated = state == "done" && cachedVersion is not null && current is not null && !ImageMsoCache.SameExcelVersion(cachedVersion, current);
        return new PrefetchStatusDto(state, s.Done, s.Total, s.Size, s.Failed, s.Cached, cachedVersion, s.CachedAt, s.Message, ExcelInstalled, current, outdated, s.Cancelled);
    }

    private PrefetchStatusDto PrefetchStart(PrefetchStartRequest req)
    {
        if (!ExcelInstalled)
        {
            throw new UserFacingException(L("Excel が見つからないため、アイコンを取り込めません。", "Excel was not found, so the icons cannot be imported."));
        }

        // すでに実行中なら、そのまま進み具合を返す
        _prefetch.Start(req.Names ?? [], req.Sizes, req.Force ?? false, excel.Value.CreateBulkSource());
        return PrefetchStatus(_prefetch.GetStatus());
    }

    private PrefetchStatusDto PrefetchCancel()
    {
        _prefetch.Cancel();
        return PrefetchStatus(_prefetch.GetStatus());
    }

    /// <summary>ウィンドウを閉じるときに、取り込みを止める。</summary>
    public void Shutdown() => _prefetch.Cancel();

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

    private sealed record BackupRestoreRequest(string Path, string BackupPath);

    private sealed record ApplyRequest(string Path, IReadOnlyList<PartDto> Parts, bool SaveIfDirty, string? ActivateTab = null);

    private sealed record ImageMsoRequest(IReadOnlyList<string> Names, int Size);

    private sealed record LabelsRequest(IReadOnlyList<string> Ids);

    private sealed record PrefetchStartRequest(IReadOnlyList<string>? Names, IReadOnlyList<int>? Sizes, bool? Force);

    /// <summary>icons.prefetchStatus の応答（ui/src/bridge.ts の IconPrefetchStatus）。</summary>
    private sealed record PrefetchStatusDto(
        string State,
        int Done,
        int Total,
        int Size,
        int Failed,
        int Cached,
        string? ExcelVersion,
        DateTimeOffset? CachedAt,
        string? Message,
        bool ExcelInstalled,
        string? CurrentExcelVersion,
        bool Outdated,
        bool Cancelled);

    private sealed record VbaInsertRequest(string Path, string Module, string Code, bool DocumentModule);

    private sealed record VbaRevealRequest(string Path, string Module, string Procedure);

    /// <summary>width は拡大率をかける前の画面の幅（物理 px）、scale は拡大率（1.5 = 150%）。Path があればそのブックの Excel を対象にする。</summary>
    private sealed record WindowWidthRequest(int Width, double Scale, string? Path = null);

    /// <summary>ControlId はどのコントロールから押したかの記録用（いまは使わない。将来、ログや IRibbonControl の代わりに使う余地を残す）。</summary>
    private sealed record RunMacroRequest(string Path, string Macro, string? ControlId = null);

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
