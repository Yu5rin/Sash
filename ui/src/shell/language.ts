// 画面の言語の切り替え。言語はモジュールの読み込み時に決まるので、切り替えたら読み込み直す。
// 読み込み直すと開いていたファイルが閉じるので、sessionStorage に覚えておいて開き直す。

import { app } from '../app';
import { invoke } from '../bridge';
import { lang, storeLang, t, type Lang } from '../i18n';
import { ask } from '../dialogs/modal';
import { isSampleSession } from '../sample';
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

/**
 * 未保存の変更があっても読み込み直してよいか。ふつうのファイルは先に保存してもらう（false）。
 * サンプルは保存できないので「保存してください」とは言わず、変更が破棄されることを確かめる。
 */
async function confirmReloadWithChanges(): Promise<boolean> {
  if (!app.dirty) return true;
  if (isSampleSession()) {
    const r = await ask(t('言語を切り替える'), t('サンプルへの変更は破棄されます。言語を切り替えますか？'), [
      { value: 'reload', label: t('破棄して切り替える'), danger: true },
      { value: 'cancel', label: t('キャンセル'), primary: true },
    ]);
    return r === 'reload';
  }
  toast({ kind: 'warning', message: t('言語を切り替える前に、変更を保存してください') });
  return false;
}

/** 読み込み直して言語を反映する。未保存の変更があるときは読み込み直さない（false を返す）。 */
export async function reloadForLanguage(): Promise<boolean> {
  if (!(await confirmReloadWithChanges())) return false;
  return reload();
}

function reload(): boolean {
  // パスのないセッション（同梱のサンプル）は開き直せないので、覚えない
  if (app.session?.path) sessionSet(REOPEN_KEY, app.session.path);
  location.reload();
  return true;
}

/** 言語を切り替えてすぐに読み込み直す（コマンドパレットから）。 */
export async function changeLanguage(next: Lang): Promise<boolean> {
  if (next === lang) return true;
  if (!(await confirmReloadWithChanges())) return false;
  try {
    await saveLanguage(next);
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
  return reload();
}
