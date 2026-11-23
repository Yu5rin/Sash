// 通知（トースト）。画面右下に最大 3 件まで積む。
// - エラーは role="alert" で読み上げ、利用者が閉じるまで残す（読み逃すと原因が分からなくなるため）
// - それ以外は 4〜6 秒で消える。マウスを乗せている間・フォーカスがある間は止める
// - 「元に戻す」「開く」などのボタンを 1 つ付けられる

import { h, svg } from '../dom';
import { t } from '../i18n';
import { uiIcons } from '../icons';
import { shellIcons } from './icons';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  message: string;
  action?: ToastAction;
  /** 消えるまでのミリ秒。0 なら閉じるまで残す。省略時は種類ごとの既定値（エラーは残す）。 */
  timeout?: number;
}

export interface ToastHandle {
  close(): void;
  /** 文言を差し替える（「反映しています…」→ 結果、のように同じ通知を使い回す）。 */
  update(opts: ToastOptions): void;
}

const MAX_TOASTS = 3;

/** 種類ごとの既定の表示時間。警告は読む量が多いことが多いので長めにする。 */
export const DEFAULT_TIMEOUT: Readonly<Record<ToastKind, number>> = { info: 5000, success: 4000, warning: 6000, error: 0 };

const ICONS: Readonly<Record<ToastKind, string>> = { info: uiIcons.info, success: shellIcons.success, warning: uiIcons.warning, error: uiIcons.error };

interface Entry {
  el: HTMLElement;
  opts: Required<Pick<ToastOptions, 'kind' | 'message'>> & ToastOptions;
  timer: number | undefined;
  remaining: number;
  startedAt: number;
  paused: boolean;
  close: () => void;
}

const entries: Entry[] = [];

function container(): HTMLElement {
  let host = document.getElementById('toasts');
  if (!host) {
    // #app の外に置く（ダイアログを開いて #app を inert にしても通知は操作できるように）
    host = h('div', { id: 'toasts', class: 'toasts' });
    document.body.append(host);
  }
  return host;
}

function schedule(entry: Entry): void {
  window.clearTimeout(entry.timer);
  entry.timer = undefined;
  if (entry.remaining <= 0 || entry.paused) return;
  entry.startedAt = Date.now();
  entry.timer = window.setTimeout(entry.close, entry.remaining);
}

function pause(entry: Entry): void {
  if (entry.paused) return;
  entry.paused = true;
  if (entry.timer !== undefined) {
    window.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.remaining = Math.max(1000, entry.remaining - (Date.now() - entry.startedAt));
  }
}

function resume(entry: Entry): void {
  if (!entry.paused) return;
  // 中にフォーカスが残っている間は止めたままにする
  if (entry.el.matches(':hover') || entry.el.contains(document.activeElement)) return;
  entry.paused = false;
  schedule(entry);
}

function render(entry: Entry): void {
  const { kind, message, action } = entry.opts;
  entry.el.className = `toast ${kind}`;
  // エラーと警告はすぐに読み上げる。それ以外は控えめに
  entry.el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  entry.el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  entry.el.replaceChildren(
    h('span', { class: 'toast-icon' }, svg(ICONS[kind])),
    h('span', { class: 'toast-message' }, message),
    action
      ? h('button', { type: 'button', class: 'toast-action', onclick: () => { entry.close(); action.run(); } }, action.label)
      : null,
    h('button', { type: 'button', class: 'icon-button toast-close', title: t('通知を閉じる'), 'aria-label': t('通知を閉じる'), onclick: () => entry.close() }, svg(uiIcons.close)),
  );
}

/** 通知を出す。 */
export function toast(opts: ToastOptions): ToastHandle {
  const kind = opts.kind ?? 'info';
  const host = container();

  // 直前と同じ文言なら新しく積まずに時間だけ延ばす（連打で同じ通知が並ばないように）
  const last = entries[entries.length - 1];
  if (last && last.opts.message === opts.message && last.opts.kind === kind && !opts.action) {
    last.remaining = opts.timeout ?? DEFAULT_TIMEOUT[kind];
    schedule(last);
    return { close: last.close, update: (o) => updateEntry(last, o) };
  }

  const el = h('div', { class: `toast ${kind}` });
  const entry: Entry = {
    el,
    opts: { ...opts, kind },
    timer: undefined,
    remaining: opts.timeout ?? DEFAULT_TIMEOUT[kind],
    startedAt: Date.now(),
    paused: false,
    close: () => {
      const i = entries.indexOf(entry);
      if (i < 0) return;
      entries.splice(i, 1);
      window.clearTimeout(entry.timer);
      // 閉じた通知にフォーカスがあったら、行き場を失わないよう本文へ戻す
      const hadFocus = el.contains(document.activeElement);
      el.remove();
      if (hadFocus) (document.querySelector<HTMLElement>('.modal:last-of-type') ?? document.body).focus?.();
    },
  };
  el.addEventListener('mouseenter', () => pause(entry));
  el.addEventListener('mouseleave', () => resume(entry));
  el.addEventListener('focusin', () => pause(entry));
  el.addEventListener('focusout', () => window.setTimeout(() => resume(entry), 0));
  render(entry);
  entries.push(entry);
  host.append(el);

  // 多すぎるときは古いものから消す。閉じるまで残すエラーは、ほかがあればなるべく残す
  while (entries.length > MAX_TOASTS) {
    const victim = entries.find((e) => e.opts.kind !== 'error') ?? entries[0]!;
    victim.close();
  }
  schedule(entry);
  return { close: entry.close, update: (o) => updateEntry(entry, o) };
}

function updateEntry(entry: Entry, opts: ToastOptions): void {
  if (!entries.includes(entry)) {
    toast(opts);
    return;
  }
  const kind = opts.kind ?? 'info';
  entry.opts = { ...opts, kind };
  entry.remaining = opts.timeout ?? DEFAULT_TIMEOUT[kind];
  render(entry);
  schedule(entry);
}

/** すべての通知を閉じる（テスト用）。 */
export function clearToasts(): void {
  for (const e of [...entries]) e.close();
}

/**
 * 従来の呼び出し形（toast(message, kind)）。views/bottom.ts やダイアログに渡している関数と同じ形。
 * 'error' 以外の種類も受け付ける。
 */
export function notify(message: string, kind: ToastKind = 'info'): void {
  toast({ kind, message });
}
