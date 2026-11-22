using Sash.Core.CustomUI;

namespace Sash.Core.Packaging;

/// <summary>新しく書き込む画像。</summary>
/// <param name="Id">リレーションの Id（image 属性に書く値）。</param>
/// <param name="Data">画像のバイト列。</param>
/// <param name="ContentType">コンテンツタイプ。既定は image/png。</param>
public sealed record NewImage(string Id, byte[] Data, string ContentType = "image/png");

/// <summary>1 つの customUI パーツへの変更。</summary>
/// <param name="Version">対象のパーツ。</param>
/// <param name="Xml">書き込む XML。</param>
/// <param name="AddImages">追加・差し替える画像。</param>
/// <param name="RemoveImages">削除する画像の Id。</param>
public sealed record CustomUIPartChange(
    CustomUIVersion Version,
    string Xml,
    IReadOnlyList<NewImage> AddImages,
    IReadOnlyList<string> RemoveImages);
