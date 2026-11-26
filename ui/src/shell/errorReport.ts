// 想定外の例外の受け皿（総点検 G-5）。
// 製品版は開発者ツールが使えないので、握りつぶされた例外は「押しても何も起きない」になり、
// 利用者にも開発者にも原因が分からない。window の error / unhandledrejection を拾って、
// (1) 通知で知らせ、(2) ホストのログ（app.log）に残す。

import { invoke } from '../bridge';
import { t } from '../i18n';
import { toast } from './toast';

/** 例外から、画面に出す短い文とログ用の長い文を取り出す。 */
export function describeUnexpected(reason: unknown): { message: string; stack: string } {
  if (reason instanceof Error) return { message: reason.message || reason.name, stack: reason.stack ?? '' };
  if (typeof reason === 'string') return { message: reason, stack: '' };
  try {
    return { message: JSON.stringify(reason) ?? String(reason), stack: '' };
  } catch {
    return { message: String(reason), stack: '' };
  }
}

/** 害のない通知（レイアウトの測り直しなど）。利用者に見せても何もできないので無視する。 */
const IGNORED = [/ResizeObserver loop/i];

/** 同じ文言の通知は 1 回だけ出す（繰り返し起きる例外で通知が埋まらないように）。ログは毎回書く。 */
const shown = new Set<string>();

/** テスト用。出した文言の記録を消す。 */
export function resetErrorReport(): void {
  shown.clear();
}

/**
 * 想定外の例外を、通知とログに出す。context は「どこで起きたか」（ログにだけ付ける）。
 * ここで投げ直さない（受け皿の中でさらに例外が出ても、利用者の操作を止めないため）。
 */
export function reportUnexpected(reason: unknown, context = ''): void {
  const { message, stack } = describeUnexpected(reason);
  if (IGNORED.some((re) => re.test(message))) return;
  try {
    invoke('app.log', { level: 'error', message: context ? `${context}: ${message}` : message, stack }).catch(() => undefined);
  } catch {
    // ログに書けなくても通知は出す
  }
  if (shown.has(message)) return;
  shown.add(message);
  try {
    toast({ kind: 'error', message: t('予期しないエラーが起きました：{message}', { message }) });
  } catch {
    // 通知の部品そのものが壊れているとき。何もできないので諦める
  }
}

let installed = false;

/** window の error / unhandledrejection を受ける。2 回呼んでも 1 回だけ登録する。 */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => reportUnexpected(e.error ?? e.message, 'error'));
  window.addEventListener('unhandledrejection', (e) => reportUnexpected(e.reason, 'unhandledrejection'));
}
