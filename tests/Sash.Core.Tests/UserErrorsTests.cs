using System.Text.Json.Nodes;
using Sash.Core;
using Sash.Core.Library;
using Sash.Core.Settings;
using Sash.Core.Update;

namespace Sash.Core.Tests;

/// <summary>利用者向けの文言を持つ ArgumentException・FormatException が、ホストで「予期しないエラー」に変わらないための印（見直し 高3）。</summary>
public class UserErrorsTests
{
    [Fact]
    public void 更新の確認先の不正はTypeを変えずに利用者向けの印が付く()
    {
        var ex = Assert.Throws<ArgumentException>(() => UpdateSource.Parse("http://intra.example.com/latest.json"));
        Assert.True(UserErrors.IsUserFacing(ex));
        Assert.Contains("https", ex.Message);
    }

    [Fact]
    public void レシピの_id_無しとアイコンの不正な_id_にも印が付く()
    {
        var dir = Path.Combine(Path.GetTempPath(), "sash-ue-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new RecipeStore(dir);
            Assert.True(UserErrors.IsUserFacing(Assert.Throws<ArgumentException>(() => store.Save(new JsonObject { ["title"] = "x" }))));
            var lib = new IconLibrary(dir);
            Assert.True(UserErrors.IsUserFacing(Assert.Throws<ArgumentException>(() => lib.Delete("../x"))));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void 更新フィードの内容の不正にも印が付く()
    {
        var ex = Assert.Throws<FormatException>(() => UpdateFeedLogic.LatestFromAtom("<html>sign in</html>"));
        Assert.True(UserErrors.IsUserFacing(ex));
    }

    [Fact]
    public void ふつうの例外と_NET_の例外には印が付かない()
    {
        Assert.False(UserErrors.IsUserFacing(new ArgumentException("Value cannot be null.")));
        Assert.False(UserErrors.IsUserFacing(new FormatException("Input string was not in a correct format.")));
        Assert.True(UserErrors.IsUserFacing(new UserFacingException("x")));
    }
}
