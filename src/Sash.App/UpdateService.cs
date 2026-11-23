using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using Sash.Core.Settings;
using Sash.Core.Update;
using static Sash.Core.Localization.Text;

namespace Sash.App;

/// <summary>更新の確認の結果。UI へそのまま返す。</summary>
internal sealed record UpdateCheckResult(
    string Status,
    string Current,
    string? Latest,
    string? Notes,
    bool CanInstall,
    string? Reason,
    string? PageUrl,
    string Source,
    bool ManagedByAdmin);

/// <summary>
/// 更新の確認・ダウンロード・入れ替え。
/// 会社のネットワークで通ることを重視している（同じ作者の Graft・Pane が社内の共有回線で踏んだ不具合への対策に倣う）。
/// ・Windows のプロキシ設定（PAC を含む）に従い、認証つきのプロキシにはサインイン中の資格情報で応答する。
/// ・GitHub API ではなく Atom フィードと規則で組み立てた URL を使い、API の回数上限に当たらないようにする。
/// ・インターネットに出られない PC のために、社内の共有フォルダや社内の Web サーバーからも更新できる。
/// ・配布物は必ず SHA256 で照合してから入れ替え、照合できないときは入れ替えない。
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class UpdateService(SettingsStore settings)
{
    private static readonly HttpClient Http = CreateClient();

    /// <summary>確認全体の上限。社内のプロキシが応答を返さないまま止まると、確認中の表示が終わらなくなるため。</summary>
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(30);

    /// <summary>ダウンロードで、1 バイトも届かないまま待つ上限。遅くても進んでいれば止めない。</summary>
    private static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(60);
    private static bool _networkLogged;

    public static string CurrentVersionText =>
        (typeof(UpdateService).Assembly.GetName().Version is { } v ? new UpdateVersion(v.Major, v.Minor, v.Build < 0 ? 0 : v.Build) : new UpdateVersion(0, 0, 0)).ToString();

    private static string ExePath => Environment.ProcessPath ?? Application.ExecutablePath;

    private static HttpClient CreateClient()
    {
        var handler = new SocketsHttpHandler
        {
            // 社内の認証つきプロキシ（NTLM / Kerberos）に、サインイン中の Windows の資格情報で応答する
            DefaultProxyCredentials = CredentialCache.DefaultCredentials,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(15),
        };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"Sash/{CurrentVersionText}");
        return client;
    }

    /// <summary>実際に使う確認先と、管理者の設定ファイルで決まっているか。</summary>
    public (UpdateSource Source, UpdatePolicy? Policy) ResolveSource()
    {
        var policy = UpdatePolicy.Load(Path.GetDirectoryName(ExePath)!);
        var text = policy?.Source ?? settings.Load().UpdateSource;
        return (UpdateSource.Parse(text), policy);
    }

    public bool ShouldCheckOnStartup()
    {
        var policy = UpdatePolicy.Load(Path.GetDirectoryName(ExePath)!);
        if (policy?.Disabled == true)
        {
            return false;
        }

        return policy?.CheckOnStartup ?? settings.Load().UpdateCheckOnStartup;
    }

    public async Task<(UpdateCheckResult Result, UpdateRelease? Release)> CheckAsync(CancellationToken ct = default)
    {
        var current = CurrentVersionText;
        UpdateSource source;
        UpdatePolicy? policy;
        try
        {
            (source, policy) = ResolveSource();
        }
        catch (ArgumentException ex)
        {
            return (new UpdateCheckResult("error", current, null, null, false, ex.Message, null, "", false), null);
        }

        var managed = policy?.Source is not null;
        if (policy?.Disabled == true)
        {
            return (new UpdateCheckResult("disabled", current, null, null, false,
                L("管理者の設定（Sash.update.json）で更新が止められているか、設定ファイルを読めません。", "Updates are disabled by the administrator settings (Sash.update.json), or the file cannot be read."),
                null, source.Location, true), null);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(CheckTimeout);
        try
        {
            var release = await FetchLatestAsync(source, timeout.Token);
            UpdateVersion.TryParse(current, out var cur);
            if (release is null || release.Version <= cur)
            {
                Log($"確認: 最新（現在 {current}、確認先 {source.Location}）");
                return (new UpdateCheckResult("upToDate", current, release?.Version.ToString(), null, false, null, release?.PageUrl ?? source.LatestPageUrl, source.Location, managed), release);
            }

            // GitHub では、リリースを作ってから配布物を添付し終えるまでの間もフィードに載る。照合値ファイルがまだなければ
            // 「新しい版があります」と出しても入れ替えられないので、そろうまでは最新として扱う。取れた照合値は覚えておき、入れ替えのときに取り直さない
            if (release.Sha256 is null && release.ChecksumUrl is not null && source.Kind == UpdateSourceKind.GitHub)
            {
                var sha = await FetchChecksumAsync(release, timeout.Token);
                if (sha is null)
                {
                    return (new UpdateCheckResult("upToDate", current, null, null, false, null, source.LatestPageUrl, source.Location, managed), null);
                }

                release = release with { Sha256 = sha };
            }

            var (canInstall, reason) = CanInstallHere();
            Log($"確認: 新しい版 {release.Version} があります（確認先 {source.Location}、入れ替え {(canInstall ? "可" : "不可")}）");
            return (new UpdateCheckResult("available", current, release.Version.ToString(), release.Notes, canInstall, reason, release.PageUrl, source.Location, managed), release);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or UnauthorizedAccessException or FormatException or System.Text.Json.JsonException)
        {
            var message = Describe(ex);
            Log($"確認に失敗: {ex.GetType().Name}: {ex.Message}");
            return (new UpdateCheckResult("error", current, null, null, false, message, source.LatestPageUrl, source.Location, managed), null);
        }
    }

    private async Task<UpdateRelease?> FetchLatestAsync(UpdateSource source, CancellationToken ct)
    {
        switch (source.Kind)
        {
            case UpdateSourceKind.GitHub:
            {
                LogNetworkOnce(source.AtomUrl);
                var xml = await GetStringAsync(source.AtomUrl, ct);
                var latest = UpdateFeedLogic.LatestFromAtom(xml);
                return latest is null ? null : UpdateFeedLogic.ForGitHub(source, latest.Value.Tag, latest.Value.Version);
            }

            case UpdateSourceKind.Manifest:
                LogNetworkOnce(source.Location);
                return UpdateFeedLogic.ForManifest(source, await GetStringAsync(source.Location, ct));

            default:
            {
                var path = Path.Combine(source.Location, UpdateSource.ManifestFileName);
                Log($"確認: 共有フォルダ {path} を読みます");
                // つながらない共有フォルダはファイルを開くところで長く止まる（そこは非同期にならない）ので、
                // 別のスレッドで読み、上限の時間を過ぎたら待つのをやめる
                var text = await Task.Run(() => File.ReadAllTextAsync(path, ct), ct).WaitAsync(ct);
                return UpdateFeedLogic.ForManifest(source, text);
            }
        }
    }

    /// <summary>照合値ファイルを取って照合値を返す。まだ置かれていなければ（404）null。</summary>
    private static async Task<string?> FetchChecksumAsync(UpdateRelease release, CancellationToken ct)
    {
        string text;
        try
        {
            text = await GetStringAsync(release.ChecksumUrl!, ct);
        }
        catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            Log($"確認: {release.Version} の照合値ファイルがまだありません（配布物の準備中）。最新として扱います：{release.ChecksumUrl}");
            return null;
        }

        var sha = UpdateFeedLogic.ParseChecksum(text, UpdateSource.AssetFileName(release.Version));
        if (sha is null)
        {
            Log($"確認: {release.Version} の照合値ファイルを読めません。最新として扱います：{release.ChecksumUrl}");
        }

        return sha;
    }

    /// <summary>exe のフォルダに書き込めるか。Program Files などでは自分では入れ替えられない。</summary>
    private static (bool, string?) CanInstallHere()
    {
#if DEBUG
        // Debug ビルドは bin\Debug から dotnet run やデバッガーで動かしている。入れ替えるとビルドの出力（apphost）を
        // 配布物で上書きしてしまい、次のビルドやデバッグが壊れるので、デバッガーの有無にかかわらず入れ替えない
        return (false, L("開発中の実行では入れ替えません。", "Not replaced while running from a development build."));
#else
        var dir = Path.GetDirectoryName(ExePath)!;
        if (!string.Equals(Path.GetFileName(ExePath), "Sash.exe", StringComparison.OrdinalIgnoreCase) && Debugger.IsAttached)
        {
            return (false, L("開発中の実行では入れ替えません。", "Not replaced while running from a development build."));
        }

        return ExecutableReplacer.CanWriteTo(dir)
            ? (true, null)
            : (false, L($"{dir} に書き込めないため、自動では入れ替えられません。新しい版をダウンロードして、管理者の権限で置き換えてください。", $"Cannot write to {dir}, so the update cannot be installed automatically. Download the new version and replace the file with administrator rights."));
#endif
    }

    /// <summary>ダウンロードして照合し、exe を入れ替える。成功したら新しい版を起動して、この版は終わる。</summary>
    public async Task InstallAsync(UpdateRelease release, Action exitApp, CancellationToken ct = default)
    {
        try
        {
            await InstallCoreAsync(release, exitApp, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or UnauthorizedAccessException or FormatException)
        {
            // 通信や共有フォルダの失敗は、確認のときと同じく何をすればよいかがわかる文言にし、ログにも残す
            Log($"入れ替えに失敗: {ex.GetType().Name}: {ex.Message}");
            throw new Sash.Core.UserFacingException(L($"更新できませんでした。{Describe(ex)}", $"The update failed. {Describe(ex)}"), ex);
        }
        catch (InvalidOperationException ex)
        {
            Log($"入れ替えを中止: {ex.Message}");
            throw;
        }
    }

    private static async Task InstallCoreAsync(UpdateRelease release, Action exitApp, CancellationToken ct)
    {
        var (ok, reason) = CanInstallHere();
        if (!ok)
        {
            throw new InvalidOperationException(reason);
        }

        var workDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Sash", "updates");
        Directory.CreateDirectory(workDir);
        var fileName = UpdateSource.AssetFileName(release.Version);
        var downloaded = Path.Combine(workDir, fileName);

        // 照合値を先に取る。取れなければ入れ替えない（中身を確かめられないものは入れない）。
        // GitHub のときは確認の時点で取ってあるので、ここでは取り直さない
        var expected = release.Sha256;
        if (expected is null && release.ChecksumUrl is not null)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(CheckTimeout);
            var text = release.ChecksumUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? await GetStringAsync(release.ChecksumUrl, timeout.Token)
                : await Task.Run(() => File.ReadAllTextAsync(release.ChecksumUrl, timeout.Token), timeout.Token).WaitAsync(timeout.Token);
            expected = UpdateFeedLogic.ParseChecksum(text, fileName);
        }

        if (expected is null)
        {
            throw new InvalidOperationException(L("照合値（SHA256）を取得できないため、更新を中止しました。リリースのページから手動で更新してください。", "The update was cancelled because the SHA256 checksum could not be obtained. Please update manually from the release page."));
        }

        Log($"ダウンロード: {release.DownloadUrl}");
        if (release.DownloadUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            await DownloadAsync(release.DownloadUrl, downloaded, ct);
        }
        else
        {
            // 共有フォルダからのコピーは同期の処理なので、UI のスレッドを止めないよう別のスレッドで行う
            await Task.Run(() => File.Copy(release.DownloadUrl, downloaded, overwrite: true), ct);
        }

        string actual;
        await using (var fs = File.OpenRead(downloaded))
        {
            actual = Convert.ToHexStringLower(await SHA256.HashDataAsync(fs, ct));
        }

        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(downloaded);
            Log($"照合に失敗: 期待 {expected}、実際 {actual}");
            throw new InvalidOperationException(L("ダウンロードしたファイルの照合値（SHA256）が一致しません。更新を中止しました。", "The SHA256 checksum of the downloaded file does not match. The update was cancelled."));
        }

        var previous = CurrentVersionText;
        await Task.Run(() => ExecutableReplacer.Replace(ExePath, downloaded), CancellationToken.None);
        Log($"入れ替え: {previous} → {release.Version}");
        TryDelete(downloaded);

        // 新しい版を起動してから、この版を終える。新しい版は起動時に .old を片付け、「更新しました」と知らせる
        Process.Start(new ProcessStartInfo(ExePath) { UseShellExecute = false, ArgumentList = { "--updated-from", previous } });
        exitApp();
    }

    /// <summary>
    /// ダウンロードする。全体の時間では区切らず、データが届かない状態が <see cref="StallTimeout"/> 続いたら止める
    /// （回線が遅い社内でも、進んでいる限りは最後まで待つため）。
    /// </summary>
    private static async Task DownloadAsync(string url, string dest, CancellationToken ct)
    {
        using var stall = CancellationTokenSource.CreateLinkedTokenSource(ct);
        stall.CancelAfter(StallTimeout);
        using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, stall.Token);
        if (!response.IsSuccessStatusCode)
        {
            throw HttpError(response.StatusCode);
        }

        await using var body = await response.Content.ReadAsStreamAsync(stall.Token);
        await using var fs = File.Create(dest);
        var buffer = new byte[81920];
        int read;
        while ((read = await body.ReadAsync(buffer, stall.Token)) > 0)
        {
            await fs.WriteAsync(buffer.AsMemory(0, read), stall.Token);
            // 届いたので、待つ時間を数え直す
            stall.CancelAfter(StallTimeout);
        }
    }

    private static async Task<string> GetStringAsync(string url, CancellationToken ct)
    {
        using var response = await Http.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw HttpError(response.StatusCode);
        }

        return await response.Content.ReadAsStringAsync(ct);
    }

    private static HttpRequestException HttpError(HttpStatusCode code) =>
        new(L($"サーバーが HTTP {(int)code} を返しました。", $"The server returned HTTP {(int)code}."), null, code);

    private static string Describe(Exception ex) => ex switch
    {
        HttpRequestException { StatusCode: HttpStatusCode.ProxyAuthenticationRequired } =>
            L("プロキシの認証に失敗しました。社内のプロキシの設定を確認するか、管理者に社内の共有フォルダからの更新を相談してください。", "Proxy authentication failed. Check the proxy settings, or ask your administrator about updating from a shared folder."),
        HttpRequestException { StatusCode: HttpStatusCode.NotFound } =>
            L("確認先が見つかりません（404）。設定の「更新の確認先」を確認してください。", "The update source was not found (404). Check the update source in Settings."),
        HttpRequestException { StatusCode: HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests } =>
            L("確認先へのアクセスが拒否されました。時間をおいて試すか、社内の共有フォルダからの更新を検討してください。", "Access to the update source was denied. Try again later, or consider updating from a shared folder."),
        OperationCanceledException => L("確認先から応答がありません（タイムアウト）。ネットワークやプロキシの設定を確認してください。", "The update source did not respond (timeout). Check your network or proxy settings."),
        HttpRequestException => L("確認先に接続できません。ネットワークやプロキシの設定を確認してください。", "Cannot connect to the update source. Check your network or proxy settings."),
        IOException or UnauthorizedAccessException => L($"共有フォルダを読めません：{ex.Message}", $"Cannot read the shared folder: {ex.Message}"),
        _ => L($"確認先の内容を読めません：{ex.Message}", $"Cannot read the update information: {ex.Message}"),
    };

    /// <summary>プロキシを経由しているかを一度だけログに残す（会社のネットワークでの切り分け用。資格情報の中身は出さない）。</summary>
    private static void LogNetworkOnce(string url)
    {
        if (_networkLogged)
        {
            return;
        }

        _networkLogged = true;
        try
        {
            var target = new Uri(url);
            var via = HttpClient.DefaultProxy.GetProxy(target);
            Log(via is null ? $"通信: プロキシを経由しない（宛先 {target.Host}）" : $"通信: プロキシを経由する（{via.Host}:{via.Port}、宛先 {target.Host}）");
        }
        catch (Exception ex) when (ex is UriFormatException or InvalidOperationException)
        {
        }
    }

    public static void Log(string message)
    {
        try
        {
            var dir = Path.Combine(AppPaths.Root, "logs");
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, "update.log");
            // 大きくなりすぎないよう、1MB を超えたら作り直す
            if (File.Exists(path) && new FileInfo(path).Length > 1_000_000)
            {
                File.Delete(path);
            }

            File.AppendAllText(path, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
