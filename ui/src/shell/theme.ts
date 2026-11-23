// テーマ（ライト・ダーク・システム）とレイアウトの向きを画面に映す。
// data-theme には、システムに合わせるときも実際の明暗（light / dark）を必ず入れる。
// こうしておくと、CSS とビューは data-theme だけを見ればよい（システムの設定を二重に調べなくてよい）。

import { app } from '../app';
import { invoke, isHosted, type Settings } from '../bridge';

const darkQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let onDarkChange: ((dark: boolean) => void) | null = null;

/** XML エディタ（Monaco）のテーマを切り替える関数を登録する。Monaco は CSS の変数を読まないため。 */
export function setEditorThemeHandler(fn: (dark: boolean) => void): void {
  onDarkChange = fn;
  applyTheme();
}

export function isDark(): boolean {
  const theme = app.settings.theme;
  return theme === 'dark' || (theme === 'system' && (darkQuery?.matches ?? false));
}

export function applyTheme(): void {
  const dark = isDark();
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
  document.documentElement.dataset['themeSetting'] = app.settings.theme;
  onDarkChange?.(dark);
  syncTitleBar(dark);
  document.getElementById('app')?.classList.toggle('xml-on-top', app.settings.xmlOnTop);
}

darkQuery?.addEventListener('change', applyTheme);

let titleBarDark: boolean | null = null;

/**
 * Windows が描くタイトルバーの明暗をホストに伝える。WebView2 の中のテーマはタイトルバーに届かず、
 * ダークにしても上の帯だけ白く残るため。同じ値を何度も送らないよう、前回の値を覚えておく。
 */
function syncTitleBar(dark: boolean): void {
  if (!isHosted || titleBarDark === dark) return;
  titleBarDark = dark;
  invoke('app.titleBarTheme', { dark }).catch(() => {
    // 古い Windows などで失敗しても、タイトルバーの色が変わらないだけなので知らせない
    titleBarDark = null;
  });
}

/** 設定を変えて保存し、画面に映す。 */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  app.settings = await invoke('settings.set', patch);
  applyTheme();
  app.emit('settings');
  return app.settings;
}
