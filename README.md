# Sash

A modern visual ribbon editor for Excel macro workbooks and add-ins (.xlsm / .xlam).

Excelのxlsm／xlamのリボンを、見たまま作って直せるモダンなリボンエディタです。

## 概要

Sashは、Excelのマクロブックとアドイン（.xlsm / .xlam）のカスタムリボン（customUI）を、ドラッグ操作で組み立てられるデスクトップツールです。XMLを手書きする必要はありません。編集した内容はワンクリックでExcelに反映でき、VBAのコールバックとの整合性も自動でチェックします。画像やicoファイルからリボン用のアイコンを作って、そのまま設定することもできます。

## 主な機能

- **キャンバス編集**：本物のExcelに近いリボンのプレビュー上に、パレットからドラッグして部品を配置
- **三面同期**：キャンバス、ツリー、XMLエディタ（Monaco）が常に同期
- **インスペクタとLint**：コントロールごとに使える属性だけを表示し、入力中に検証
- **Excelへのワンクリック反映（F5）**：保存・クローズ・書き込み・再オープンを自動化。xlamのアドインにも対応
- **アイコン作成**：PNG / JPG / BMP / GIF / WebP / SVG / ICO / EXE / DLL / クリップボードから、リボン用PNGを作成して設定
- **コールバック管理**：正しいシグネチャでVBAスタブを生成し、未実装や不一致を検出
- **カタログ**：idMso / imageMso をあいまい検索
- **レシピ**：よく使う構成をXMLとVBAのセットで挿入

## 動作環境

- Windows 10 / 11（64bit）
- Excel 2016以降、またはMicrosoft 365（連携機能を使う場合）
- self-containedの単一exeで配布（インストール不要）

## ステータス

第1弾（編集の強化）を実装しました。Windows 実機での動作確認はこれからです。仕様は [docs/SPEC.md](docs/SPEC.md)、実装状況は同じく §12 を参照してください。

## 開発

### 構成

| パス | 内容 |
| --- | --- |
| `src/Sash.Core` | OPC（zip）の読み書き、customUIモデル、バックアップ。OSに依存しない（net10.0） |
| `src/Sash.Excel` | Excel連携。COMは遅延バインドで呼ぶ（net10.0-windows） |
| `src/Sash.App` | ホスト。WinFormsの外枠とWebView2。UIは埋め込みリソースとして配信する（net10.0-windows） |
| `ui` | UI本体。TypeScript、Vite、Monaco Editor。ビルド結果は `src/Sash.App/wwwroot` に出力される |
| `tests/Sash.Core.Tests` | Coreの単体テスト（xUnit） |
| `ui/test` | UIのモデル・Lint・アイコン加工の単体テスト（Vitest） |

### 必要なもの

- .NET SDK 10.0
- Node.js 22以降
- 実行にはWindowsとWebView2ランタイムが必要（Core のビルドとテストはLinux / macOSでも動く）

### ビルドと実行

UIを先にビルドしてから、.NETをビルドします。UIを埋め込みリソースとしてexeに取り込むためです。

```bash
cd ui && npm ci && npm run build
```

```bash
dotnet build Sash.slnx
```

```bash
dotnet test Sash.slnx
```

```bash
cd ui && npm test
```

```bash
dotnet run --project src/Sash.App
```

UIを編集しながら確認するときは、`ui` で `npm run dev` を起動し、環境変数 `SASH_UI_DEV_URL=http://localhost:5173` を設定してアプリを起動します。ホットリロードが効きます。ブラウザで `http://localhost:5173/?sample` を開くと、サンプルのリボンでUIだけを確認できます（保存とExcel連携は動きません）。

### 配布用の単一exe

```bash
dotnet publish src/Sash.App -p:PublishProfile=win-x64
```

`artifacts/publish/win-x64/Sash.exe` に、self-containedの単一exeが出力されます。

## ライセンス

未定

idMso の一覧（`ui/src/catalog/excelControls.json`）は、Microsoft の [office-fluent-ui-command-identifiers](https://github.com/OfficeDev/office-fluent-ui-command-identifiers)（MIT License）の Excel 分から作成しています。ライセンス文は `ui/src/catalog/` に同梱しています。
