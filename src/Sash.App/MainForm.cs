using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
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
    private readonly Lazy<ExcelService> _excel = new(() => new ExcelService(AppPaths.ImageMsoCache));
    private readonly string? _initialFile;
    private bool _closeConfirmed;
    private bool _uiReady;

    public MainForm(string? initialFile)
    {
        _initialFile = initialFile;
        var settings = new SettingsStore(AppPaths.Settings);
        SettingsLanguage.Apply(settings.Load());
        _router = new MessageRouter(this, settings, new RecipeStore(AppPaths.Recipes), _excel, () => BeginInvoke(() =>
        {
            _closeConfirmed = true;
            Close();
        }));

        Text = "Sash";
        ClientSize = new Size(1440, 900);
        MinimumSize = new Size(960, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_webView);

        Load += async (_, _) => await InitializeWebViewAsync();
        FormClosing += OnFormClosing;
        FormClosed += (_, _) =>
        {
            if (_excel.IsValueCreated)
            {
                _excel.Value.Dispose();
            }
        };
    }

    /// <summary>未保存の変更があるかは UI が知っているので、閉じる前に UI に確認させる。</summary>
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_closeConfirmed || !_uiReady || _webView.CoreWebView2 is null)
        {
            return;
        }

        e.Cancel = true;
        PostEvent(new { @event = "closeRequested" });
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
            MessageBox.Show(this, L("WebView2 ランタイムが見つかりません。Microsoft Edge WebView2 ランタイムをインストールしてください。", "WebView2 Runtime was not found. Please install the Microsoft Edge WebView2 Runtime."),
                "Sash", MessageBoxButtons.OK, MessageBoxIcon.Error);
            _closeConfirmed = true;
            Close();
            return;
        }

        var core = _webView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = IsDevelopment;
        core.Settings.AreDefaultContextMenusEnabled = IsDevelopment;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // F5 の再読み込みなどを無効にし、アプリのショートカットに使う
        core.WebMessageReceived += OnWebMessageReceived;
        core.NewWindowRequested += (_, e) => e.Handled = true;

        var devUrl = Environment.GetEnvironmentVariable("SASH_UI_DEV_URL");
        if (!string.IsNullOrEmpty(devUrl))
        {
            core.Navigate(devUrl);
            return;
        }

        core.AddWebResourceRequestedFilter($"{UiAssets.Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.Navigate($"{UiAssets.Origin}/index.html");
    }

    private static bool IsDevelopment =>
#if DEBUG
        true;
#else
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SASH_UI_DEV_URL"));
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

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
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
                PostEvent(new HostResponse(request.Id, true, new { initialFile = _initialFile }, null));
                return;

            case "file.drop":
                // ドロップされたファイルのフルパスは、WebView2 の追加オブジェクトからしか取れない
                if (e.AdditionalObjects?.FirstOrDefault() is CoreWebView2File file)
                {
                    PostEvent(new { @event = "fileDropped", path = file.Path });
                }

                return;
        }

        var response = await _router.HandleAsync(request);
        PostEvent(response);
    }
}
