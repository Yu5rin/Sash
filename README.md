# Sash

A modern visual ribbon editor for Excel macro workbooks and add-ins (.xlsm / .xlam / .xltm / .xlsb).

Excelのxlsm／xlamのリボンを、見たまま作って直せるモダンなリボンエディタです。

## 概要

Sashは、Excelのマクロブックとアドイン（.xlsm / .xlam、ほかに .xltm / .xlsb）のカスタムリボン（customUI）を、ドラッグ操作で組み立てられるデスクトップツールです。XMLを手書きする必要はありません。編集した内容はワンクリックでExcelに反映でき、VBAのコールバックとの整合性も自動でチェックします。画像やicoファイルからリボン用のアイコンを作って、そのまま設定することもできます。

## 主な機能

- **キャンバス編集**：本物のExcelに近いリボンのプレビュー上に、パレットからドラッグして部品を配置
- **三面同期**：キャンバス、ツリー、XMLエディタ（Monaco）が常に同期
- **インスペクタとLint**：コントロールごとに使える属性だけを表示し、入力中に検証
- **Excelへのワンクリック反映（F5）**：保存・クローズ・書き込み・再オープンを自動化。xlamのアドインにも対応
- **アイコン作成**：PNG / JPG / BMP / GIF / WebP / SVG / ICO / EXE / DLL / クリップボードから、リボン用PNGを作成して設定
- **アイコン集**：同梱の Fluent UI System Icons・Tabler Icons・Lucide と、Sash のオリジナル（合わせて約8,300種。ビジネス・ものづくり・物流・動物・乗り物・食べ物・アルファベットなど）から、「お金」「配送」「ねこ」のようなあいまいな日本語でも絞り込み、色を選んで、そのままボタンのアイコンにできる（Excel がなくても使える）
- **コールバック管理**：正しいシグネチャでVBAスタブを生成し、未実装や不一致を検出。既存のマクロを選ぶと、それを呼ぶ Sub を作ってボタンに割り当てる
- **カタログ**：idMso / imageMso をあいまい検索
- **レシピ**：よく使う構成をXMLとVBAのセットで挿入
- **コマンドパレット（Ctrl+K）**：すべての操作を名前で呼び出し
- **コンテキストメニュー**：右クリックメニューへの項目の追加
- **Backstage**：［ファイル］タブへのタブ・ボタンの追加
- **差分と書き出し**：保存済みとの差分表示、`.sash.json` での書き出し・読み込み、customUI の XML の書き出し
- **別のブックから取り込む・比べる**：別のブック・XML・`.sash.json` から、タブやグループを画像ごと取り込み、別のブックと差分を見る
- **編集を守る**：未保存の編集の自動退避と復旧、ほかで書き換えられたブックの検知（保存・反映の前に知らせる）
- **アイコンライブラリ**：加工済みアイコンの保存と再利用（共有フォルダ対応）
- **英語UI**：設定で日本語 / English を切り替え

## インストール

[Releases](https://github.com/Yu5rin/Sash/releases) から最新の `Sash-<版>-win-x64.exe` をダウンロードし、好きなフォルダに置いて実行します。インストーラーはなく、この exe 1つで動きます（.NET のインストールも不要です）。

- 設定・アイコンライブラリ・レシピ・バックアップは `%AppData%\Sash` に保存します。exe を置き換えても消えません。
- コード署名をしていないため、初回の実行で SmartScreen の警告が出ます。「詳細情報」→「実行」で起動できます。
- `Program Files` など書き込めない場所に置くと、アプリの中からの更新ができません。ユーザーのフォルダに置くことをおすすめします。
- 動作には Microsoft Edge WebView2 ランタイム（Windows 10 / 11 に標準で入っています）が必要です。

## 更新

新しい版が出ると、起動時にタイトルバーでお知らせします。同意したときだけダウンロードし、SHA256 で照合してから入れ替えます。設定やアイコンライブラリはそのまま残ります。

会社のネットワークでも更新できるよう、GitHub の API の回数上限に当たらない方式で確認し、社内のプロキシに従います。インターネットに出られない PC では、社内の共有フォルダや社内の Web サーバーから更新できます。管理者が確認先をまとめて決めることもできます。詳しくは [docs/更新と社内配布.md](docs/更新と社内配布.md) を参照してください。

## 動作環境

- Windows 10 / 11（64bit）
- Excel 2016以降、またはMicrosoft 365（連携機能を使う場合）
- self-containedの単一exeで配布（インストール不要）

## ステータス

第1弾から第3弾まで（編集、VBAとの連携、Backstage・差分・アイコンライブラリ・英語UI）を実装しました。Windows 実機での動作確認はこれからです。仕様は [docs/SPEC.md](docs/SPEC.md)、実装状況は同じく §12〜§15 を参照してください。

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

[MIT License](LICENSE) で公開しています。

idMso の一覧（`ui/src/catalog/excelControls.json`）は、Microsoft の [office-fluent-ui-command-identifiers](https://github.com/OfficeDev/office-fluent-ui-command-identifiers)（MIT License）の Excel 分から作成しています。ライセンス文は `ui/src/catalog/` に同梱しています。

アイコン集のデータは、次の4つから作成しています。ライセンス文は、いずれも `ui/src/fluent/` に同梱し、アプリの「バージョン情報」→「サードパーティのライセンス」からも読めます。Office の imageMso の画像は同梱していません。

- `ui/src/fluent/fluentIcons.json`：Microsoft の [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons)（MIT License、npm パッケージ `@fluentui/svg-icons`）。ライセンス文は `LICENSE-fluentui-system-icons.txt`。作り直すときは `ui` で `npm run fluent-icons`
- `ui/src/fluent/tablerIcons.json`：[Tabler Icons](https://github.com/tabler/tabler-icons)（MIT License、Copyright (c) 2020-2026 Paweł Kuna、npm パッケージ `@tabler/icons`）。ブランドのロゴは除いています。ライセンス文は `LICENSE-tabler-icons.txt`。作り直すときは `ui` で `npm run tabler-icons`
- `ui/src/fluent/lucideIcons.json`：[Lucide](https://github.com/lucide-icons/lucide)（ISC License、一部は Feather 由来の MIT License、npm パッケージ `lucide-static`）から、業務で使う約190種を選んだもの。ライセンス文は `LICENSE-lucide.txt`。作り直すときは `ui` で `npm run lucide-icons`
- `ui/src/fluent/sashIcons.json`：Sash のために新しく描いたオリジナルのアイコン約100種（エレベーター・エスカレーター・旋盤・金型・パレット・見積書・段取り替え・外注・非常停止・ビジネスマンなど）。他のアイコン集の図形を写したものではありません。ライセンスは Sash と同じ MIT License（`LICENSE-sash-icons.txt`）。元の図は `ui/scripts/sash-icons.mjs`。作り直すときは `ui` で `npm run sash-icons`
