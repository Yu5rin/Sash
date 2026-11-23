using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Sash.Core.Excel;
using Sash.Core.Settings;
using Sash.Excel;
using static Sash.Core.Localization.Text;

namespace Sash.App;

/// <summary>
/// メインウィンドウ。WinForms は外枠だけを持ち、画面はすべて WebView2 で描く（仕様書 §3）。
/// 環境変数 SASH_UI_DEV_URL を設定すると、埋め込み UI の代わりに Vite の開発サーバーを表示する。
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class MainForm : Form
{
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly MessageRouter _router;
    private readonly ImageMsoCache _iconCache = new(AppPaths.ImageMsoCache);
    private readonly Lazy<ExcelService> _excel;
    private readonly string? _initialFile;
    private readonly string? _updatedFrom;
    private bool _closeConfirmed;
    private bool _uiReady;
    private bool _closePending;

    /// <summary>閉じる確認を頼んだ回数。古い確認の見張り（WatchCloseAnswerAsync）が、新しい確認の待ちを解かないようにする。</summary>
    private int _closeRequestId;
    private bool _recovering;

    /// <summary>表示を許すオリジン（埋め込み UI の仮想オリジン、または開発サーバー）。</summary>
    private Uri _allowedOrigin = new(UiAssets.Origin);

    /// <summary>最初に表示した URL。表示の処理が落ちたときに開き直すのに使う。</summary>
    private string _startUrl = $"{UiAssets.Origin}/index.html";

    /// <summary>閉じる確認を UI に頼んでから、UI が動いているかを確かめるまでの待ち時間。</summary>
    private static readonly TimeSpan CloseAnswerTimeout = TimeSpan.FromSeconds(5);

    public MainForm(string? initialFile, string? updatedFrom = null)
    {
        _initialFile = initialFile;
        _updatedFrom = updatedFrom;
        var settings = new SettingsStore(AppPaths.Settings);
        SettingsLanguage.Apply(settings.Load());

        // imageMso を取れない理由（別のプロセスの Excel の HBITMAP が読めないなど）を、利用者から app.log で受け取れるようにする
        _excel = new(() => new ExcelService(_iconCache) { Log = AppLog.Write });
        _router = new MessageRouter(this, settings, new RecipeStore(AppPaths.Recipes), _excel, _iconCache, () => BeginInvoke(() =>
        {
            _closeConfirmed = true;
            Close();
        }), PostEventFromAnyThread);

        Text = "Sash";
        Icon = LoadAppIcon();
        ClientSize = new Size(1440, 900);
        MinimumSize = new Size(960, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_webView);

        Load += async (_, _) => await InitializeWebViewAsync();
        FormClosing += OnFormClosing;
        FormClosed += (_, _) =>
        {
            // 取り込みの途中なら止める（取り込み用の Excel は ExcelService の Dispose で閉じる）
            _router.Shutdown();
            if (_excel.IsValueCreated)
            {
                _excel.Value.Dispose();
            }
        };
    }

    /// <summary>未保存の変更があるかは UI が知っているので、閉じる前に UI に確認させる。</summary>
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // Windows の終了やタスク マネージャーからの終了は止めない（止めると Windows の終了を妨げてしまう）
        if (e.CloseReason is CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing)
        {
            return;
        }

        if (_closeConfirmed || !_uiReady || _webView.CoreWebView2 is null)
        {
            return;
        }

        e.Cancel = true;
        if (_closePending)
        {
            return;
        }

        _closePending = true;
        var requestId = ++_closeRequestId;
        PostEvent(new { @event = "closeRequested" });
        _ = WatchCloseAnswerAsync(requestId);
    }

    /// <summary>
    /// UI が固まっていると、閉じる確認に答えが返らず、いつまでもウィンドウを閉じられない。
    /// 少し待っても閉じられていなければ、UI の処理（JavaScript）が動いているかを確かめ、動いていなければホスト側で尋ねる。
    /// UI が自分の確認画面を出して利用者の答えを待っているだけなら、JavaScript は動いているので何もしない。
    /// 利用者が UI の確認でキャンセルしたときは、UI が app.closeCancelled を送ってくるので、その時点で次の × を受け付ける。
    /// ここで解くのは、その知らせが来なかったとき（UI が固まっていたなど）の代わり。
    /// </summary>
    private async Task WatchCloseAnswerAsync(int requestId)
    {
        try
        {
            await Task.Delay(CloseAnswerTimeout);
            if (_closeConfirmed || IsDisposed || _webView.CoreWebView2 is null)
            {
                return;
            }

            var alive = await IsUiAliveAsync();
            if (_closeConfirmed || IsDisposed || alive)
            {
                return;
            }

            var answer = MessageBox.Show(this,
                L("画面が応答していません。保存していない変更を破棄して閉じますか？", "The window is not responding. Close without saving your changes?"),
                "Sash", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (answer == DialogResult.Yes)
            {
                _closeConfirmed = true;
                Close();
            }
        }
        finally
        {
            // その後に新しい確認を頼んでいたら、そちらの待ちはそちらの見張りに任せる
            if (requestId == _closeRequestId)
            {
                _closePending = false;
            }
        }
    }

    private async Task<bool> IsUiAliveAsync()
    {
        try
        {
            var script = _webView.CoreWebView2.ExecuteScriptAsync("1");
            return await Task.WhenAny(script, Task.Delay(CloseAnswerTimeout)) == script && script.IsCompletedSuccessfully;
        }
        catch (Exception ex) when (ex is InvalidOperationException or COMException)
        {
            return false;
        }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: AppPaths.WebView2Data);
            await _webView.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            FailToStart(L("WebView2 ランタイムが見つかりません。Microsoft Edge WebView2 ランタイムをインストールしてください。", "WebView2 Runtime was not found. Please install the Microsoft Edge WebView2 Runtime."));
            return;
        }
        catch (Exception ex)
        {
            // データフォルダに書けない、ランタイムが壊れているなど。何も表示されない空のウィンドウを残さない
            AppLog.Write("WebView2 の初期化に失敗", ex);
            FailToStart(L($"画面を表示する部品（WebView2）を起動できませんでした：{ex.Message}", $"The display component (WebView2) could not be started: {ex.Message}"));
            return;
        }

        var core = _webView.CoreWebView2;
        var devUrl = AcceptedDevUrl();
        core.Settings.AreDevToolsEnabled = IsDevelopment(devUrl);
        core.Settings.AreDefaultContextMenusEnabled = IsDevelopment(devUrl);
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // F5 の再読み込みなどを無効にし、アプリのショートカットに使う
        core.WebMessageReceived += OnWebMessageReceived;
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.NavigationStarting += OnNavigationStarting;
        core.ProcessFailed += OnProcessFailed;

        if (devUrl is not null)
        {
            _allowedOrigin = devUrl;
            _startUrl = devUrl.ToString();
            core.Navigate(_startUrl);
            return;
        }

        core.AddWebResourceRequestedFilter($"{UiAssets.Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.Navigate(_startUrl);
    }

    private void FailToStart(string message)
    {
        MessageBox.Show(this, message, "Sash", MessageBoxButtons.OK, MessageBoxIcon.Error);
        _closeConfirmed = true;
        Close();
    }

    /// <summary>
    /// SASH_UI_DEV_URL（Vite の開発サーバー）を使ってよいか。UI はホストの機能（ファイルの読み書きや Excel の操作）を呼べるので、
    /// 配布した版で環境変数を書き換えられて外部のページを読み込まないよう、Release では自分の PC（localhost）だけを許す。
    /// </summary>
    private static Uri? AcceptedDevUrl()
    {
        var text = Environment.GetEnvironmentVariable("SASH_UI_DEV_URL");
        if (string.IsNullOrWhiteSpace(text) || !Uri.TryCreate(text, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return null;
        }

#if DEBUG
        return uri;
#else
        return uri.IsLoopback || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase) ? uri : null;
#endif
    }

    /// <summary>許したオリジン（スキーム・ホスト・ポート）の URL か。</summary>
    private bool IsAllowed(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && string.Equals(uri.Scheme, _allowedOrigin.Scheme, StringComparison.OrdinalIgnoreCase)
        && string.Equals(uri.Host, _allowedOrigin.Host, StringComparison.OrdinalIgnoreCase)
        && uri.Port == _allowedOrigin.Port;

    /// <summary>UI のリンクやスクリプトから、別のページへ移動させない（移動先のページにもホストの機能を呼ばれてしまうため）。</summary>
    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!IsAllowed(e.Uri))
        {
            e.Cancel = true;
        }
    }

    /// <summary>表示の処理（WebView2 のプロセス）が落ちたときに、開き直すか閉じるかを尋ねる。</summary>
    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        var kind = e.ProcessFailedKind;
        if (kind is not (CoreWebView2ProcessFailedKind.BrowserProcessExited or CoreWebView2ProcessFailedKind.RenderProcessExited
            or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive or CoreWebView2ProcessFailedKind.FrameRenderProcessExited))
        {
            // GPU などの補助のプロセスは WebView2 が自分で立ち直る
            return;
        }

        AppLog.Write($"WebView2 のプロセスが停止: {kind}");
        if (_recovering)
        {
            return;
        }

        _recovering = true;
        BeginInvoke(() =>
        {
            try
            {
                // ブラウザーのプロセスごと落ちたときは、同じ WebView2 では開き直せない
                if (kind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                {
                    MessageBox.Show(this, L("画面を表示する部品（WebView2）が停止しました。Sashを終了します。保存していない変更は失われました。", "The display component (WebView2) stopped. Sash will close. Unsaved changes were lost."),
                        "Sash", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    _closeConfirmed = true;
                    Close();
                    return;
                }

                var answer = MessageBox.Show(this,
                    L("画面の表示が停止しました。画面を開き直しますか？（保存していない変更は失われている可能性があります）\n［いいえ］を選ぶとSashを終了します。", "The window stopped responding. Reload it? (Unsaved changes may have been lost.)\nChoose No to close Sash."),
                    "Sash", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (answer == DialogResult.Yes)
                {
                    _uiReady = false;
                    _webView.CoreWebView2?.Navigate(_startUrl);
                }
                else
                {
                    _closeConfirmed = true;
                    Close();
                }
            }
            finally
            {
                _recovering = false;
            }
        });
    }

    private static bool IsDevelopment(Uri? devUrl) =>
#if DEBUG
        true;
#else
        devUrl is not null;
#endif

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var path = new Uri(e.Request.Uri).AbsolutePath;
        var stream = UiAssets.Open(path);
        var env = _webView.CoreWebView2.Environment;
        e.Response = stream is null
            ? env.CreateWebResourceResponse(null, 404, "Not Found", "")
            : env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {UiAssets.ContentTypeOf(path)}");
    }

    private void PostEvent(object message) =>
        _webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message, HostJson.Options));

    /// <summary>
    /// ほかのスレッド（imageMso の取り込みの進み具合など）から UI へ知らせる。WebView2 は UI スレッドからしか触れないので、
    /// UI スレッドに回してから送る。ウィンドウを閉じた後に届いた知らせは捨てる。
    /// </summary>
    private void PostEventFromAnyThread(object message)
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }

        try
        {
            BeginInvoke(() =>
            {
                if (!IsDisposed)
                {
                    PostEvent(message);
                }
            });
        }
        catch (InvalidOperationException)
        {
            // 確かめた直後にウィンドウが閉じられた
        }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // 許したオリジン以外（移動を止めきれなかったページや、埋め込まれた別のフレームなど）からの要求には答えない
        if (!IsAllowed(e.Source))
        {
            return;
        }

        HostRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<HostRequest>(e.WebMessageAsJson, HostJson.Options);
        }
        catch (JsonException)
        {
            return;
        }

        if (request is null)
        {
            return;
        }

        switch (request.Type)
        {
            case "app.ready":
                // 起動時に引数で渡されたファイルがあれば、UI に開かせる
                _uiReady = true;
                PostEvent(new HostResponse(request.Id, true, new { initialFile = _initialFile, updatedFrom = _updatedFrom, version = UpdateService.CurrentVersionText }, null));
                return;

            case "app.closeCancelled":
                // UI の「未保存の変更があります」でキャンセルされた。待っていた答えが返ったので、次の × をすぐ受け付ける
                // （見張りの待ち時間が過ぎるまで × が効かないように見えてしまうため）
                _closePending = false;
                PostEvent(new HostResponse(request.Id, true, null, null));
                return;

            case "file.drop":
                // ドロップされたファイルのフルパスは、WebView2 の追加オブジェクトからしか取れない
                if (e.AdditionalObjects?.FirstOrDefault() is CoreWebView2File file)
                {
                    PostEvent(new { @event = "fileDropped", path = file.Path });
                }

                return;
        }

        // WebView2 のイベントの中でファイルダイアログ（ShowDialog）を出すと、イベントの中で入れ子のメッセージ ループが回り
        // WebView2 が不安定になることがある。いったんイベントから抜け、メッセージ ループに戻ってから処理する
        await Task.Yield();
        var response = await _router.HandleAsync(request);
        PostEvent(response);
    }

    /// <summary>ウィンドウとタスクバーに出すアイコンを、埋め込みリソースから読む。読めなければ Windows の既定のまま。</summary>
    private static Icon? LoadAppIcon()
    {
        using var stream = typeof(MainForm).Assembly.GetManifestResourceStream("sash.ico");
        return stream is null ? null : new Icon(stream);
    }
}
