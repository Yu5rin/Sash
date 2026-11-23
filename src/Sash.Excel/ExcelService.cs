using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Sash.Core;
using Sash.Core.Excel;
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
    private readonly ImageMsoCache _iconCache;
    private OnceLog _onceLog = new(null);
    private Action<string>? _log;

    /// <summary>アイコンや表示名の取得のために Sash が起動した、見えない Excel。利用者の Excel ではない。</summary>
    private dynamic? _helperApp;

    /// <summary>imageMso の一括の取り込みのために Sash が起動した、見えない Excel。取り込みが終わったら閉じる。</summary>
    private dynamic? _bulkApp;

    /// <summary>HBITMAP を直接読む方法が使えるか（1 = 使える、-1 = 使えない、0 = まだ分からない）。COM スレッドだけが触る。</summary>
    private int _handlePath;

    /// <summary>終了処理に入ったか。片付けた後に、取り込みの続きが Excel を起動し直さないようにする。</summary>
    private volatile bool _disposing;

    public ExcelService(ImageMsoCache iconCache)
    {
        _iconCache = iconCache;
    }

    /// <summary>
    /// 診断の記録の書き出し先（App が AppLog.Write をつなぐ）。imageMso の失敗は理由ごとに最初の 1 回だけ書く
    /// （利用者から app.log を送ってもらえば、アイコンが出ない理由が分かるように）。
    /// </summary>
    public Action<string>? Log
    {
        get => _log;
        set
        {
            _log = value;
            _onceLog = new OnceLog(value);
        }
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
        var app = _helperApp;
        _helperApp = null;
        ReleaseOwnedApp(app);
    }

    /// <summary>一括の取り込みのために起動した Excel を片付ける（扱いは <see cref="ReleaseHelperIfIdle"/> と同じ）。COM スレッドで呼ぶ。</summary>
    private void ReleaseBulkApp()
    {
        var app = _bulkApp;
        _bulkApp = null;
        ReleaseOwnedApp(app);
    }

    private static void ReleaseOwnedApp(object? owned)
    {
        if (owned is null)
        {
            return;
        }

        dynamic app = owned;
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
            Release(owned);
        }
    }

    /// <summary>
    /// imageMso を PNG で返す（仕様書 §17.7）。キャッシュにあればそれを返し、Excel には触れない（取り込み済みなら Excel を起動しない）。
    /// 存在しない名前は null。Excel が忙しい・画像にできないなど一時的に取れなかった名前は結果に含めない
    /// （null にすると UI が「存在しない名前」と判定してしまうため）。キャッシュの読み込みは COM のスレッドの外で行い、
    /// 一括の取り込みの最中でもすぐ返せるようにする。
    /// </summary>
    public async Task<Dictionary<string, byte[]?>> GetImageMsoAsync(IReadOnlyList<string> names, int size)
    {
        var lookup = await Task.Run(() => _iconCache.Lookup(names ?? [], size)).ConfigureAwait(false);
        if (lookup.Misses.Count == 0)
        {
            return lookup.Found;
        }

        var fetched = await _com.InvokeAsync(() => FetchOnDemand(lookup.Misses, size)).ConfigureAwait(false);
        foreach (var (name, png) in fetched)
        {
            lookup.Found[name] = png;
        }

        return lookup.Found;
    }

    /// <summary>キャッシュになかった名前を、起動中の Excel（なければ見えない Excel）から取る。COM スレッドで呼ぶ。</summary>
    private Dictionary<string, byte[]?> FetchOnDemand(IReadOnlyList<string> names, int size)
    {
        var result = new Dictionary<string, byte[]?>(StringComparer.Ordinal);
        dynamic? bars = null;
        try
        {
            foreach (var name in names)
            {
                if (bars is null)
                {
                    try
                    {
                        bars = HelperApp().CommandBars;
                    }
                    catch (Exception ex) when (IsComFailure(ex) || ex is TypeLoadException)
                    {
                        // Excel を起動できない。残りの名前は結果に含めない
                        _onceLog.Write($"helper:{ex.GetType().Name}:{ex.HResult:X8}", $"imageMso: Excel に接続できなかった: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
                        break;
                    }
                }

                var r = ExtractOne(bars, name, size);
                switch (r.Kind)
                {
                    case ImageMsoFetchKind.Found:
                        result[name] = r.Png;
                        _iconCache.Store(name, size, r.Png!);
                        break;
                    case ImageMsoFetchKind.Missing:
                        result[name] = null;
                        _iconCache.MarkMissing(name, size);
                        break;
                    default:
                        // 名前がないわけではない。結果に含めず、次の機会に取り直させる
                        break;
                }
            }
        }
        finally
        {
            ReleaseHelperIfIdle();
        }

        return result;
    }

    /// <summary>
    /// 一括の取り込み（<see cref="ImageMsoPrefetch"/>）で使う取り出し口。利用者が使っている Excel を何千回も呼んで
    /// 重くしないよう、取り込み専用の見えない Excel を起動し、終わったら閉じる。
    /// </summary>
    public IImageMsoBatchSource CreateBulkSource() => new BulkSource(this);

    private sealed class BulkSource(ExcelService owner) : IImageMsoBatchSource
    {
        public Task<string?> BeginAsync(CancellationToken cancellationToken) => owner._com.InvokeAsync(owner.StartBulkApp);

        public Task<IReadOnlyList<ImageMsoFetchResult>> FetchAsync(IReadOnlyList<string> names, int size, CancellationToken cancellationToken) =>
            owner._com.InvokeAsync(() => owner.FetchBulk(names, size, cancellationToken));

        public Task EndAsync() => owner._com.InvokeAsync(() =>
        {
            owner.ReleaseBulkApp();
            return true;
        });
    }

    /// <summary>取り込み専用の見えない Excel を起動し、版（Version と Build。例：16.0.19029）を返す。COM スレッドで呼ぶ。</summary>
    private string? StartBulkApp()
    {
        ObjectDisposedException.ThrowIf(_disposing, this);
        ReleaseBulkApp();
        var type = Type.GetTypeFromProgID("Excel.Application", throwOnError: true)!;

        // CreateObject と同じく、利用者の Excel とは別の Excel が起動する
        _bulkApp = Activator.CreateInstance(type)!;
        _bulkApp.Visible = false;
        _bulkApp.DisplayAlerts = false;
        dynamic app = _bulkApp;
        string? version = Safe(() => (string)app.Version);
        string? build = Safe(() => Convert.ToString((object)app.Build, System.Globalization.CultureInfo.InvariantCulture));
        var text = version is null ? null : build is null ? version : $"{version}.{build}";
        Log?.Invoke($"imageMso の取り込みのため見えない Excel を起動（版 {text ?? "不明"}、{(Environment.Is64BitProcess ? "Sash は 64bit" : "Sash は 32bit")}）");
        return text;
    }

    /// <summary>一括の取り込みの 1 まとまり。COM スレッドで呼ぶ。</summary>
    private IReadOnlyList<ImageMsoFetchResult> FetchBulk(IReadOnlyList<string> names, int size, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposing, this);
        if (_bulkApp is null || !IsAlive(_bulkApp))
        {
            // 取り込み中に Excel が終わった（利用者がタスク マネージャーで終わらせたなど）。1 回だけ起動し直す
            Log?.Invoke("imageMso の取り込み用の Excel が応答しないため、起動し直す");
            StartBulkApp();
        }

        dynamic bars = _bulkApp!.CommandBars;
        var results = new List<ImageMsoFetchResult>(names.Count);
        foreach (var name in names)
        {
            if (ct.IsCancellationRequested)
            {
                break;
            }

            results.Add(ExtractOne(bars, name, size));
        }

        return results;
    }

    /// <summary>imageMso を 1 つ取り出す。COM スレッドで呼ぶ。</summary>
    private ImageMsoFetchResult ExtractOne(dynamic bars, string name, int size)
    {
        object? pic;
        try
        {
            pic = bars.GetImageMso(name, size, size);
        }
        catch (Exception ex) when (ex.HResult == EInvalidArg && ex is COMException or ArgumentException)
        {
            // 存在しない imageMso（Excel は E_INVALIDARG を返し、.NET はそれを ArgumentException にすることもある）
            return new ImageMsoFetchResult(name, ImageMsoFetchKind.Missing);
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            // 忙しいなど一時的な失敗
            _onceLog.Write($"getimagemso:{ex.GetType().Name}:{ex.HResult:X8}", $"imageMso: GetImageMso が失敗（{name}）: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
            return new ImageMsoFetchResult(name, ImageMsoFetchKind.Failed);
        }

        if (pic is null)
        {
            _onceLog.Write("getimagemso:null", $"imageMso: GetImageMso が何も返さなかった（{name}）");
            return new ImageMsoFetchResult(name, ImageMsoFetchKind.Failed);
        }

        try
        {
            var png = PictureToPng(pic, size);
            return png is null ? new ImageMsoFetchResult(name, ImageMsoFetchKind.Failed) : new ImageMsoFetchResult(name, ImageMsoFetchKind.Found, png);
        }
        finally
        {
            Release(pic);
        }
    }

    /// <summary>
    /// GetImageMso が返す IPictureDisp（32bit のビットマップ）を、アルファを保ったまま PNG にする。次の順に試す。
    /// 1. Handle（HBITMAP）を GetDIBits で読む。GDI のハンドルはプロセスごとのものなので、Excel が別のプロセス
    ///    （利用者の Excel も Sash が起動した Excel も、ふつうはそう）だと読めない。読めたときだけ使う。
    /// 2. QueryInterface で IPicture を取り、SaveAsFile でメモリ上のストリームに BMP を書かせて読む（COM が中身を運ぶ）。
    /// 3. IPersistStream.Save で同じように書かせて読む。
    /// どれも失敗したら null。理由ごとに最初の 1 回だけログに残す。
    /// </summary>
    private byte[]? PictureToPng(object picture, int size)
    {
        if (_handlePath >= 0)
        {
            try
            {
                var png = PngFromHandle(picture, size, out var reason);
                if (png is not null)
                {
                    if (_handlePath == 0)
                    {
                        Log?.Invoke("imageMso: HBITMAP から直接読めた");
                    }

                    _handlePath = 1;
                    return png;
                }

                _onceLog.Write($"handle:{reason}", $"imageMso: HBITMAP から読めなかった（{reason}）。Excel が別のプロセスで動いているため。BMP のバイト列で受け取る方法を試す");
            }
            catch (Exception ex) when (IsComFailure(ex) || ex is OverflowException)
            {
                _onceLog.Write($"handle:{ex.GetType().Name}:{ex.HResult:X8}", $"imageMso: Handle を読めなかった: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
            }
        }

        foreach (var (via, save) in new (string, Func<object, byte[]?>)[] { ("IPicture.SaveAsFile", SaveViaPicture), ("IPersistStream.Save", SaveViaPersistStream) })
        {
            var bmp = save(picture);
            if (bmp is null)
            {
                continue;
            }

            try
            {
                var png = BmpDecoder.ToPng(bmp, out var image);
                if (_handlePath != 1)
                {
                    // HBITMAP の方法は、この PC（別のプロセスの Excel）では使えないので、以後は試さない
                    _handlePath = -1;
                }

                _onceLog.Write($"bmp:{via}:{image.BitCount}:{image.Compression}", $"imageMso: {via} で受け取った（{image.Describe()}、{bmp.Length} バイト）");
                return png;
            }
            catch (FormatException ex)
            {
                _onceLog.Write($"bmpformat:{via}:{ex.Message}", $"imageMso: {via} の BMP を読めなかった: {ex.Message}（先頭 {Convert.ToHexString(bmp.AsSpan(0, Math.Min(32, bmp.Length)))}、{bmp.Length} バイト）");
            }
        }

        return null;
    }

    /// <summary>Handle（HBITMAP）を同じプロセスのものとして読む。読めなければ null と理由。</summary>
    private static byte[]? PngFromHandle(object picture, int size, out string reason)
    {
        dynamic pic = picture;
        var hbitmap = new IntPtr((int)pic.Handle);
        if (hbitmap == IntPtr.Zero)
        {
            reason = "Handle=0";
            return null;
        }

        if (NativeMethods.GetObject(hbitmap, Marshal.SizeOf<NativeMethods.BITMAP>(), out var bmp) == 0)
        {
            reason = "GetObject=0";
            return null;
        }

        int w = bmp.bmWidth;
        int h = bmp.bmHeight;

        // 別のプロセスのハンドルの値が、たまたまこのプロセスの別のビットマップを指している、という取り違えを防ぐ
        if (w != size || Math.Abs(h) != size)
        {
            reason = $"size={w}x{h}";
            return null;
        }

        h = Math.Abs(h);
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
                reason = "GetDIBits=0";
                return null;
            }
        }
        finally
        {
            NativeMethods.ReleaseDC(IntPtr.Zero, hdc);
        }

        BgraAlpha.Normalize(bits);
        reason = string.Empty;
        return PngEncoder.EncodeBgra(bits, w, h);
    }

    /// <summary>IPicture.SaveAsFile で BMP を書かせる。取れなければ null（理由はログへ）。</summary>
    private byte[]? SaveViaPicture(object picture)
    {
        IOlePicture ole;
        try
        {
            ole = (IOlePicture)picture;
        }
        catch (Exception ex) when (ex is InvalidCastException or COMException)
        {
            _onceLog.Write($"ipicture:{ex.GetType().Name}:{ex.HResult:X8}", $"imageMso: IPicture を取得できなかった: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
            return null;
        }

        return SaveToMemory("IPicture.SaveAsFile", stream => ole.SaveAsFile(stream, true, out _));
    }

    /// <summary>IPersistStream.Save で書かせる（"lt\0\0" と長さの後に BMP が続く）。取れなければ null。</summary>
    private byte[]? SaveViaPersistStream(object picture)
    {
        IOlePersistStream persist;
        try
        {
            persist = (IOlePersistStream)picture;
        }
        catch (Exception ex) when (ex is InvalidCastException or COMException)
        {
            _onceLog.Write($"ipersist:{ex.GetType().Name}:{ex.HResult:X8}", $"imageMso: IPersistStream を取得できなかった: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
            return null;
        }

        return SaveToMemory("IPersistStream.Save", stream => persist.Save(stream, false));
    }

    /// <summary>HGLOBAL のストリームに書かせて、そのバイト列を返す。</summary>
    private byte[]? SaveToMemory(string via, Func<System.Runtime.InteropServices.ComTypes.IStream, int> save)
    {
        System.Runtime.InteropServices.ComTypes.IStream? stream = null;
        try
        {
            var hr = NativeMethods.CreateStreamOnHGlobal(IntPtr.Zero, true, out stream);
            if (hr != 0)
            {
                _onceLog.Write($"stream:{hr:X8}", $"imageMso: CreateStreamOnHGlobal が失敗: 0x{hr:X8}");
                return null;
            }

            hr = save(stream);
            if (hr != 0)
            {
                _onceLog.Write($"save:{via}:{hr:X8}", $"imageMso: {via} が失敗: 0x{hr:X8}");
                return null;
            }

            stream.Stat(out var stat, 1); // STATFLAG_NONAME
            hr = NativeMethods.GetHGlobalFromStream(stream, out var hglobal);
            if (hr != 0)
            {
                _onceLog.Write($"hglobal:{hr:X8}", $"imageMso: GetHGlobalFromStream が失敗: 0x{hr:X8}");
                return null;
            }

            var length = Math.Min(stat.cbSize, (long)NativeMethods.GlobalSize(hglobal).ToUInt64());
            if (length is <= 0 or > 16 * 1024 * 1024)
            {
                _onceLog.Write($"length:{via}", $"imageMso: {via} が書いた長さが不正: {stat.cbSize}");
                return null;
            }

            var ptr = NativeMethods.GlobalLock(hglobal);
            if (ptr == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                var bytes = new byte[length];
                Marshal.Copy(ptr, bytes, 0, (int)length);
                return bytes;
            }
            finally
            {
                NativeMethods.GlobalUnlock(hglobal);
            }
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            _onceLog.Write($"save:{via}:{ex.GetType().Name}:{ex.HResult:X8}", $"imageMso: {via} が失敗: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
            return null;
        }
        finally
        {
            if (stream is not null)
            {
                Marshal.ReleaseComObject(stream);
            }
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
        _disposing = true;
        if (_helperApp is not null || _bulkApp is not null)
        {
            try
            {
                // 起動した Excel は、利用者のブックが入っていなければ終わらせ、入っていれば引き渡す
                // （取り込みの途中で Sash を閉じたときも、取り込み用の Excel を残さない）
                _com.InvokeAsync(() =>
                {
                    ReleaseHelperIfIdle();
                    ReleaseBulkApp();
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
