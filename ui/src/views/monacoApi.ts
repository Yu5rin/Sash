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

// エディタの色を、ほかのペインと同じ面（--surface）・補足の文字（--text-subtle）に合わせる（総点検 X-4）。
// vs-dark の既定（#1e1e1e）はダークのペイン（#292929）と違う色になり、スクロールバーも太く目立つため。
/** テーマを登録する（読み込み時ではなく、エディタを作るときに 1 回だけ。テスト環境の jsdom には CSS.escape がなく、読み込み時に呼ぶと落ちるため）。 */
let themesDefined = false;
export function ensureEditorThemes(): void {
  if (themesDefined) return;
  themesDefined = true;
  monaco.editor.defineTheme('sash-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editorGutter.background': '#ffffff',
      'editorLineNumber.foreground': '#5c5c5c',
      'editorLineNumber.activeForeground': '#1f1f1f',
      'scrollbarSlider.background': '#00000033',
      'scrollbarSlider.hoverBackground': '#00000055',
      'scrollbarSlider.activeBackground': '#00000066',
    },
  });
  monaco.editor.defineTheme('sash-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#292929',
      'editorGutter.background': '#292929',
      'editorLineNumber.foreground': '#b8b8b8',
      'editorLineNumber.activeForeground': '#f0f0f0',
      'scrollbarSlider.background': '#ffffff33',
      'scrollbarSlider.hoverBackground': '#ffffff55',
      'scrollbarSlider.activeBackground': '#ffffff66',
    },
  });
}

/** ライト／ダークに合わせたテーマ名。 */
export const editorThemeName = (dark: boolean): string => (dark ? 'sash-dark' : 'sash-light');

/** スクロールバーは 10px の細いものにする（既定は 14px で、横のバーが XML の下端に太い灰色の帯として残っていた）。 */
export const editorScrollbar = { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false } as const;
