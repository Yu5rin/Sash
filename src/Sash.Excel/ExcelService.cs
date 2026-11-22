using System.Runtime.InteropServices;
using System.Runtime.Versioning;
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

    private static readonly string[] MacroExtensions = [".xlsm", ".xlam", ".xltm", ".xlsb"];

    private readonly ComThread _com = new();
    private readonly string _iconCacheDir;
    private dynamic? _helperApp;

    public ExcelService(string iconCacheDir)
    {
        _iconCacheDir = iconCacheDir;
    }

    /// <summary>Excel の COM クラスが登録されているか。Excel を起動はしない。</summary>
    public static bool IsInstalled => Type.GetTypeFromProgID("Excel.Application", throwOnError: false) is not null;

    // ---- ブックの検索 ----

    public Task<IReadOnlyList<OpenWorkbookInfo>> ListOpenWorkbooksAsync() => _com.InvokeAsync<IReadOnlyList<OpenWorkbookInfo>>(() =>
    {
        var result = new List<OpenWorkbookInfo>();
        foreach (var app in RunningExcel.Applications())
        {
            foreach (var wb in Safe(() => (IEnumerable<object>)Enumerate(app.Workbooks)) ?? [])
            {
                AddIfMacroBook(result, (dynamic)wb, isAddIn: false);
            }

            // アドインとして読み込まれている xlam は Workbooks に出てこないので、AddIns2 から拾う
            foreach (var addIn in Safe(() => (IEnumerable<object>)Enumerate(app.AddIns2)) ?? [])
            {
                dynamic a = addIn;
                if (SafeValue(() => (bool)a.IsOpen) == true)
                {
                    string full = a.FullName;
                    var wb = TryGetWorkbook(app, full);
                    if (wb is not null)
                    {
                        AddIfMacroBook(result, wb, isAddIn: true);
                    }
                }
            }
        }

        return result.DistinctBy(w => w.FullPath, StringComparer.OrdinalIgnoreCase).ToList();
    });

    private static void AddIfMacroBook(List<OpenWorkbookInfo> list, dynamic wb, bool isAddIn)
    {
        string? full = Safe(() => (string)wb.FullName);
        if (full is null || !MacroExtensions.Any(e => full.EndsWith(e, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        list.Add(new OpenWorkbookInfo(full, isAddIn || SafeValue(() => (bool)wb.IsAddin) == true, SafeValue(() => (bool)wb.Saved) == false));
    }

    private static IEnumerable<object> Enumerate(dynamic collection)
    {
        int count = collection.Count;
        for (var i = 1; i <= count; i++)
        {
            yield return collection.Item(i);
        }
    }

    /// <summary>フルパスでブックを探す。アドインとして読み込まれている xlam も、名前を指定すれば取り出せる。</summary>
    private static dynamic? TryGetWorkbook(dynamic app, string fullPath)
    {
        foreach (var wb in Safe(() => (IEnumerable<object>)Enumerate(app.Workbooks)) ?? [])
        {
            if (string.Equals(Safe(() => (string)((dynamic)wb).FullName), fullPath, StringComparison.OrdinalIgnoreCase))
            {
                return wb;
            }
        }

        try
        {
            dynamic wb = app.Workbooks.Item(Path.GetFileName(fullPath));
            if (string.Equals((string)wb.FullName, fullPath, StringComparison.OrdinalIgnoreCase))
            {
                return wb;
            }
        }
        catch (COMException)
        {
        }

        return null;
    }

    private static (dynamic App, dynamic Workbook)? FindWorkbook(string fullPath)
    {
        foreach (var app in RunningExcel.Applications())
        {
            var wb = TryGetWorkbook(app, fullPath);
            if (wb is not null)
            {
                return (app, wb);
            }
        }

        return null;
    }

    private static dynamic? FindInstalledAddIn(dynamic app, string fullPath)
    {
        foreach (var a in Safe(() => (IEnumerable<object>)Enumerate(app.AddIns2)) ?? [])
        {
            dynamic addIn = a;
            if (string.Equals(Safe(() => (string)addIn.FullName), fullPath, StringComparison.OrdinalIgnoreCase) && SafeValue(() => (bool)addIn.Installed) == true)
            {
                return addIn;
            }
        }

        return null;
    }

    // ---- 反映（仕様書 §7.1） ----

    /// <summary>
    /// ブックを閉じて書き込み、開き直す。開いていなければ書き込むだけ。
    /// write は COM スレッドで呼ばれ、バックアップと書き込みを行う。
    /// </summary>
    public Task<ApplyResult> ApplyAsync(string fullPath, bool saveIfDirty, Action write, string? activateTabId = null) => _com.InvokeAsync(() =>
    {
        var found = FindWorkbook(fullPath);
        if (found is null)
        {
            write();
            return new ApplyResult(ApplyStatus.Written, L("Excelでは開かれていないので、ファイルに書き込みました", "The workbook is not open in Excel, so the changes were written to the file"));
        }

        var (app, wb) = found.Value;
        bool isAddIn = SafeValue(() => (bool)wb.IsAddin) == true;
        bool saved = SafeValue(() => (bool)wb.Saved) ?? true;
        if (!saved)
        {
            // 勝手には保存しない（仕様書 §7.1 の 3）
            if (!saveIfDirty)
            {
                return new ApplyResult(ApplyStatus.NeedsSave, L("Excel側に未保存の変更があります", "The workbook has unsaved changes in Excel"));
            }

            wb.Save();
        }

        var addIn = isAddIn ? FindInstalledAddIn(app, fullPath) : null;
        int protectedBefore = SafeValue(() => (int)app.ProtectedViewWindows.Count) ?? 0;

        // 閉じる。アドインとして読み込まれていた xlam は、アドインの読み込みを外して閉じる
        if (addIn is not null)
        {
            addIn.Installed = false;
        }
        else
        {
            wb.Close(false);
        }

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

        // 書き込みに失敗しても、元のブックは開き直しておく
        try
        {
            if (addIn is not null)
            {
                addIn.Installed = true;
            }
            else
            {
                OpenRespectingSecurity(app, fullPath);
            }
        }
        catch (COMException ex)
        {
            if (writeError is null)
            {
                return new ApplyResult(ApplyStatus.Blocked, L($"書き込みましたが、Excelで開き直せませんでした（{ex.Message}）。Excelで直接開いてください", $"The changes were written, but Excel could not reopen the workbook ({ex.Message}). Please open it in Excel"));
            }
        }

        if (writeError is not null)
        {
            throw new IOException(L($"書き込みに失敗しました。ブックは元のまま開き直しました：{writeError.Message}", $"Writing failed. The workbook was reopened unchanged: {writeError.Message}"), writeError);
        }

        int protectedAfter = SafeValue(() => (int)app.ProtectedViewWindows.Count) ?? 0;
        if (protectedAfter > protectedBefore)
        {
            return new ApplyResult(ApplyStatus.Blocked, L("反映しましたが、保護ビューで開かれています。Excelで［編集を有効にする］を押すとリボンが表示されます", "Applied, but the workbook opened in Protected View. Click Enable Editing in Excel to show the ribbon"));
        }

        if (TryGetWorkbook(app, fullPath) is null)
        {
            return new ApplyResult(ApplyStatus.Blocked, L("反映しましたが、ブックの再読み込みが確認できません。Excelの画面を確認してください", "Applied, but reopening the workbook could not be confirmed. Please check Excel"));
        }

        // 作ったタブを前面に出す（仕様書 §7.1 の 6）。外からは IRibbonUI を触れないので、
        // Sash が入れた共通コード（modRibbonCore）の SashActivateTab をブックの中で呼ぶ。なければ何もしない
        if (!string.IsNullOrEmpty(activateTabId))
        {
            TryActivateTab(app, fullPath, activateTabId);
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
    /// </summary>
    private static void OpenRespectingSecurity(dynamic app, string fullPath)
    {
        int? previous = SafeValue(() => (int)app.AutomationSecurity);
        try
        {
            app.AutomationSecurity = MsoAutomationSecurityByUI;
            app.Workbooks.Open(fullPath);
        }
        finally
        {
            if (previous is not null)
            {
                app.AutomationSecurity = previous.Value;
            }
        }
    }

    /// <summary>閉じた直後はファイルのロックが残ることがあるので、少し待ってやり直す。</summary>
    private static void RetryOnLock(Action write)
    {
        for (var i = 0; ; i++)
        {
            try
            {
                write();
                return;
            }
            catch (IOException) when (i < 10)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                Thread.Sleep(300);
            }
        }
    }

    // ---- VBA（仕様書 §8） ----

    private const int VbextStdModule = 1;

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
        foreach (var c in Enumerate(project.VBComponents))
        {
            dynamic comp = c;
            dynamic cm = comp.CodeModule;
            int count = cm.CountOfLines;
            string code = count > 0 ? cm.Lines(1, count) : string.Empty;
            modules.Add(new VbaModule((string)comp.Name, (int)comp.Type, code));
        }

        return new VbaReadResult(VbaReadStatus.Ok, modules);
    });

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
        catch (COMException)
        {
            status = VbaReadStatus.TrustDenied;
            return null;
        }
    }

    private static dynamic RequireProject(string fullPath)
    {
        var found = FindWorkbook(fullPath) ?? throw new InvalidOperationException(L("ブックがExcelで開かれていません。", "The workbook is not open in Excel."));
        dynamic? project = TryGetProject(found.Workbook, out VbaReadStatus status);
        return project ?? throw new InvalidOperationException(status == VbaReadStatus.Locked
            ? L("VBAプロジェクトがパスワードで保護されています。", "The VBA project is password protected.")
            : L("VBAプロジェクトにアクセスできません。Excelの［トラスト センター］→［マクロの設定］で「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」をオンにしてください。", "Cannot access the VBA project. In Excel, turn on \"Trust access to the VBA project object model\" under Trust Center > Macro Settings."));
    }

    /// <summary>
    /// モジュールの末尾にコードを追加する。モジュールがなければ標準モジュールとして作る。
    /// 既存のコードは書き換えない（仕様書 §8.2）。documentModule が true なら ThisWorkbook に追加する。
    /// </summary>
    public Task<bool> InsertVbaAsync(string fullPath, string moduleName, string code, bool documentModule) => _com.InvokeAsync(() =>
    {
        dynamic project = RequireProject(fullPath);
        dynamic? target = null;
        if (documentModule)
        {
            var found = FindWorkbook(fullPath)!.Value;
            string codeName = found.Workbook.CodeName;
            target = project.VBComponents.Item(codeName);
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
                target.Name = moduleName;
            }
        }

        dynamic cm = target.CodeModule;
        int count = cm.CountOfLines;
        cm.InsertLines(count + 1, (count > 0 ? "\r\n" : string.Empty) + code.TrimEnd());
        return true;
    });

    /// <summary>1 行だけを書き換える。読み込んだ後にコードが変わっていたら書き換えない。</summary>
    public Task<bool> ReplaceVbaLineAsync(string fullPath, string moduleName, int line, string expected, string replacement) => _com.InvokeAsync(() =>
    {
        dynamic project = RequireProject(fullPath);
        dynamic cm = project.VBComponents.Item(moduleName).CodeModule;
        string current = cm.Lines(line, 1);
        if (!string.Equals(current, expected, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(L("VBAのコードが読み込んだ後に変更されています。コールバック一覧を再読み込みしてください。", "The VBA code changed after it was read. Please reload the callback list."));
        }

        cm.ReplaceLine(line, replacement);
        return true;
    });

    // ---- imageMso / 表示名（仕様書 §9.1） ----

    /// <summary>アイコンや表示名の取得に使う Excel。起動中のものがあればそれを、なければ見えない Excel を起動する。</summary>
    private dynamic HelperApp()
    {
        var running = RunningExcel.Applications().FirstOrDefault();
        if (running is not null)
        {
            return running;
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

    /// <summary>imageMso を PNG で返す。存在しない名前は null。取得結果はディスクにもキャッシュする。</summary>
    public Task<Dictionary<string, byte[]?>> GetImageMsoAsync(IReadOnlyList<string> names, int size) => _com.InvokeAsync(() =>
    {
        var result = new Dictionary<string, byte[]?>();
        var dir = Path.Combine(_iconCacheDir, size.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(dir);
        dynamic? app = null;
        foreach (var name in names.Distinct())
        {
            if (string.IsNullOrWhiteSpace(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            {
                result[name] = null;
                continue;
            }

            var cache = Path.Combine(dir, name + ".png");
            if (File.Exists(cache))
            {
                result[name] = File.ReadAllBytes(cache);
                continue;
            }

            app ??= HelperApp();
            byte[]? png = null;
            try
            {
                object pic = app.CommandBars.GetImageMso(name, size, size);
                png = PictureToPng(pic);
                Release(pic);
            }
            catch (COMException)
            {
                // 存在しない imageMso
            }
            catch (ArgumentException)
            {
            }

            if (png is not null)
            {
                File.WriteAllBytes(cache, png);
            }

            result[name] = png;
        }

        return result;
    });

    /// <summary>idMso の表示名（日本語版の Excel なら日本語）を返す。</summary>
    public Task<Dictionary<string, string>> GetLabelsAsync(IReadOnlyList<string> ids) => _com.InvokeAsync(() =>
    {
        var result = new Dictionary<string, string>();
        dynamic app = HelperApp();
        dynamic bars = app.CommandBars;
        foreach (var id in ids)
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
            catch (COMException)
            {
            }
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

    private static T? Safe<T>(Func<T> f)
    {
        try
        {
            return f();
        }
        catch (Exception ex) when (ex is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException or InvalidCastException)
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
        catch (Exception ex) when (ex is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException or InvalidCastException)
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
            var app = _helperApp;
            _helperApp = null;
            try
            {
                _com.InvokeAsync(() =>
                {
                    app.Quit();
                    Release(app);
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
