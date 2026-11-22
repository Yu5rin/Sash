using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;

namespace Sash.Excel;

/// <summary>
/// 実行中の Excel インスタンスを探す。
/// Excel は開いているブックをフルパスで ROT（実行中オブジェクト テーブル）に登録するので、
/// そこからブックを取り出し、Application をたどって全インスタンスを集める（仕様書 §7.1 の 1）。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class RunningExcel
{
    private static readonly string[] WorkbookExtensions = [".xls", ".xlsx", ".xlsm", ".xlsb", ".xlam", ".xla", ".xltm", ".xltx"];

    /// <summary>実行中の Excel.Application を重複なく返す。</summary>
    public static List<dynamic> Applications()
    {
        var apps = new List<dynamic>();
        var hwnds = new HashSet<long>();

        void Add(dynamic? app)
        {
            if (app is null)
            {
                return;
            }

            try
            {
                long hwnd = app.Hwnd;
                if (hwnds.Add(hwnd))
                {
                    apps.Add(app);
                }
            }
            catch (COMException)
            {
                // 終了処理中などで応答しないインスタンスは無視する
            }
        }

        foreach (var obj in RotObjects())
        {
            try
            {
                Add(((dynamic)obj).Application);
            }
            catch (Exception ex) when (ex is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
            {
            }
        }

        if (NativeMethods.CLSIDFromProgID("Excel.Application", out var clsid) == 0 &&
            NativeMethods.GetActiveObject(ref clsid, IntPtr.Zero, out var active) == 0)
        {
            Add(active);
        }

        return apps;
    }

    private static IEnumerable<object> RotObjects()
    {
        if (NativeMethods.GetRunningObjectTable(0, out var rot) != 0 || NativeMethods.CreateBindCtx(0, out var ctx) != 0)
        {
            yield break;
        }

        rot.EnumRunning(out var monikers);
        var buffer = new IMoniker[1];
        while (monikers.Next(1, buffer, IntPtr.Zero) == 0)
        {
            string name;
            try
            {
                buffer[0].GetDisplayName(ctx, null, out name);
            }
            catch (COMException)
            {
                continue;
            }

            if (!WorkbookExtensions.Contains(Path.GetExtension(name), StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            object? obj = null;
            try
            {
                rot.GetObject(buffer[0], out obj);
            }
            catch (COMException)
            {
            }

            if (obj is not null)
            {
                yield return obj;
            }
        }
    }
}
