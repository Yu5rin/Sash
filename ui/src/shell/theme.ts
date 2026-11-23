// テーマ（ライト・ダーク・システム）とレイアウトの向きを画面に映す。
// data-theme には、システムに合わせるときも実際の明暗（light / dark）を必ず入れる。
// こうしておくと、CSS とビューは data-theme だけを見ればよい（システムの設定を二重に調べなくてよい）。

import { app } from '../app';
import { invoke, type Settings } from '../bridge';

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
  document.getElementById('app')?.classList.toggle('xml-on-top', app.settings.xmlOnTop);
}

darkQuery?.addEventListener('change', applyTheme);

/** 設定を変えて保存し、画面に映す。 */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  app.settings = await invoke('settings.set', patch);
  applyTheme();
  app.emit('settings');
  return app.settings;
}
