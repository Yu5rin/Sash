using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Sash.Core;
using Sash.Core.Imaging;
using static Sash.Core.Localization.Text;

namespace Sash.Excel;

/// <summary>開いているブックの情報。</summary>
public sealed record OpenWorkbookInfo(string FullPath, bool IsAddIn, bool IsDirty);

public enum ApplyStatus
{
    /// <summary>Excel で開いていたブックに反映し、開き直した。</summary>
    Applied,

    /// <summary>Excel で開いていなかったので、ファイルに書き込んだだけ。</summary>
    Written,

    /// <summary>Excel 側に未保存の変更がある。保存してよいか利用者に確認が必要。</summary>
    NeedsSave,

    /// <summary>開き直したが、保護ビューなどで止まっている。</summary>
    Blocked,
}

public sealed record ApplyResult(ApplyStatus Status, string Message);

/// <summary>VBA モジュール 1 つ分。Type は vbext_ComponentType（1 = 標準、2 = クラス、3 = フォーム、100 = ドキュメント）。</summary>
public sealed record VbaModule(string Name, int Type, string Code);

public enum VbaReadStatus
{
    Ok,

    /// <summary>ブックが Excel で開かれていない。</summary>
    NotOpen,

    /// <summary>「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」がオフ。</summary>
    TrustDenied,

    /// <summary>VBA プロジェクトがパスワードで保護されている。</summary>
    Locked,
}

public sealed record VbaReadResult(VbaReadStatus Status, IReadOnlyList<VbaModule> Modules);

