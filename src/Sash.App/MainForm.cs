using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Sash.App;

/// <summary>
/// メインウィンドウ。WinForms は外枠だけを持ち、画面はすべて WebView2 で描く（仕様書 §3）。
/// 環境変数 SASH_UI_DEV_URL を設定すると、埋め込み UI の代わりに Vite の開発サーバーを表示する。
/// </summary>
internal sealed class MainForm : Form
{
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly MessageRouter _router;
    private readonly string? _initialFile;

    public MainForm(string? initialFile)
    {
        _initialFile = initialFile;
        _router = new MessageRouter(this);

        Text = "Sash";
        ClientSize = new Size(1440, 900);
        MinimumSize = new Size(960, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_webView);

        Load += async (_, _) => await InitializeWebViewAsync();
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
            MessageBox.Show(this, "WebView2 ランタイムが見つかりません。Microsoft Edge WebView2 ランタイムをインストールしてください。",
                "Sash", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var core = _webView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = IsDevelopment;
        core.Settings.AreDefaultContextMenusEnabled = IsDevelopment;
        core.Settings.IsStatusBarEnabled = false;
        core.WebMessageReceived += OnWebMessageReceived;

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

        // 起動時に引数で渡されたファイルがあれば、最初の file.open で使う
        if (request.Type == "app.ready")
        {
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(
                new HostResponse(request.Id, true, new { initialFile = _initialFile }, null), HostJson.Options));
            return;
        }

        var response = await _router.HandleAsync(request);
        _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(response, HostJson.Options));
    }
}
