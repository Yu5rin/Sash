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

仕様策定中です。詳細は [docs/SPEC.md](docs/SPEC.md) を参照してください。

## ライセンス

未定