/// <summary>
/// Excel との連携（仕様書 §7、§9.1）。COM は遅延バインド（dynamic）で呼び、Interop アセンブリは同梱しない。
/// すべての COM 呼び出しは <see cref="ComThread"/> 上で行う。
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ExcelService : IDisposable
{
    private const int MsoAutomationSecurityByUI = 2;

    /// <summary>RPC_E_CALL_REJECTED。Excel がセルの編集中などで呼び出しを受け付けない。</summary>
    private const int RpcECallRejected = unchecked((int)0x80010001);

    /// <summary>RPC_E_SERVERCALL_RETRYLATER。</summary>
    private const int RpcERetryLater = unchecked((int)0x8001010A);

    /// <summary>VBA_E_IGNORE。Excel のオブジェクト モデルが一時的に呼び出しを無視している（ダイアログの表示中など）。</summary>
    private const int VbaEIgnore = unchecked((int)0x800AC472);

    /// <summary>Excel の一般的なエラー。VBProject へのアクセスが信頼されていないときもこれになる。</summary>
    private const int ExcelGeneralError = unchecked((int)0x800A03EC);

    private const int EInvalidArg = unchecked((int)0x80070057);

    private const int VbextStdModule = 1;
    private const int VbextDocument = 100;

    private static readonly string[] MacroExtensions = [".xlsm", ".xlam", ".xltm", ".xlsb"];

    private readonly ComThread _com = new();
    private readonly string _iconCacheDir;

    /// <summary>アイコンや表示名の取得のために Sash が起動した、見えない Excel。利用者の Excel ではない。</summary>
    private dynamic? _helperApp;

    public ExcelService(string iconCacheDir)
    {
        _iconCacheDir = iconCacheDir;
    }

    /// <summary>Excel の COM クラスが登録されているか。Excel を起動はしない。</summary>
    public static bool IsInstalled => Type.GetTypeFromProgID("Excel.Application", throwOnError: false) is not null;

    /// <summary>Excel が忙しくて呼び出しを断ったことによる失敗か（メッセージ フィルターで待っても終わらなかったとき）。</summary>
    public static bool IsBusy(Exception? ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is COMException && e.HResult is RpcECallRejected or RpcERetryLater or VbaEIgnore)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Excel が忙しいときに利用者に出す文言。</summary>
    public static string BusyMessage => L("Excelが応答しません（セルの編集中やダイアログの表示中の可能性があります）。Excelでの操作を終えてから、もう一度やり直してください。",
        "Excel is not responding (a cell may be in edit mode or a dialog may be open). Finish what you are doing in Excel and try again.");

    // ---- ブックの検索 ----

    public Task<IReadOnlyList<OpenWorkbookInfo>> ListOpenWorkbooksAsync() => _com.InvokeAsync<IReadOnlyList<OpenWorkbookInfo>>(() =>
    {
        var result = new List<OpenWorkbookInfo>();
        var mounts = WorkbookPaths.ReadSyncMounts();
        foreach (var app in RunningExcel.Applications())
        {
            foreach (var wb in Safe(() => (List<object>)Enumerate(app.Workbooks)) ?? [])
            {
                AddIfMacroBook(result, (dynamic)wb, false, mounts);
            }

            // アドインとして読み込まれている xlam は Workbooks に出てこないので、AddIns2 から拾う
            foreach (var addIn in Safe(() => (List<object>)Enumerate(app.AddIns2)) ?? [])
            {
                dynamic a = addIn;
                if (SafeValue(() => (bool)a.IsOpen) != true)
                {
                    continue;
                }

                var full = WorkbookPaths.ToLocal(Safe(() => (string)a.FullName), mounts);
                var wb = full is null ? null : TryGetWorkbook(app, full, mounts);
                if (wb is not null)
                {
                    AddIfMacroBook(result, wb, true, mounts);
                }
            }
        }

        return result.DistinctBy(w => w.FullPath, StringComparer.OrdinalIgnoreCase).ToList();
    });

    private static void AddIfMacroBook(List<OpenWorkbookInfo> list, dynamic wb, bool isAddIn, IReadOnlyList<Sash.Core.Excel.SyncMount> mounts)
    {
        // OneDrive の同期フォルダのブックは FullName が URL なので、ローカルのパスに直して返す（URL のままでは開けない）。
        // 直せない URL（同期していない SharePoint のブックなど）は、ファイルとして開けないので一覧に出さない
        string? full = WorkbookPaths.ToLocal(Safe(() => (string)wb.FullName), mounts);
        if (full is null || !MacroExtensions.Any(e => full.EndsWith(e, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        list.Add(new OpenWorkbookInfo(full, isAddIn || SafeValue(() => (bool)wb.IsAddin) == true, SafeValue(() => (bool)wb.Saved) == false));
    }

    /// <summary>
    /// COM のコレクションを List にして返す。yield で遅延させると、列挙の途中の例外が Safe(...) の外で起きて捕まらないため、
    /// その場で全部取り出す。
    /// </summary>
    private static List<object> Enumerate(dynamic collection)
    {
        var list = new List<object>();
        int count = collection.Count;
        for (var i = 1; i <= count; i++)
        {
            list.Add(collection.Item(i));
        }

        return list;
    }

    /// <summary>
    /// フルパスでブックを探す。FullName は同期フォルダのパスに直し、大文字・小文字を区別せずに比べる。
    /// アドインとして読み込まれている xlam も、名前を指定すれば取り出せる（ファイル名で取り出し、フルパスでも確かめる）。
    /// </summary>
    private static dynamic? TryGetWorkbook(dynamic app, string fullPath, IReadOnlyList<Sash.Core.Excel.SyncMount> mounts)
    {
        foreach (var wb in Safe(() => (List<object>)Enumerate(app.Workbooks)) ?? [])
        {
            if (WorkbookPaths.Matches(Safe(() => (string)((dynamic)wb).FullName), fullPath, mounts))
            {
                return wb;
            }
        }

        try
        {
            dynamic wb = app.Workbooks.Item(Path.GetFileName(fullPath));
            if (WorkbookPaths.Matches(Safe(() => (string)wb.FullName), fullPath, mounts))
            {
                return wb;
            }
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
        }

        return null;
    }

    private static (dynamic App, dynamic Workbook)? FindWorkbook(string fullPath)
    {
        var mounts = WorkbookPaths.ReadSyncMounts();
        foreach (var app in RunningExcel.Applications())
        {
            var wb = TryGetWorkbook(app, fullPath, mounts);
            if (wb is not null)
            {
                return (app, wb);
            }
        }

        return null;
    }

    // ---- 反映（仕様書 §7.1） ----

    /// <summary>
    /// ブックを閉じて書き込み、開き直す。開いていなければ書き込むだけ。
    /// backup と write は COM スレッドで呼ばれる。backup は 1 回の反映につき 1 回だけ呼び、write はロックが外れるまでやり直す
    /// （やり直しのたびにバックアップを取ると、同じ中身の世代が並んで古い世代が消えてしまうため）。
    /// </summary>
    public Task<ApplyResult> ApplyAsync(string fullPath, bool saveIfDirty, Action backup, Action write, string? activateTabId = null) => _com.InvokeAsync(() =>
    {
        var found = FindWorkbook(fullPath);
        if (found is null)
        {
            backup();
            write();
            return new ApplyResult(ApplyStatus.Written, L("Excelでは開かれていないので、ファイルに書き込みました", "The workbook is not open in Excel, so the changes were written to the file"));
        }

        var (app, wb) = found.Value;
        bool isAddIn = SafeValue(() => (bool)wb.IsAddin) == true;

        // 未保存かどうかがわからないまま閉じると、利用者の変更を捨ててしまうおそれがある。わからなければ止める
        bool? saved = SafeValue(() => (bool)wb.Saved);
        if (saved is null)
        {
            throw new UserFacingException(L("Excelのブックに未保存の変更があるかを確認できないため、反映を中止しました。Excelでの操作を終えてから、もう一度やり直してください。",
                "Applying was cancelled because Sash could not check whether the workbook has unsaved changes in Excel. Finish what you are doing in Excel and try again."));
        }

        if (saved == false)
        {
            // 勝手には保存しない（仕様書 §7.1 の 3）
            if (!saveIfDirty)
            {
                return new ApplyResult(ApplyStatus.NeedsSave, L("Excel側に未保存の変更があります", "The workbook has unsaved changes in Excel"));
            }

            // 読み取り専用で開いているブックの Save は「名前を付けて保存」のダイアログを出すか失敗するので、先に断る
            if (SafeValue(() => (bool)wb.ReadOnly) == true)
            {
                throw new UserFacingException(L("Excelでこのブックが読み取り専用で開かれているため、保存して反映できません。Excelで変更を保存するか破棄してから、やり直してください。",
                    "The workbook is open as read-only in Excel, so it cannot be saved and applied. Save or discard the changes in Excel, then try again."));
            }

            wb.Save();
        }

        // バックアップは閉じる前に 1 回だけ取る。Excel が開いていても読むことはでき、失敗してもブックは開いたままで済む
        RetryOnLock(backup);

        int protectedBefore = SafeValue(() => (int)app.ProtectedViewWindows.Count) ?? 0;

        // 閉じる。アドインの xlam も Workbook として閉じる。AddIn.Installed を切り替えると利用者のアドインの登録まで
        // 変わってしまう（失敗すると登録が外れたままになる）ので触らない。Workbooks.Open で開けば xlam はアドインとして読み込まれる
        wb.Close(false);
        Release(wb);
        wb = null;

        Exception? writeError = null;
        try
        {
            RetryOnLock(write);
        }
        catch (Exception ex)
        {
            writeError = ex;
        }

        // 書き込みに失敗しても、元のブックは開き直しておく。
        // 開き直したブックを前面に出すことはしない（Windows は別のプロセスが前面を奪うのを制限しているため確実にはできず、
        // 利用者の作業中のウィンドウを奪うおそれもある）。Excel の中では開き直したブックが作業中のブックになる
        Exception? reopenError = null;
        try
        {
            OpenRespectingSecurity(app, fullPath);
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            reopenError = ex;
        }

        if (writeError is not null)
        {
            throw new UserFacingException(reopenError is null
                ? L($"書き込みに失敗しました。ブックは元のまま開き直しました：{writeError.Message}", $"Writing failed. The workbook was reopened unchanged: {writeError.Message}")
                : L($"書き込みに失敗しました。ブックをExcelで開き直すこともできなかったので、Excelで開き直してください：{writeError.Message}", $"Writing failed, and Excel could not reopen the workbook. Please open it in Excel: {writeError.Message}"),
                writeError);
        }

        if (reopenError is not null)
        {
            return new ApplyResult(ApplyStatus.Blocked, L($"書き込みましたが、Excelで開き直せませんでした（{reopenError.Message}）。Excelで直接開いてください", $"The changes were written, but Excel could not reopen the workbook ({reopenError.Message}). Please open it in Excel"));
        }

        // ここから先は書き込みも開き直しも済んでいる。確認で失敗しても「失敗」とは言わない
        try
        {
            int protectedAfter = SafeValue(() => (int)app.ProtectedViewWindows.Count) ?? 0;
            if (protectedAfter > protectedBefore)
            {
                return new ApplyResult(ApplyStatus.Blocked, L("反映しましたが、保護ビューで開かれています。Excelで［編集を有効にする］を押すとリボンが表示されます", "Applied, but the workbook opened in Protected View. Click Enable Editing in Excel to show the ribbon"));
            }

            if (TryGetWorkbook(app, fullPath, WorkbookPaths.ReadSyncMounts()) is null)
            {
                return new ApplyResult(ApplyStatus.Blocked, L("反映しましたが、ブックの再読み込みが確認できません。Excelの画面を確認してください", "Applied, but reopening the workbook could not be confirmed. Please check Excel"));
            }

            // 作ったタブを前面に出す（仕様書 §7.1 の 6）。外からは IRibbonUI を触れないので、
            // Sash が入れた共通コード（modRibbonCore）の SashActivateTab をブックの中で呼ぶ。なければ何もしない
            if (!string.IsNullOrEmpty(activateTabId))
            {
                TryActivateTab(app, fullPath, activateTabId);
            }
        }
        catch (Exception ex)
        {
            return new ApplyResult(ApplyStatus.Blocked, L($"反映しましたが、Excelの状態を確認できませんでした（{ex.Message}）。Excelの画面を確認してください", $"Applied, but the state of Excel could not be checked ({ex.Message}). Please check Excel"));
        }

        return new ApplyResult(ApplyStatus.Applied, isAddIn ? L("アドインを読み込み直して反映しました", "Reloaded the add-in and applied the changes") : L("ブックを開き直して反映しました", "Reopened the workbook and applied the changes"));
    });

    private static void TryActivateTab(dynamic app, string fullPath, string tabId)
    {
        var macro = $"'{Path.GetFileName(fullPath).Replace("'", "''", StringComparison.Ordinal)}'!SashActivateTab";
        // 開き直した直後は onLoad がまだ呼ばれていないことがあるので、少し待って何度か試す
        for (var i = 0; i < 5; i++)
        {
            try
            {
                app.Run(macro, tabId);
                return;
            }
            catch (COMException)
            {
                Thread.Sleep(200);
            }
        }
    }

    /// <summary>
    /// 自動化で開くと既定ではマクロが無条件に有効になるため、一時的に Excel の UI と同じ判定に合わせて開く。
    /// セキュリティ設定そのものは変えない（仕様書 §7.2）。
    /// テンプレート（.xltm）は普通に開くと「テンプレートから作った新しいブック」になるので、Editable:=True でテンプレートそのものを開く。
    /// </summary>
    private static void OpenRespectingSecurity(dynamic app, string fullPath)
    {
        int? previous = SafeValue(() => (int)app.AutomationSecurity);
        try
        {
            app.AutomationSecurity = MsoAutomationSecurityByUI;
            if (string.Equals(Path.GetExtension(fullPath), ".xltm", StringComparison.OrdinalIgnoreCase))
            {
                app.Workbooks.Open(fullPath, Editable: true);
            }
            else
            {
                app.Workbooks.Open(fullPath);
            }
        }
        finally
        {
            if (previous is not null)
            {
                try
                {
                    app.AutomationSecurity = previous.Value;
                }
                catch (Exception ex) when (IsComFailure(ex))
                {
                }
            }
        }
    }

    /// <summary>閉じた直後はファイルのロックが残ることがあるので、少し待ってやり直す。ファイルがないなどの失敗はやり直さない。</summary>
    private static void RetryOnLock(Action action)
    {
        for (var i = 0; ; i++)
        {
            try
            {
                action();
                return;
            }
            catch (IOException ex) when (i < 10 && ex is not FileNotFoundException and not DirectoryNotFoundException)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                Thread.Sleep(300);
            }
        }
    }

    // ---- VBA（仕様書 §8） ----

    /// <summary>VBE からモジュールのコードを読む。読めないときは理由を返す（設定は勝手に変えない）。</summary>
    public Task<VbaReadResult> ReadVbaAsync(string fullPath) => _com.InvokeAsync(() =>
    {
        var found = FindWorkbook(fullPath);
        if (found is null)
        {
            return new VbaReadResult(VbaReadStatus.NotOpen, []);
        }

        dynamic? project = TryGetProject(found.Value.Workbook, out VbaReadStatus status);
        if (project is null)
        {
            return new VbaReadResult(status, []);
        }

        var modules = new List<VbaModule>();
        try
        {
            foreach (var c in Enumerate(project.VBComponents))
            {
                dynamic comp = c;
                dynamic cm = comp.CodeModule;
                int count = cm.CountOfLines;
                string code = count > 0 ? cm.Lines(1, count) : string.Empty;
                modules.Add(new VbaModule((string)comp.Name, (int)comp.Type, code));
            }
        }
        catch (COMException ex)
        {
            throw VbaFailure(ex);
        }

        return new VbaReadResult(VbaReadStatus.Ok, modules);
    });

    /// <summary>
    /// 「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」がオフのときの失敗か。
    /// Excel は 0x800A03EC（一般的なエラー）で「Programmatic access to Visual Basic Project is not trusted」と返す。
    /// 同じ番号はほかの失敗にも使われるので、文言でも確かめる（日本語版は「信頼」を含む文言）。
    /// </summary>
    private static bool IsTrustDenied(COMException ex) =>
        ex.HResult == ExcelGeneralError
        || ex.Message.Contains("not trusted", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("信頼", StringComparison.Ordinal);

    private static UserFacingException VbaFailure(COMException ex) =>
        new(IsBusy(ex) ? BusyMessage : L($"VBAプロジェクトを読み書きできませんでした：{ex.Message}", $"Could not read or write the VBA project: {ex.Message}"), ex);

    private static dynamic? TryGetProject(dynamic wb, out VbaReadStatus status)
    {
        try
        {
            dynamic project = wb.VBProject;
            // Protection: 0 = 保護なし、1 = 表示がロックされている
            if (SafeValue(() => (int)project.Protection) == 1)
            {
                status = VbaReadStatus.Locked;
                return null;
            }

            _ = project.VBComponents.Count;
            status = VbaReadStatus.Ok;
            return project;
        }
        catch (COMException ex) when (!IsBusy(ex) && IsTrustDenied(ex))
        {
            status = VbaReadStatus.TrustDenied;
            return null;
        }
        catch (COMException ex)
        {
            // Excel が忙しいなど、信頼の設定とは関係のない失敗。「設定をオンにしてください」と誤って案内しない
            throw VbaFailure(ex);
        }
    }

    private static dynamic RequireProject(string fullPath, out dynamic workbook)
    {
        var found = FindWorkbook(fullPath) ?? throw new UserFacingException(L("ブックがExcelで開かれていません。", "The workbook is not open in Excel."));
        workbook = found.Workbook;
        dynamic? project = TryGetProject(found.Workbook, out VbaReadStatus status);
        return project ?? throw new UserFacingException(status == VbaReadStatus.Locked
            ? L("VBAプロジェクトがパスワードで保護されています。", "The VBA project is password protected.")
            : L("VBAプロジェクトにアクセスできません。Excelの［トラスト センター］→［マクロの設定］で「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」をオンにしてください。", "Cannot access the VBA project. In Excel, turn on \"Trust access to the VBA project object model\" under Trust Center > Macro Settings."));
    }

    /// <summary>
    /// モジュールの末尾にコードを追加する。モジュールがなければ標準モジュールとして作る。
    /// 既存のコードは書き換えない（仕様書 §8.2）。documentModule が true なら ThisWorkbook に追加する。
    /// </summary>
    public Task<bool> InsertVbaAsync(string fullPath, string moduleName, string code, bool documentModule) => _com.InvokeAsync(() =>
    {
        try
        {
            dynamic project = RequireProject(fullPath, out dynamic wb);
            dynamic? target = null;
            if (documentModule)
            {
                target = FindWorkbookModule(project, wb);
            }
            else
            {
                foreach (var c in Enumerate(project.VBComponents))
                {
                    dynamic comp = c;
                    if (string.Equals((string)comp.Name, moduleName, StringComparison.OrdinalIgnoreCase))
                    {
                        target = comp;
                        break;
                    }
                }

                if (target is null)
                {
                    target = project.VBComponents.Add(VbextStdModule);
                    try
                    {
                        target.Name = moduleName;
                    }
                    catch (COMException ex)
                    {
                        // 名前を付けられなかった「Module1」を残さない
                        try
                        {
                            project.VBComponents.Remove(target);
                        }
                        catch (COMException)
                        {
                        }

                        throw new UserFacingException(L($"モジュール名「{moduleName}」を付けられませんでした（使えない文字が含まれているか、同じ名前のものがあります）。", $"The module could not be named \"{moduleName}\" (it contains characters that cannot be used, or the name is already used)."), ex);
                    }
                }
            }

            dynamic cm = target.CodeModule;
            int count = cm.CountOfLines;
            cm.InsertLines(count + 1, (count > 0 ? "\r\n" : string.Empty) + code.TrimEnd());
            return true;
        }
        catch (COMException ex)
        {
            throw VbaFailure(ex);
        }
    });

    /// <summary>
    /// ブック（ThisWorkbook）のモジュールを探す。普通は Workbook.CodeName の名前で取れる。
    /// 一度も VBE を開いていないブックなどでは CodeName が空のことがあるので、そのときは
    /// ドキュメント モジュール（Type = 100）のうち、ブックにしかないプロパティ（FullName）を持つものを選ぶ
    /// （シートのモジュールの Properties には FullName がない）。それでもなければ名前が ThisWorkbook のものを選ぶ。
    /// </summary>
    private static dynamic FindWorkbookModule(dynamic project, dynamic wb)
    {
        string? codeName = Safe(() => (string)wb.CodeName);
        if (!string.IsNullOrEmpty(codeName))
        {
            object? byName = Safe(() => (object)project.VBComponents.Item(codeName));
            if (byName is not null)
            {
                return byName;
            }
        }

        var documents = ((List<object>)Enumerate(project.VBComponents)).Where(c => SafeValue(() => (int)((dynamic)c).Type) == VbextDocument).ToList();
        foreach (var c in documents)
        {
            if (Safe(() => (object)((dynamic)c).Properties.Item("FullName")) is not null)
            {
                return c;
            }
        }

        foreach (var c in documents)
        {
            if (string.Equals(Safe(() => (string)((dynamic)c).Name), "ThisWorkbook", StringComparison.OrdinalIgnoreCase))
            {
                return c;
            }
        }

        throw new UserFacingException(L("ブックのモジュール（ThisWorkbook）が見つかりません。ExcelでVBEを一度開いてから、やり直してください。", "The workbook module (ThisWorkbook) was not found. Open the VBE in Excel once, then try again."));
    }

    /// <summary>1 行だけを書き換える。読み込んだ後にコードが変わっていたら書き換えない。</summary>
    public Task<bool> ReplaceVbaLineAsync(string fullPath, string moduleName, int line, string expected, string replacement) => _com.InvokeAsync(() =>
    {
        try
        {
            dynamic project = RequireProject(fullPath, out _);
            dynamic cm = project.VBComponents.Item(moduleName).CodeModule;
            string current = cm.Lines(line, 1);
            if (!string.Equals(current, expected, StringComparison.Ordinal))
            {
                throw new UserFacingException(L("VBAのコードが読み込んだ後に変更されています。コールバック一覧を再読み込みしてください。", "The VBA code changed after it was read. Please reload the callback list."));
            }

            cm.ReplaceLine(line, replacement);
            return true;
        }
        catch (COMException ex)
        {
            throw VbaFailure(ex);
        }
    });

    // ---- imageMso / 表示名（仕様書 §9.1） ----

    /// <summary>
    /// アイコンや表示名の取得に使う Excel。起動中のものがあればそれを、なければ見えない Excel を起動する。
    /// 起動した Excel は、使い終わるたびに <see cref="ReleaseHelperIfIdle"/> で片付ける。
    /// </summary>
    private dynamic HelperApp()
    {
        var running = RunningExcel.Applications().FirstOrDefault();
        if (running is not null)
        {
            return running;
        }

        // 前に起動した Excel が（利用者に閉じられるなどして）もう動いていなければ、作り直す
        if (_helperApp is not null && !IsAlive(_helperApp))
        {
            Release(_helperApp);
            _helperApp = null;
        }

        if (_helperApp is null)
        {
            var type = Type.GetTypeFromProgID("Excel.Application", throwOnError: true)!;
            _helperApp = Activator.CreateInstance(type)!;
            _helperApp.Visible = false;
            _helperApp.DisplayAlerts = false;
        }

        return _helperApp;
    }

    private static bool IsAlive(dynamic app)
    {
        try
        {
            _ = (long)app.Hwnd;
            return true;
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            return false;
        }
    }

    /// <summary>
    /// 起動した見えない Excel を片付ける。利用者がブックをダブルクリックすると、Windows がこの Excel にブックを
    /// 開かせることがある。そのときに Quit すると利用者のブックまで閉じてしまうので、ブックがなく見えないときだけ終わらせ、
    /// そうでなければ見えるようにして利用者に引き渡す（警告の表示も元に戻す）。COM スレッドで呼ぶ。
    /// </summary>
    private void ReleaseHelperIfIdle()
    {
        if (_helperApp is null)
        {
            return;
        }

        var app = _helperApp;
        _helperApp = null;
        try
        {
            int? count = SafeValue(() => (int)app.Workbooks.Count);
            bool? visible = SafeValue(() => (bool)app.Visible);
            if (count == 0 && visible == false)
            {
                app.Quit();
            }
            else if (count is not null)
            {
                app.DisplayAlerts = true;
                app.Visible = true;
                app.UserControl = true;
            }
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            // すでに終わっているなど。参照だけ放す
        }
        finally
        {
            Release(app);
        }
    }

    /// <summary>
    /// imageMso を PNG で返す。存在しない名前は null。取得結果はディスクにもキャッシュする。
    /// Excel が忙しいなど一時的に取れなかった名前は結果に含めない（null にすると UI が「存在しない名前」と判定してしまうため）。
    /// </summary>
    public Task<Dictionary<string, byte[]?>> GetImageMsoAsync(IReadOnlyList<string> names, int size) => _com.InvokeAsync(() =>
    {
        var result = new Dictionary<string, byte[]?>();
        var dir = Path.Combine(_iconCacheDir, size.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(dir);
        dynamic? app = null;
        try
        {
            foreach (var name in (names ?? []).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct(StringComparer.Ordinal))
            {
                if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                {
                    // ファイル名に使えない文字を含む imageMso はない
                    result[name] = null;
                    continue;
                }

                var cache = Path.Combine(dir, name + ".png");
                try
                {
                    if (File.Exists(cache))
                    {
                        result[name] = File.ReadAllBytes(cache);
                        continue;
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // キャッシュを読めなければ Excel から取り直す
                }

                try
                {
                    app ??= HelperApp();
                }
                catch (Exception ex) when (IsComFailure(ex) || ex is TypeLoadException)
                {
                    // Excel を起動できない。残りの名前は結果に含めない
                    break;
                }

                try
                {
                    object pic = app.CommandBars.GetImageMso(name, size, size);
                    var png = PictureToPng(pic);
                    Release(pic);
                    if (png is null)
                    {
                        // 画像の変換に失敗しただけで、名前がないわけではない
                        continue;
                    }

                    result[name] = png;
                    TryWrite(cache, png);
                }
                catch (Exception ex) when (ex.HResult == EInvalidArg && ex is COMException or ArgumentException)
                {
                    // 存在しない imageMso（Excel は E_INVALIDARG を返し、.NET はそれを ArgumentException にすることもある）
                    result[name] = null;
                }
                catch (Exception ex) when (IsComFailure(ex))
                {
                    // 忙しいなど一時的な失敗。結果に含めず、次の機会に取り直させる
                }
            }
        }
        finally
        {
            ReleaseHelperIfIdle();
        }

        return result;
    });

    private static void TryWrite(string path, byte[] data)
    {
        try
        {
            File.WriteAllBytes(path, data);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>idMso の表示名（日本語版の Excel なら日本語）を返す。</summary>
    public Task<Dictionary<string, string>> GetLabelsAsync(IReadOnlyList<string> ids) => _com.InvokeAsync(() =>
    {
        var result = new Dictionary<string, string>();
        try
        {
            dynamic app = HelperApp();
            dynamic bars = app.CommandBars;
            foreach (var id in (ids ?? []).Where(i => !string.IsNullOrWhiteSpace(i)).Distinct(StringComparer.Ordinal))
            {
                try
                {
                    string label = bars.GetLabelMso(id);
                    if (!string.IsNullOrEmpty(label))
                    {
                        // アクセスキーの印（&）は表示に不要なので除く
                        result[id] = label.Replace("&&", "\u0001", StringComparison.Ordinal).Replace("&", string.Empty, StringComparison.Ordinal).Replace('\u0001', '&');
                    }
                }
                catch (Exception ex) when (IsComFailure(ex) || ex is ArgumentException)
                {
                }
            }
        }
        finally
        {
            ReleaseHelperIfIdle();
        }

        return result;
    });

    /// <summary>GetImageMso が返す IPictureDisp（32bit のビットマップ）を、アルファを保ったまま PNG にする。</summary>
    private static byte[]? PictureToPng(object picture)
    {
        dynamic pic = picture;
        var hbitmap = new IntPtr((int)pic.Handle);
        if (NativeMethods.GetObject(hbitmap, Marshal.SizeOf<NativeMethods.BITMAP>(), out var bmp) == 0)
        {
            return null;
        }

        int w = bmp.bmWidth;
        int h = bmp.bmHeight;
        var bits = new byte[w * h * 4];
        var header = new NativeMethods.BITMAPINFOHEADER
        {
            biSize = Marshal.SizeOf<NativeMethods.BITMAPINFOHEADER>(),
            biWidth = w,
            biHeight = -h, // 上の行から
            biPlanes = 1,
            biBitCount = 32,
        };
        var hdc = NativeMethods.GetDC(IntPtr.Zero);
        try
        {
            if (NativeMethods.GetDIBits(hdc, hbitmap, 0, (uint)h, bits, ref header, 0) == 0)
            {
                return null;
            }
        }
        finally
        {
            NativeMethods.ReleaseDC(IntPtr.Zero, hdc);
        }

        // アルファを持たない画像（すべて 0）は不透明として扱う
        var hasAlpha = false;
        for (var i = 3; i < bits.Length; i += 4)
        {
            if (bits[i] != 0)
            {
                hasAlpha = true;
                break;
            }
        }

        if (!hasAlpha)
        {
            for (var i = 3; i < bits.Length; i += 4)
            {
                bits[i] = 255;
            }
        }
        else
        {
            // 乗算済みアルファをストレートに戻す
            for (var i = 0; i < bits.Length; i += 4)
            {
                int a = bits[i + 3];
                if (a is > 0 and < 255)
                {
                    bits[i] = (byte)Math.Min(255, bits[i] * 255 / a);
                    bits[i + 1] = (byte)Math.Min(255, bits[i + 1] * 255 / a);
                    bits[i + 2] = (byte)Math.Min(255, bits[i + 2] * 255 / a);
                }
            }
        }

        return PngEncoder.EncodeBgra(bits, w, h);
    }

    // ---- 共通 ----

    /// <summary>COM の呼び出しが失敗したときに起きる例外か（Excel が終わっていた、プロパティがない、型が違う、など）。</summary>
    private static bool IsComFailure(Exception ex) =>
        ex is COMException or InvalidComObjectException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException or InvalidCastException;

    private static T? Safe<T>(Func<T> f)
    {
        try
        {
            return f();
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            return default;
        }
    }

    private static T? SafeValue<T>(Func<T> f)
        where T : struct
    {
        try
        {
            return f();
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            return null;
        }
    }

    private static void Release(object? com)
    {
        if (com is not null && Marshal.IsComObject(com))
        {
            Marshal.FinalReleaseComObject(com);
        }
    }

    public void Dispose()
    {
        if (_helperApp is not null)
        {
            try
            {
                // 起動した Excel は、利用者のブックが入っていなければ終わらせ、入っていれば引き渡す
                _com.InvokeAsync(() =>
                {
                    ReleaseHelperIfIdle();
                    return true;
                }).Wait(TimeSpan.FromSeconds(10));
            }
            catch (AggregateException)
            {
            }
        }

        _com.Dispose();
    }
}
