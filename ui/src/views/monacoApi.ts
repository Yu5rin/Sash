// Monaco を読み込む入口（XML エディタと差分ダイアログが使う）。
// - 日本語の画面では、Monaco 本体より先に日本語のメッセージ（nls.messages.ja.js）を読み込む。
//   Monaco は文言を読み込み時に決めるので、順序が逆だと検索欄などが英語のまま固定される（総点検 X-1）。
//   そのため、このモジュールの中で動的 import を順に待ち、使う側はここから monaco を受け取る
//   （top-level await のあるモジュールに依存させることで、使う側の評価が読み込み後になる）。
// - 右クリックメニュー（切り取り・コピー・貼り付けなど）の部品もここで読み込む。
//   製品版は WebView2 の既定のメニューを切っているので、Monaco 自身のメニューが要る（総点検 G-3）。

import type * as MonacoApi from 'monaco-editor/esm/vs/editor/editor.api';
import { lang } from '../i18n';

if (lang === 'ja') await import('monaco-editor/esm/nls.messages.ja.js');

export const monaco: typeof MonacoApi = await import('monaco-editor/esm/vs/editor/editor.api');

await Promise.all([
  import('monaco-editor/esm/vs/basic-languages/xml/xml.contribution'),
  import('monaco-editor/esm/vs/editor/contrib/folding/browser/folding'),
  import('monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController'),
  import('monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution'),
  import('monaco-editor/esm/vs/editor/contrib/find/browser/findController'),
  import('monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu'),
  import('monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard'),
]);
