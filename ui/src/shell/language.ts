// 画面の言語の切り替え。言語はモジュールの読み込み時に決まるので、切り替えたら読み込み直す。
// 読み込み直すと開いていたファイルが閉じるので、sessionStorage に覚えておいて開き直す。

import { app } from '../app';
import { invoke } from '../bridge';
import { lang, storeLang, t, type Lang } from '../i18n';
import { toast } from './toast';

export const REOPEN_KEY = 'sash.reopen';
export const LANG_SYNC_KEY = 'sash.langSynced';

export function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // 保存できない環境では何もしない
  }
}

/** 言語の設定だけを保存する（読み込み直しはしない）。 */
export async function saveLanguage(next: Lang): Promise<void> {
  storeLang(next);
  app.settings = await invoke('settings.set', { language: next });
}

/** 今の画面の言語と、保存した言語が違うか（読み込み直しが必要か）。 */
export function reloadNeeded(): boolean {
  return app.settings.language !== lang;
}

/** 読み込み直して言語を反映する。未保存の変更があるときは読み込み直さない（false を返す）。 */
export function reloadForLanguage(): boolean {
  if (app.dirty) {
    toast({ kind: 'warning', message: t('言語を切り替える前に、変更を保存してください') });
    return false;
  }
  // パスのないセッション（同梱のサンプル）は開き直せないので、覚えない
  if (app.session?.path) sessionSet(REOPEN_KEY, app.session.path);
  location.reload();
  return true;
}

/** 言語を切り替えてすぐに読み込み直す（コマンドパレットから）。 */
export async function changeLanguage(next: Lang): Promise<boolean> {
  if (next === lang) return true;
  if (app.dirty) {
    toast({ kind: 'warning', message: t('言語を切り替える前に、変更を保存してください') });
    return false;
  }
  try {
    await saveLanguage(next);
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
  return reloadForLanguage();
}
