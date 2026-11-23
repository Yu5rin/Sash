using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Sash.Core;
using Sash.Core.Excel;
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

/// <summary>Excel のウィンドウの幅を合わせた結果（仕様書 §18.1）。幅はすべて論理 px、Points は Application.Width に入れた値。</summary>
/// <summary>excel.setWindowWidth の結果。ActualWidth・ExpectedWidth は物理 px（ActualWidth は測れなければ null）。</summary>
public sealed record WindowWidthResult(double Points, double LogicalWidth, double WorkAreaWidth, string? Workbook, int? ActualWidth = null, int? ExpectedWidth = null);

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

    /// <summary>取り込み用の Excel に開いた作業用のブック。imageMso を取り出す VBA モジュールを入れる先（保存せずに閉じる）。</summary>
    private object? _bulkScratch;

    /// <summary>作業用のブックに入れた VBA モジュール（VBComponent）。片付けで取り除く。</summary>
    private object? _bulkModule;

    /// <summary>Application.Run に渡す名前（'ブック名'!モジュール.関数）。</summary>
    private string? _bulkMacro;

    /// <summary>確認用の小さな関数（SashPing）を Application.Run で呼べたか。呼べたのに本体が呼べなければ、本体のコンパイルを疑う。</summary>
    private bool _bulkPingWorked;

    /// <summary>VBA と受け渡しする一時フォルダ（%TEMP%\Sash\imagemso\&lt;guid&gt;）。片付けで消す。</summary>
    private string? _bulkTempDir;

    /// <summary>一時フォルダの中の、まとまりごとのフォルダの番号。</summary>
    private int _bulkBatch;

    /// <summary>今回の取り込みで取り込み専用の Excel を起動し直した回数。</summary>
    private int _bulkRestarts;

    /// <summary>今回の取り込みの集計（ログに残すため）。</summary>
    private BulkStats _bulkStats;

    /// <summary>
    /// Sash が起動した取り込み専用の Excel のプロセスの番号（分からなければ 0）と起動した時刻。
    /// 応答しなくなったときに、このプロセスだけを終わらせるために覚える。タイマーや UI のスレッドからも読む。
    /// </summary>
    private int _bulkPid;

    private long _bulkPidStartTicks;

    /// <summary>取り込み専用の Excel の準備の最中なら 1（準備が終わらないときのタイマーが見る）。</summary>
    private int _bulkStarting;

    /// <summary>準備が時間切れになり、プロセスを終わらせたなら 1。</summary>
    private int _startTimedOut;

    /// <summary>終了処理に入ったか。片付けた後に、取り込みの続きが Excel を起動し直さないようにする。</summary>
    private volatile bool _disposing;

    /// <summary>マクロを実行中なら 1（<see cref="RunMacroAsync"/>）。ほかの Excel 連携をすぐに断るために、COM のスレッドの外から読む。</summary>
    private int _macroRunning;

    private readonly record struct BulkStats(int Found, int Missing, int Failed);

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

    // ---- 幅の確認・試しに押す・VBE へ移る（仕様書 §18） ----

    /// <summary>
    /// Excel のウィンドウの幅を、画面の幅（物理 px）と拡大率から決めた幅に合わせる（仕様書 §18.1）。
    /// 対象は fullPath のブックを開いている Excel のウィンドウ（なければ起動中の Excel の、いま前にあるウィンドウ）。
    /// 最大化を解いてから幅を入れる（最大化のままでは Width を入れても変わらないため）。
    /// モニターの作業領域より広い幅は断る（Windows がウィンドウを縮めてしまい、測りたい幅にならないため）。
    /// Windows 実機の Excel では確かめていない（換算・複数モニター・DPI の違うモニターでの動きを含む）。
    /// </summary>
    public Task<WindowWidthResult> SetWindowWidthAsync(string? fullPath, int width, double scale) => _com.InvokeAsync(() =>
    {
        scale = ExcelWindowSizing.NormalizeScale(scale);
        if (ExcelWindowSizing.Validate(width, scale) is { } invalid)
        {
            throw new UserFacingException(invalid);
        }

        dynamic? app = null;
        dynamic? book = null;
        if (!string.IsNullOrEmpty(fullPath) && FindWorkbook(fullPath) is { } found)
        {
            app = found.App;
            dynamic wb = found.Workbook;
            // アドイン（xlam）は自分のウィンドウを持たないので、そのときは Excel のいま前にあるウィンドウを使う
            if (SafeValue(() => (bool)wb.IsAddin) != true)
            {
                book = wb;
            }
        }

        app ??= RunningExcel.Applications().FirstOrDefault()
            ?? throw new UserFacingException(L("Excel が起動していません。Excel でブックを開いてから、もう一度やり直してください。", "Excel is not running. Open the workbook in Excel and try again."));
        if (Safe(() => (object?)app.ActiveWindow) is null)
        {
            throw new UserFacingException(L("Excel に表示中のウィンドウがありません。ブックを開いてから、もう一度やり直してください。", "Excel has no visible window. Open a workbook and try again."));
        }

        // 収まるかは、ブックを前に出す前に、そのブックのウィンドウ（Excel 2013 以降は Window.Hwnd がある）のモニターで確かめる。
        // 先に前に出すと、断ったときにも利用者のアクティブなブックが変わってしまうため
        long handle = book is not null ? SafeValue(() => (long)book!.Windows(1).Hwnd) ?? 0 : 0;
        var hwnd = new IntPtr(handle != 0 ? handle : (long)app.Hwnd);
        // 座標を物理 px で受け取るため、呼び出しの間だけこのスレッドを Per-Monitor V2 にする
        // （プロセスは PerMonitorV2 で起動するが、COM のスレッドの DPI の扱いに頼らないため）
        var previous = NativeMethods.SetThreadDpiAwarenessContext(NativeMethods.DpiAwarenessContextPerMonitorAwareV2);
        try
        {
            var monitor = NativeMethods.MonitorFromWindow(hwnd, NativeMethods.MonitorDefaultToNearest);
            var info = new NativeMethods.MONITORINFO { cbSize = Marshal.SizeOf<NativeMethods.MONITORINFO>() };
            if (!NativeMethods.GetMonitorInfo(monitor, ref info))
            {
                throw new UserFacingException(L("Excel のウィンドウがある画面の大きさを調べられませんでした。", "Could not get the size of the screen that shows the Excel window."));
            }

            int dpi = NativeMethods.GetDpiForMonitor(monitor, NativeMethods.MdtEffectiveDpi, out uint dpiX, out _) == 0 ? (int)dpiX : 96;
            var work = info.rcWork;
            var plan = ExcelWindowSizing.Plan(width, scale, work.Right - work.Left, dpi);
            if (!plan.Fits)
            {
                throw new UserFacingException(L(
                    $"幅 {width}px（拡大率 {scale * 100:0}%、アプリから見た幅 {plan.LogicalWidth:0}px）は、Excel のある画面の作業領域（{plan.WorkAreaLogicalWidth:0}px）より広いため、Excel のウィンドウを合わせられません。もっと広い画面で試すか、幅を狭くしてください。",
                    $"The width {width}px (scale {scale * 100:0}%, {plan.LogicalWidth:0}px as seen by apps) is wider than the work area of the screen that shows Excel ({plan.WorkAreaLogicalWidth:0}px), so the Excel window cannot be resized. Try a wider screen or a narrower width."));
            }

            // 収まると分かってから、Excel 2013 以降（SDI）ではブックごとのウィンドウを前にする（Application.Width はアクティブなウィンドウに効くため）
            string? workbookName = null;
            if (book is not null)
            {
                dynamic wb = book;
                Safe(() => { wb.Activate(); return true; });
                workbookName = Safe(() => (string)wb.Name);
                hwnd = new IntPtr((long)app.Hwnd);
            }

            // xlNormal（-4143）。最大化・最小化のままでは Width を入れても効かない
            app.WindowState = -4143;
            app.Width = plan.Points;

            // 入れた幅になったかを GetWindowRect で測る。2px より大きくずれていたら、差の分だけ 1 回だけ直す
            // （Width の換算が枠の分などでずれる場合に備える。直しても合わなければ、測った幅をそのまま知らせる）
            int expected = ExcelWindowSizing.ExpectedPhysicalWidth(plan.LogicalWidth, dpi);
            int? actual = null;
            if (NativeMethods.GetWindowRect(hwnd, out var measured))
            {
                actual = measured.Right - measured.Left;
                var correction = ExcelWindowSizing.CorrectionPoints(actual.Value, expected, dpi);
                if (correction != 0)
                {
                    Safe(() => { app.Width = (double)app.Width + correction; return true; });
                    if (NativeMethods.GetWindowRect(hwnd, out var again))
                    {
                        actual = again.Right - again.Left;
                    }
                }
            }

            // 右（または左）にはみ出したら、作業領域に収まるよう左端を動かす（はみ出したままだとリボンの右端が見えない）
            if (NativeMethods.GetWindowRect(hwnd, out var rect))
            {
                var delta = ExcelWindowSizing.LeftAdjustmentPoints(rect.Left, rect.Right, work.Left, work.Right, dpi);
                if (delta != 0)
                {
                    Safe(() => { app.Left = (double)app.Left + delta; return true; });
                }
            }

            return new WindowWidthResult(plan.Points, plan.LogicalWidth, plan.WorkAreaLogicalWidth, workbookName, actual, expected);
        }
        finally
        {
            if (previous != IntPtr.Zero)
            {
                NativeMethods.SetThreadDpiAwarenessContext(previous);
            }
        }
    });

    /// <summary>マクロを実行中か（<see cref="RunMacroAsync"/> の間）。COM のスレッドの外から読む。</summary>
    public bool IsMacroRunning => Volatile.Read(ref _macroRunning) != 0;

    /// <summary>マクロの実行中に出す文言（UI の実行中の通知と同じ）。</summary>
    public static string MacroRunningMessage => L("Excel でマクロを実行中です（Excel 側でメッセージやエラーを閉じると戻ります）。",
        "A macro is running in Excel (Sash continues when you close the message or error in Excel).");

    /// <summary>
    /// マクロの実行中なら、すぐに断る（COM のスレッドがマクロでふさがっているので、並べても終わるまで待たされ、
    /// 利用者には Sash が固まったように見えるため）。要求の入り口（COM のスレッドの外）で呼ぶ。
    /// </summary>
    public void ThrowIfMacroRunning()
    {
        if (IsMacroRunning)
        {
            throw new UserFacingException(MacroRunningMessage + " " + L("終わってから、もう一度やり直してください。", "Try again after it finishes."));
        }
    }

    /// <summary>
    /// 開いているブックのマクロを Application.Run で実行する（「試しに押す」。仕様書 §18.4）。
    /// 呼べるのは、引数のない Sub と、IRibbonControl（または Object・Variant）を 1 つ受け取る Sub。後者は control に Nothing を渡す
    /// （Application.Run からは本物の IRibbonControl を作れないため。Sub の中で control.Id などを使うと実行時エラーになる）。
    /// それ以外の形は理由を添えて断る。ブックは書き換えない（IRibbonControl の代わりを差し込むためにコードを足すことはしない）。
    /// VBA を読めるとき（信頼の設定がオン）は宣言から決め、読めないときは UI が XML から決めた呼び方（argument）に従う。
    /// 実行の間（MsgBox を出しているあいだなど）は COM のスレッドがふさがるので、その間のほかの Excel 連携は
    /// <see cref="ThrowIfMacroRunning"/> ですぐに断る。Windows 実機の Excel では確かめていない（Nothing の渡し方を含む）。
    /// </summary>
    public async Task<bool> RunMacroAsync(string fullPath, string macro, MacroCallShape? argument = null)
    {
        if (string.IsNullOrEmpty(fullPath))
        {
            throw new UserFacingException(L("ファイルが保存されていないため、マクロを実行できません。", "The file has not been saved, so the macro cannot be run."));
        }

        var (module, procedure) = VbaProcedureLookup.Split(macro);
        // VBA を読めないときも名前は必ず確かめる（Application.Run に渡す名前は Sash が組み立てるため、記号の混ざった名前は通さない）
        if (!VbaProcedureLookup.IsVbaIdentifier(procedure) || (module is not null && !VbaProcedureLookup.IsVbaIdentifier(module)))
        {
            throw new UserFacingException(L($"マクロの名前（{macro}）が VBA の名前として正しくないため、実行できません。", $"The macro name ({macro}) is not a valid VBA name, so it cannot be run."));
        }

        if (Interlocked.CompareExchange(ref _macroRunning, 1, 0) != 0)
        {
            throw new UserFacingException(MacroRunningMessage);
        }

        try
        {
            return await _com.InvokeAsync(() => RunMacroCore(fullPath, module, procedure, argument)).ConfigureAwait(false);
        }
        finally
        {
            Volatile.Write(ref _macroRunning, 0);
        }
    }

    private bool RunMacroCore(string fullPath, string? module, string procedure, MacroCallShape? argument)
    {
        var found = FindWorkbook(fullPath) ?? throw new UserFacingException(L("ブックがExcelで開かれていません。Excel で開いてから試してください。", "The workbook is not open in Excel. Open it in Excel, then try again."));
        var (app, wb) = found;
        var shape = argument ?? MacroCallShape.NoArguments;
        bool checkedSignature = false;
        dynamic? project = TryGetProjectQuietly(wb);
        if (project is not null)
        {
            string? parameters = null;
            foreach (var c in Safe(() => (List<object>)Enumerate(project.VBComponents)) ?? [])
            {
                dynamic comp = c;
                if (module is not null && !string.Equals(Safe(() => (string)comp.Name), module, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string code = Safe(() => { dynamic cm = comp.CodeModule; int n = cm.CountOfLines; return n > 0 ? (string)cm.Lines(1, n) : string.Empty; }) ?? string.Empty;
                parameters = VbaProcedureLookup.FindParameters(code, procedure);
                if (parameters is not null)
                {
                    break;
                }
            }

            if (parameters is null)
            {
                throw new UserFacingException(L($"VBA に {procedure} が見つかりません。", $"{procedure} was not found in the VBA project."));
            }

            shape = VbaProcedureLookup.Classify(parameters, out var reason);
            if (shape == MacroCallShape.Unsupported)
            {
                throw new UserFacingException($"{procedure}: {reason}");
            }

            checkedSignature = true;
        }
        else if (shape == MacroCallShape.Unsupported)
        {
            throw new UserFacingException(L($"{procedure} は Sash から実行できない形のコールバックです。Excel のリボンから押して試してください。", $"{procedure} is a callback that Sash cannot run. Try it from the ribbon in Excel."));
        }

        // マクロが MsgBox などを出したときに Sash の後ろに隠れないよう、Excel を前に出す（失敗しても実行は続ける）
        Safe(() => NativeMethods.SetForegroundWindow(new IntPtr((long)app.Hwnd)));
        var name = VbaProcedureLookup.QualifiedName((string)wb.Name, module, procedure);
        try
        {
            if (shape == MacroCallShape.RibbonControl)
            {
                // control As IRibbonControl に Nothing を渡す。null の DispatchWrapper は VT_DISPATCH の空（Nothing）として渡る。
                // ただの null だと VT_EMPTY（Missing）になり、引数を省いたとみなされて「マクロを実行できません」になるため
                app.Run(name, new DispatchWrapper(null));
            }
            else
            {
                app.Run(name);
            }

            return true;
        }
        catch (COMException ex) when (!IsBusy(ex))
        {
            throw new UserFacingException(checkedSignature
                ? L($"マクロ {procedure} の実行中にエラーが起きました：{ex.Message}", $"An error occurred while running the macro {procedure}: {ex.Message}")
                : L($"マクロ {procedure} を実行できませんでした（{ex.Message}）。引数の形が合っていない可能性があります。Excel のリボンから押して試してください。", $"Could not run the macro {procedure} ({ex.Message}). Its arguments may not match. Try it from the ribbon in Excel."), ex);
        }
    }

    /// <summary>
    /// VBE を表示し、指定の Sub の宣言行を選ぶ（コールバック一覧から VBE の該当の Sub へ移る。仕様書 §18.5）。
    /// ProcStartLine は Sub の前のコメント行から数えるので、宣言そのものの行（ProcBodyLine）を選ぶ。kind は vbext_pk_Proc（0）。
    /// Windows 実機の Excel では確かめていない。
    /// </summary>
    public Task<bool> RevealVbaAsync(string fullPath, string moduleName, string procedure) => _com.InvokeAsync(() =>
    {
        try
        {
            dynamic project = RequireProject(fullPath, out _);
            dynamic? comp = Safe(() => (object?)project.VBComponents.Item(moduleName));
            if (comp is null)
            {
                throw new UserFacingException(L($"モジュール {moduleName} が見つかりません。コールバック一覧を再読み込みしてください。", $"The module {moduleName} was not found. Please reload the callback list."));
            }

            dynamic cm = comp.CodeModule;
            int line;
            try
            {
                line = cm.ProcBodyLine(procedure, 0);
            }
            catch (COMException ex)
            {
                throw new UserFacingException(L($"{moduleName} に {procedure} が見つかりません。コールバック一覧を再読み込みしてください。", $"{procedure} was not found in {moduleName}. Please reload the callback list."), ex);
            }

            dynamic vbe = project.VBE;
            vbe.MainWindow.Visible = true;
            dynamic pane = cm.CodePane;
            pane.Show();
            // 宣言の行をまるごと選ぶ（カーソルを置くだけだと、どの行か見つけにくいため）。終わりの桁は行の長さ + 1
            int length = SafeValue(() => ((string)cm.Lines(line, 1)).Length) ?? 0;
            pane.SetSelection(line, 1, line, length + 1);
            // 選んだ行が見える位置に来るよう、少し上の行から表示する
            Safe(() => { pane.TopLine = Math.Max(1, line - 3); return true; });
            Safe(() => NativeMethods.SetForegroundWindow(new IntPtr((long)vbe.MainWindow.HWnd)));
            return true;
        }
        catch (COMException ex)
        {
            throw VbaFailure(ex);
        }
    });

    /// <summary>VBA プロジェクトを読めれば返す。信頼の設定がオフ・保護されている・忙しいなどで読めなければ null（例外にしない）。</summary>
    private static dynamic? TryGetProjectQuietly(dynamic wb)
    {
        try
        {
            return TryGetProject(wb, out VbaReadStatus _);
        }
        catch (UserFacingException)
        {
            return null;
        }
    }

    // ---- imageMso / 表示名（仕様書 §9.1） ----

    /// <summary>
    /// アイコンや表示名の取得に使う Excel。起動中のものがあればそれを、なければ見えない Excel を起動する。
    /// 起動した Excel は、使い終わるたびに <see cref="ReleaseHelperIfIdle"/> で片付ける。
    /// </summary>
    private dynamic HelperApp()
    {
        // 終了処理に入った後は、新しい Excel を起動しない（片付けの後に起動すると、見えない Excel が残ってしまう）
        ObjectDisposedException.ThrowIf(_disposing, this);
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
            try
            {
                _helperApp.Visible = false;
                _helperApp.DisplayAlerts = false;
            }
            catch (Exception ex) when (IsComFailure(ex))
            {
                // 起動した直後の設定で失敗しても、起動した Excel を残さない
                ReleaseHelperIfIdle();
                throw;
            }
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

            // 見えるかどうかが読めなくても、ブックがなければ Sash が起動したままの Excel なので終わらせる
            // （起動直後の設定に失敗した Excel を残さないため）
            if (count == 0 && visible != true)
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
    /// imageMso を PNG で返す（仕様書 §17.7）。**キャッシュだけを引き、Excel には触れない。**
    /// 存在しない名前（キャッシュに「存在しない」と記録済み）は null、キャッシュにない名前は結果に含めない
    /// （null にすると UI が「存在しない名前」と判定してしまうため。UI は 60 秒後に取り直す）。
    /// 以前はキャッシュにない名前を起動中の Excel から 1 件ずつ取っていたが、実機では Sash（別のプロセス）から呼んだ
    /// GetImageMso は E_UNEXPECTED を返し、画像は取れなかった。Excel の中で取り出せるのは一括の取り込み
    /// （<see cref="CreateBulkSource"/>）だけなので、足りない名前は UI が出す取り込みの状態（「アイコンを取り込む」）から取り込んでもらう。
    /// </summary>
    public async Task<Dictionary<string, byte[]?>> GetImageMsoAsync(IReadOnlyList<string> names, int size)
    {
        var lookup = await Task.Run(() => _iconCache.Lookup(names ?? [], size)).ConfigureAwait(false);
        if (lookup.Misses.Count > 0)
        {
            _onceLog.Write("ondemand:cacheonly", $"imageMso: キャッシュにない名前は 1 件ずつは取らない（一括の取り込みで取る。例：{lookup.Misses[0]}）");
        }

        return lookup.Found;
    }

    /// <summary>
    /// 一括の取り込み（<see cref="ImageMsoPrefetch"/>）で使う取り出し口。利用者が使っている Excel を何千回も呼んで
    /// 重くしないよう、取り込み専用の見えない Excel を起動し、作業用のブックに一時的な VBA モジュールを入れて
    /// Excel の中で取り出させ、終わったら閉じる。
    /// </summary>
    public IImageMsoBatchSource CreateBulkSource() => new BulkSource(this);

    private sealed class BulkSource(ExcelService owner) : IImageMsoBatchSource
    {
        public Task<string?> BeginAsync(CancellationToken cancellationToken) => owner._com.InvokeAsync(() =>
        {
            // 起動し直しの回数は取り込みごとに数える（取り込みのたびに 1 回までやり直せる）
            owner._bulkRestarts = 0;
            owner._bulkStats = default;
            return owner.StartBulkApp();
        });

        public Task<IReadOnlyList<ImageMsoFetchResult>> FetchAsync(IReadOnlyList<string> names, int size, CancellationToken cancellationToken) =>
            owner._com.InvokeAsync(() => owner.FetchBulk(names, size, cancellationToken));

        public async Task EndAsync()
        {
            var end = owner._com.InvokeAsync(() =>
            {
                var s = owner._bulkStats;
                owner.Log?.Invoke($"imageMso: 取り込み専用の Excel での取り出しの集計：画像 {s.Found} 件、存在しない名前 {s.Missing} 件、取り出せなかった {s.Failed} 件、起動し直し {owner._bulkRestarts} 回");
                owner.ReleaseBulkApp(force: false);
                return true;
            });

            // COM のスレッドが Excel の応答を待ったまま戻らないと、取り込みが「実行中」のまま終わらなくなる。
            // 待つのは一定の時間までにし、それでも終わらなければ Sash が起動した Excel だけを終わらせる
            if (await Task.WhenAny(end, Task.Delay(EndLimit)).ConfigureAwait(false) != end)
            {
                owner.Log?.Invoke($"imageMso: 取り込み専用の Excel の片付けが {EndLimit.TotalSeconds:0} 秒で終わらないため、Sash が起動したその Excel を終わらせる");
                owner.KillBulkProcess();
                return;
            }

            await end.ConfigureAwait(false);
        }
    }

    /// <summary>取り込み専用の Excel の準備（起動・作業用のブック・モジュール・試しの取り出し）にかけてよい時間。</summary>
    private static readonly TimeSpan StartLimit = TimeSpan.FromSeconds(30);

    /// <summary>
    /// 準備の途中で 1 つの呼び出しが戻らないときに、Sash が起動した Excel を終わらせるまでの時間。
    /// メッセージ フィルターは断られた呼び出しを 10 秒までやり直すので、それより長く、<see cref="StartLimit"/> より少し長くする。
    /// </summary>
    private static readonly TimeSpan StartWatchdog = TimeSpan.FromSeconds(40);

    /// <summary>片付けを待つ時間。</summary>
    private static readonly TimeSpan EndLimit = TimeSpan.FromSeconds(45);

    /// <summary>1 回の取り込みで、取り込み専用の Excel を起動し直してよい回数（起動と失敗を繰り返し続けないため）。</summary>
    private const int MaxBulkRestarts = 1;

    private static string TrustRequiredMessage => L(
        "Excel の「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」をオンにすると、組み込みアイコンを取り込めます（Excel の［ファイル］→［オプション］→［トラスト センター］→［トラスト センターの設定］→［マクロの設定］）。オンにしてから、設定の「アイコン」で取り込み直してください。",
        "Turn on \"Trust access to the VBA project object model\" in Excel to import the built-in icons (File > Options > Trust Center > Trust Center Settings > Macro Settings). Then import again from Settings > Icons.");

    /// <summary>
    /// 取り込み専用の見えない Excel を起動し、作業用のブックと VBA モジュールを用意して、版（Version と Build。例：16.0.19029）を返す。
    /// COM スレッドで呼ぶ。準備が <see cref="StartLimit"/> を超えたり、途中で 1 つの呼び出しが戻らなかったりしたら、
    /// 起動した Excel を終わらせて（Quit できなければプロセスを終わらせて）失敗を返す。
    /// </summary>
    private string? StartBulkApp()
    {
        ObjectDisposedException.ThrowIf(_disposing, this);
        ReleaseBulkApp(force: false);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        Volatile.Write(ref _startTimedOut, 0);
        Volatile.Write(ref _bulkStarting, 1);

        // 呼び出しが戻らない（Excel が見えないダイアログを出しているなど）と、この COM のスレッドは止まったままになる。
        // 別のスレッドのタイマーで、Sash が起動した Excel のプロセスだけを終わらせると、待っている呼び出しが失敗して戻ってくる
        using var watchdog = new Timer(_ => OnStartWatchdog(), null, StartWatchdog, Timeout.InfiniteTimeSpan);
        try
        {
            return StartBulkAppCore(sw);
        }
        catch (Exception ex) when (ex is not ObjectDisposedException)
        {
            var timedOut = Volatile.Read(ref _startTimedOut) != 0 || sw.Elapsed > StartLimit;
            Log?.Invoke($"imageMso: 取り込み専用の Excel の準備に失敗（{sw.Elapsed.TotalSeconds:0.0} 秒）: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");

            // 時間切れなら Excel は応答しないので、Quit などを待たずにプロセスを終わらせる
            ReleaseBulkApp(force: timedOut);
            if (timedOut)
            {
                throw new UserFacingException(L(
                    $"取り込み専用の Excel が {StartLimit.TotalSeconds:0} 秒たっても準備できなかったため、取り込みをやめました（Excel がメッセージを出しているか、起動に時間がかかっています）。",
                    $"The Excel instance started for the import was not ready after {StartLimit.TotalSeconds:0} seconds, so the import was stopped (Excel may be showing a message or starting slowly)."), ex);
            }

            if (ex is UserFacingException)
            {
                throw;
            }

            throw new UserFacingException(L($"取り込み専用の Excel を準備できませんでした：{ex.Message}", $"Could not prepare Excel for the import: {ex.Message}"), ex);
        }
        finally
        {
            Volatile.Write(ref _bulkStarting, 0);
        }
    }

    private string? StartBulkAppCore(System.Diagnostics.Stopwatch sw)
    {
        var type = Type.GetTypeFromProgID("Excel.Application", throwOnError: true)!;

        // 起動する前からある Excel のプロセス（利用者の Excel）。万一、取り違えても、これらは決して終わらせない
        var before = ExcelProcessIds();

        // CreateObject と同じく、利用者の Excel とは別の Excel が起動する
        _bulkApp = Activator.CreateInstance(type)!;
        dynamic app = _bulkApp;
        RememberBulkProcess(_bulkApp, before);
        app.Visible = false;
        app.DisplayAlerts = false;

        string? version = Safe(() => (string)app.Version);
        string? build = Safe(() => Convert.ToString((object)app.Build, System.Globalization.CultureInfo.InvariantCulture));
        var text = version is null ? null : build is null ? version : $"{version}.{build}";
        Log?.Invoke($"imageMso の取り込みのため見えない Excel を起動（版 {text ?? "不明"}、{(Environment.Is64BitProcess ? "Sash は 64bit" : "Sash は 32bit")}、プロセス {(_bulkPid == 0 ? "不明" : _bulkPid.ToString(System.Globalization.CultureInfo.InvariantCulture))}）");
        CheckStartLimit(sw, "起動");

        // Sash が開くブックのマクロを有効にする（msoAutomationSecurityLow = 1）。自動化で起動した Excel の既定も
        // これのはずだが、実機で「マクロを実行できません」が出たため、明示する。グループ ポリシーで変えられない環境もあるので失敗は記録だけ
        int? security = SafeValue(() => (int)app.AutomationSecurity);
        try
        {
            app.AutomationSecurity = 1;
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            Log?.Invoke($"imageMso: AutomationSecurity を変えられなかった（いまの値 {security?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "不明"}）: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
        }

        // VBA のモジュールを入れる先。見えないまま開き、終わったら保存せずに閉じる
        _bulkScratch = app.Workbooks.Add();
        CheckStartLimit(sw, "作業用のブック");

        InjectBulkModule();
        CheckStartLimit(sw, "VBA モジュール");

        ProbeBulkModule(sw);
        return text;
    }

    private static void CheckStartLimit(System.Diagnostics.Stopwatch sw, string step)
    {
        if (sw.Elapsed > StartLimit)
        {
            throw new TimeoutException($"{step}の後で {sw.Elapsed.TotalSeconds:0.0} 秒");
        }
    }

    /// <summary>準備が終わらないまま <see cref="StartWatchdog"/> がたったら、Sash が起動した Excel だけを終わらせる。タイマーのスレッドで呼ぶ。</summary>
    private void OnStartWatchdog()
    {
        if (Volatile.Read(ref _bulkStarting) == 0)
        {
            return;
        }

        Volatile.Write(ref _startTimedOut, 1);
        Log?.Invoke($"imageMso: 取り込み専用の Excel の準備が {StartWatchdog.TotalSeconds:0} 秒たっても終わらないため、Sash が起動したその Excel を終わらせる");
        KillBulkProcess();
    }

    /// <summary>
    /// 作業用のブックに VBA モジュールを入れ、Application.Run で呼ぶ名前を決める。
    /// 「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」がオフなら、その設定を案内する失敗にする。
    /// </summary>
    private void InjectBulkModule()
    {
        dynamic wb = _bulkScratch!;
        dynamic project;
        try
        {
            project = wb.VBProject;
            _ = project.VBComponents.Count;
        }
        catch (COMException ex) when (!IsBusy(ex) && IsTrustDenied(ex))
        {
            Log?.Invoke($"imageMso: VBA モジュールを入れられなかった（VBA プロジェクトへのアクセスが信頼されていない）: 0x{ex.HResult:X8} {ex.Message}");
            throw new UserFacingException(TrustRequiredMessage, ex);
        }

        dynamic component = project.VBComponents.Add(VbextStdModule);
        _bulkModule = component;
        component.Name = ImageMsoVbaExport.ModuleName;
        component.CodeModule.AddFromString(ImageMsoVbaExport.ModuleSource);

        // 確認用の小さな関数を、別のモジュールに入れる。これが呼べて本体が呼べなければ本体のコンパイルの問題、
        // これも呼べなければ名前の書き方かマクロの設定の問題、と切り分けられるようにするため。
        // このモジュールは取り除かない（作業用のブックは保存せずに閉じるので残らない）
        dynamic ping = project.VBComponents.Add(VbextStdModule);
        ping.Name = "SashImageMsoPing";
        ping.CodeModule.AddFromString("Public Function SashPing() As Long\r\n    SashPing = 1\r\nEnd Function\r\n");
        Release(ping);

        // 名前を書かない呼び方は作業中のブックから探すので、作業用のブックを前に出しておく
        _ = Safe(() => { wb.Activate(); return true; });

        string bookName = wb.Name;
        _bulkMacro = ResolveMacroName(bookName);
        Log?.Invoke($"imageMso: 作業用のブックに VBA モジュールを入れた（{_bulkMacro}）");
    }

    /// <summary>
    /// Application.Run で呼ぶ名前の書き方を決める。実機で「'Book2'!モジュール.関数」が「マクロを実行できません」に
    /// なったので、確認用の関数をいくつかの書き方で呼び、呼べた書き方を本体にも使う。結果はすべて記録する。
    /// </summary>
    private string ResolveMacroName(string bookName)
    {
        var quoted = $"'{bookName.Replace("'", "''", StringComparison.Ordinal)}'";
        string[] prefixes = ["", "SashImageMsoPing.", $"{bookName}!SashImageMsoPing.", $"{quoted}!SashImageMsoPing."];
        string[] mainForms =
        [
            ImageMsoVbaExport.FunctionName,
            $"{ImageMsoVbaExport.ModuleName}.{ImageMsoVbaExport.FunctionName}",
            $"{bookName}!{ImageMsoVbaExport.ModuleName}.{ImageMsoVbaExport.FunctionName}",
            $"{quoted}!{ImageMsoVbaExport.ModuleName}.{ImageMsoVbaExport.FunctionName}",
        ];
        var failures = new List<string>();
        for (var i = 0; i < prefixes.Length; i++)
        {
            var name = prefixes[i] + "SashPing";
            try
            {
                object? r = _bulkApp!.Run(name);
                if (r is not null && Convert.ToInt32(r, System.Globalization.CultureInfo.InvariantCulture) == 1)
                {
                    _bulkPingWorked = true;
                    Log?.Invoke($"imageMso: 確認用の関数を呼べた（{name}）{(failures.Count > 0 ? "。呼べなかった書き方：" + string.Join(" / ", failures) : string.Empty)}");
                    return mainForms[i];
                }

                failures.Add($"{name} → 戻り値 {r ?? "なし"}");
            }
            catch (Exception ex) when (IsComFailure(ex) || ex is FormatException or InvalidCastException)
            {
                failures.Add($"{name} → 0x{ex.HResult:X8} {ex.Message}");
            }
        }

        _bulkPingWorked = false;
        int? security = SafeValue(() => (int)((dynamic)_bulkApp!).AutomationSecurity);
        Log?.Invoke($"imageMso: 確認用の関数をどの書き方でも呼べなかった（AutomationSecurity {security?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "不明"}）。マクロの実行が止められている可能性: {string.Join(" / ", failures)}");
        return mainForms[^1];
    }

    /// <summary>
    /// 確実にある FileSave を Excel の中で取り出してみて、結果を記録する。起動したてで取れないことがあるので、
    /// 準備の時間の範囲で少し待ってやり直す。取れなくても準備は失敗にしない（まとまりの取り出しで数え、続けて取れなければ打ち切る）。
    /// </summary>
    private void ProbeBulkModule(System.Diagnostics.Stopwatch sw)
    {
        for (var attempt = 1; ; attempt++)
        {
            var result = RunExport(["FileSave"], 32, countStats: false).Single();
            if (result.Kind == ImageMsoFetchKind.Found)
            {
                Log?.Invoke($"imageMso: Excel の中（VBA）で FileSave を取り出せた（{attempt} 回目、{sw.Elapsed.TotalSeconds:0.0} 秒）");
                return;
            }

            if (result.Kind == ImageMsoFetchKind.Missing)
            {
                // 確実にある名前が「存在しない」と返るなら、存在しないことの見分け（E_INVALIDARG）がこの PC では当てにならない。
                // このまま続けると、すべての名前を「存在しない」とキャッシュに記録してしまい、取り直されなくなるので止める
                throw new UserFacingException(L(
                    "Excel が組み込みアイコン（FileSave）を「存在しない」と返したため、取り込みをやめました。詳しい理由は %AppData%\\Sash\\logs\\app.log に記録しました。",
                    "Excel reported the built-in icon (FileSave) as missing, so the import was stopped. The details were written to %AppData%\\Sash\\logs\\app.log."));
            }

            if (attempt >= 5 || sw.Elapsed + TimeSpan.FromSeconds(1) > StartLimit)
            {
                Log?.Invoke($"imageMso: Excel の中（VBA）でも FileSave を取り出せなかった（{attempt} 回、{result.Kind}）。理由は直前の記録を参照");
                return;
            }

            Thread.Sleep(500);
        }
    }

    /// <summary>一括の取り込みの 1 まとまり。COM スレッドで呼ぶ。</summary>
    private IReadOnlyList<ImageMsoFetchResult> FetchBulk(IReadOnlyList<string> names, int size, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposing, this);
        if (_bulkApp is null || !IsAlive(_bulkApp))
        {
            // 取り込み中に Excel が終わった（利用者がタスク マネージャーで終わらせたなど）か、応答しない
            RestartBulkApp("imageMso の取り込み用の Excel が応答しないため、起動し直す");
        }
        else
        {
            // 取り込みの最中に利用者がブックをダブルクリックすると、Windows がこの見えない Excel に開かせることがある。
            // そのまま使い続けると利用者のブックが見えないままになり、最後に Quit すると閉じてしまうので、
            // ブックが入っていたらこの Excel は見えるようにして利用者に引き渡し（Quit しない）、新しい見えない Excel で続ける
            dynamic current = _bulkApp!;
            int? count = SafeValue(() => (int)current.Workbooks.Count);

            // 作業用のブックは数に入れない
            if (count > (_bulkScratch is null ? 0 : 1))
            {
                RestartBulkApp("imageMso の取り込み用の Excel でブックが開かれたため、その Excel を利用者に引き渡し、別の Excel で続ける");
            }
        }

        if (ct.IsCancellationRequested)
        {
            return [];
        }

        // VBA のファイルの入出力は ANSI なので、ASCII でない名前は渡さない（imageMso の名前は ASCII なので、Excel にもない）
        var results = names.Where(n => !ImageMsoVbaExport.CanSend(n)).Select(n => new ImageMsoFetchResult(n, ImageMsoFetchKind.Missing)).ToList();
        var send = names.Where(ImageMsoVbaExport.CanSend).ToList();
        if (send.Count > 0)
        {
            results.AddRange(RunExport(send, size, countStats: true));
        }

        return results;
    }

    /// <summary>取り込み専用の Excel を起動し直す。1 回の取り込みで <see cref="MaxBulkRestarts"/> 回まで。</summary>
    private void RestartBulkApp(string reason)
    {
        Log?.Invoke(reason);
        if (++_bulkRestarts > MaxBulkRestarts)
        {
            throw new UserFacingException(L(
                "取り込み専用の Excel が続けて使えなくなったため、取り込みをやめました。取り込めた分は使えます。",
                "The Excel instance used for the import stopped working repeatedly, so the import was stopped. The icons imported so far can be used."));
        }

        StartBulkApp(); // 中で ReleaseBulkApp が、ブックの入った Excel を見えるようにして引き渡す
    }

    /// <summary>
    /// 名前の一覧をファイルに書き、VBA の関数を Application.Run で呼んで、書かれた結果を読む。COM スレッドで呼ぶ。
    /// Run が失敗したら（Excel が応答しない、マクロを実行できないなど）、そのまとまりはすべて「取り出せなかった」にする
    /// （続けば <see cref="ImageMsoPrefetch.GiveUpAfter"/> で打ち切られ、理由はログに残る）。
    /// </summary>
    private List<ImageMsoFetchResult> RunExport(IReadOnlyList<string> names, int size, bool countStats)
    {
        var batchDir = Path.Combine(EnsureBulkTempDir(), (++_bulkBatch).ToString(System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(batchDir);
        List<ImageMsoFetchResult> results;
        try
        {
            var listPath = Path.Combine(batchDir, "names.txt");
            ImageMsoVbaExport.WriteNameList(listPath, names);
            try
            {
                object? processed = _bulkApp!.Run(_bulkMacro!, listPath, batchDir, size);
                var count = processed is null ? (int?)null : Convert.ToInt32(processed, System.Globalization.CultureInfo.InvariantCulture);
                if (count != names.Count)
                {
                    _onceLog.Write("vba-count", $"imageMso: VBA が処理した数が合わない（{count?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "なし"} / {names.Count}）");
                }
            }
            catch (Exception ex) when (IsComFailure(ex) || ex is FormatException or OverflowException)
            {
                var hint = _bulkPingWorked ? "。確認用の関数は呼べたので、取り出し用のモジュールがコンパイルできていない可能性がある" : string.Empty;
                _onceLog.Write($"vba-run:{ex.GetType().Name}:{ex.HResult:X8}", $"imageMso: VBA の関数を呼べなかった（{_bulkMacro}）: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}{hint}");
            }

            // Run が途中で失敗しても、それまでに書かれた分は使う
            results = ImageMsoVbaExport.ReadResults(batchDir, names, size, (key, message) => _onceLog.Write(key, message));
        }
        finally
        {
            TryDeleteDirectory(batchDir);
        }

        if (countStats)
        {
            foreach (var r in results)
            {
                _bulkStats = r.Kind switch
                {
                    ImageMsoFetchKind.Found => _bulkStats with { Found = _bulkStats.Found + 1 },
                    ImageMsoFetchKind.Missing => _bulkStats with { Missing = _bulkStats.Missing + 1 },
                    _ => _bulkStats with { Failed = _bulkStats.Failed + 1 },
                };
            }
        }

        return results;
    }

    /// <summary>
    /// 取り込みの一時フォルダ（%TEMP%\Sash\imagemso\&lt;guid&gt;）。VBA の Open は ANSI のパスしか扱えないので、
    /// ASCII でない文字を含むときは短い名前（8.3 形式）を試す。
    /// </summary>
    private string EnsureBulkTempDir()
    {
        if (_bulkTempDir is not null && Directory.Exists(_bulkTempDir))
        {
            return _bulkTempDir;
        }

        var dir = Path.Combine(Path.GetTempPath(), "Sash", "imagemso", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        if (dir.Any(c => c > '~'))
        {
            var buffer = new char[1024];
            var length = NativeMethods.GetShortPathName(dir, buffer, buffer.Length);
            var shortPath = length > 0 && length < buffer.Length ? new string(buffer, 0, (int)length) : null;
            if (shortPath is not null && shortPath.All(c => c <= '~'))
            {
                dir = shortPath;
            }
            else
            {
                _onceLog.Write("tempdir:nonascii", $"imageMso: 一時フォルダのパスに ASCII でない文字がある（VBA が開けないことがある）: {dir}");
            }
        }

        _bulkTempDir = dir;
        return dir;
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 一時フォルダなので、消せなくても取り込みには関係しない（次の取り込みは別のフォルダを使う）
        }
    }

    /// <summary>
    /// 一括の取り込みのために起動した Excel を片付ける。COM スレッドで呼ぶ。
    /// 入れた VBA モジュールを取り除き、作業用のブックを保存せずに閉じてから、ブックがなければ Quit する。
    /// 利用者がブックを開いていたら、見えるようにして引き渡す（Quit しない）。Quit が断られたら、
    /// 最後の手段として Sash が起動したその Excel のプロセスだけを終わらせる（利用者の Excel は終わらせない）。
    /// force が true（応答しないと分かっている）なら、呼び出しを待たずにプロセスを終わらせる。
    /// </summary>
    private void ReleaseBulkApp(bool force)
    {
        var app = _bulkApp;
        _bulkApp = null;
        _bulkMacro = null;
        _bulkPingWorked = false;
        try
        {
            if (force)
            {
                KillBulkProcess();
                Release(_bulkModule);
                Release(_bulkScratch);
                _bulkModule = null;
                _bulkScratch = null;
                return;
            }

            RemoveBulkModule();
            CloseBulkScratch();
            if (app is null)
            {
                return;
            }

            dynamic a = app;
            int? count = SafeValue(() => (int)a.Workbooks.Count);
            if (count is null or 0)
            {
                // ブックがない（か、応答せず数が分からない）。Sash が起動したままの Excel なので終わらせる
                try
                {
                    a.Quit();
                }
                catch (Exception ex) when (IsComFailure(ex))
                {
                    Log?.Invoke($"imageMso: 取り込み専用の Excel を Quit できなかった: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
                    Release(app);
                    app = null;
                    KillBulkProcess();
                }
            }
            else
            {
                // 利用者のブックが入っている。見えるようにして引き渡す（警告の表示も元に戻す）
                Log?.Invoke($"imageMso: 取り込み専用の Excel にブックが {count} 個あるため、Quit せずに利用者に引き渡す");
                try
                {
                    a.DisplayAlerts = true;
                    a.Visible = true;
                    a.UserControl = true;
                }
                catch (Exception ex) when (IsComFailure(ex))
                {
                    Log?.Invoke($"imageMso: 取り込み専用の Excel を引き渡せなかった: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
                }
            }
        }
        finally
        {
            Release(app);
            Volatile.Write(ref _bulkPid, 0);
            if (_bulkTempDir is { } dir)
            {
                _bulkTempDir = null;
                TryDeleteDirectory(dir);
            }
        }
    }

    /// <summary>入れた VBA モジュールを取り除く（作業用のブックは保存せずに閉じるので、残らないための念のため）。</summary>
    private void RemoveBulkModule()
    {
        var module = _bulkModule;
        _bulkModule = null;
        if (module is null)
        {
            return;
        }

        try
        {
            dynamic wb = _bulkScratch!;
            wb.VBProject.VBComponents.Remove(module);
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            Log?.Invoke($"imageMso: VBA モジュールを取り除けなかった（作業用のブックは保存せずに閉じる）: {ex.GetType().Name} 0x{ex.HResult:X8} {ex.Message}");
        }
        finally
        {
            Release(module);
        }
    }

    /// <summary>作業用のブックを保存せずに閉じる。</summary>
    private void CloseBulkScratch()
    {
        var wb = _bulkScratch;
        _bulkScratch = null;
        if (wb is null)
        {
            return;
        }

        try
        {
            ((dynamic)wb).Close(false);
        }
        catch (Exception ex) when (IsComFailure(ex))
        {
            // Excel が先に終わっていたなど。閉じられなくても取り込みには関係しない
        }
        finally
        {
            Release(wb);
        }
    }

    /// <summary>いま動いている Excel のプロセスの番号。</summary>
    private static HashSet<int> ExcelProcessIds()
    {
        var ids = new HashSet<int>();
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("EXCEL"))
        {
            using (p)
            {
                ids.Add(p.Id);
            }
        }

        return ids;
    }

    /// <summary>
    /// 起動した Excel のプロセスを、ウィンドウ（Application.Hwnd）から調べて覚える。最後の手段で終わらせるのはこのプロセスだけ。
    /// 起動する前からあったプロセス（利用者の Excel）だったら覚えない（決して終わらせない）。
    /// </summary>
    private void RememberBulkProcess(object owned, HashSet<int> before)
    {
        dynamic app = owned;
        Volatile.Write(ref _bulkPid, 0);
        long hwnd = SafeValue(() => (long)app.Hwnd) ?? 0;
        if (hwnd == 0 || NativeMethods.GetWindowThreadProcessId(new IntPtr(hwnd), out var pid) == 0 || pid == 0)
        {
            Log?.Invoke("imageMso: 取り込み専用の Excel のプロセスを調べられなかった（応答しなくなっても終わらせられない）");
            return;
        }

        if (before.Contains((int)pid))
        {
            Log?.Invoke($"imageMso: 起動した Excel が既存のプロセス {pid} と同じだったため、終わらせる対象にしない");
            return;
        }

        try
        {
            using var process = System.Diagnostics.Process.GetProcessById((int)pid);
            Volatile.Write(ref _bulkPidStartTicks, process.StartTime.Ticks);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            Volatile.Write(ref _bulkPidStartTicks, 0);
        }

        Volatile.Write(ref _bulkPid, (int)pid);
    }

    /// <summary>
    /// Sash が起動した取り込み専用の Excel のプロセスを終わらせる（最後の手段）。どのスレッドからも呼べる。
    /// 番号が使い回されていないか（名前が EXCEL で、起動した時刻が同じか）を確かめてから終わらせる。
    /// </summary>
    private void KillBulkProcess()
    {
        var pid = Volatile.Read(ref _bulkPid);
        var started = Volatile.Read(ref _bulkPidStartTicks);
        if (pid == 0)
        {
            return;
        }

        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            if (process.HasExited)
            {
                return;
            }

            if (!string.Equals(process.ProcessName, "EXCEL", StringComparison.OrdinalIgnoreCase) || (started != 0 && process.StartTime.Ticks != started))
            {
                Log?.Invoke($"imageMso: プロセス {pid} は取り込み専用の Excel ではなくなっていたため、終わらせない");
                return;
            }

            process.Kill();
            process.WaitForExit(5000);
            Log?.Invoke($"imageMso: 応答しない取り込み専用の Excel（プロセス {pid}）を終わらせた");
        }
        catch (ArgumentException)
        {
            // すでに終わっている
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            Log?.Invoke($"imageMso: 取り込み専用の Excel（プロセス {pid}）を終わらせられなかった: {ex.GetType().Name} {ex.Message}");
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
        try
        {
            // 起動した Excel は、利用者のブックが入っていなければ終わらせ、入っていれば引き渡す
            // （取り込みの途中で Sash を閉じたときも、取り込み用の Excel を残さない）。
            // _helperApp と _bulkApp は COM のスレッドだけが書くので、ここ（UI のスレッド）で null かどうかを見て
            // 飛ばすことはしない。起動の途中（StartBulkApp の実行中）でも、片付けはその後ろに積まれて必ず走る。
            // _disposing を先に立てたので、片付けの後に新しい Excel は起動されない
            var release = _com.InvokeAsync(() =>
            {
                ReleaseHelperIfIdle();
                ReleaseBulkApp(force: false);
                return true;
            });
            if (!release.Wait(TimeSpan.FromSeconds(10)))
            {
                // COM のスレッドが応答しない Excel を待ったまま。取り込み専用の Excel を残さないよう、
                // Sash が起動したそのプロセスだけを終わらせる（利用者の Excel には触れない）
                KillBulkProcess();
            }
        }
        catch (AggregateException)
        {
            // 二度目の Dispose（COM のスレッドがもう終わっている）など
        }

        _com.Dispose();
    }
}
