// メイン画面の上に重なるダイアログ。
// ダイアログ・コマンドパレットなど「画面の上に重なるもの」をひとつのスタック（レイヤー）で管理する。
// こうしておくと、Esc は一番上だけを閉じ（重ねたダイアログがまとめて閉じる不具合の対策）、
// 背景（#app と下のレイヤー）を inert にしてキーボード操作が裏へ抜けないようにできる。

import { h, svg } from '../dom';
import { t } from '../i18n';
import { uiIcons } from '../icons';

export interface ModalHandle {
  close(): void;
  root: HTMLElement;
}

export interface ModalOptions {
  /** 幅の広いダイアログ（カタログやアイコンエディタ）。size: 'lg' と同じ。 */
  wide?: boolean;
  /** wide のうえで、縦も広くとる（中身が多いダイアログ用。画面に収まる範囲で 720px まで）。 */
  tall?: boolean;
  /** Esc を押されたとき、先に呼ぶ。true を返したら、その Esc は処理済み（ダイアログは閉じない。ダイアログの中のポップアップを閉じるときに使う）。 */
  onEscape?: () => boolean;
  /** 大きさ。sm=確認、md=既定、lg=一覧や編集。 */
  size?: 'sm' | 'md' | 'lg';
  /** 下部のボタン。primary クラスのボタンは右端に並べ、Enter で押されるものとして扱う。 */
  footer?: HTMLElement[];
  onClose?: () => void;
  /** false なら Esc・×・背景のクリックで閉じない（更新中など、途中で閉じると困るもの）。 */
  closable?: boolean;
  /** 同じダイアログを二重に開かないための名前。開いていれば、そのダイアログを前に出して返す。 */
  key?: string;
  /** 最初にフォーカスする要素。省略時は最初の入力欄、なければ［閉じる］（data-initial-focus）、主ボタンの順。 */
  initialFocus?: HTMLElement;
}

interface Layer {
  id: number;
  key?: string;
  /** 背景を含むレイヤーの一番外側の要素。 */
  element: HTMLElement;
  /** フォーカスを閉じ込める範囲（ダイアログ本体）。 */
  dialog: HTMLElement;
  close: () => void;
  closable: boolean;
  onEscape?: () => boolean;
  handle: ModalHandle;
}

const layers: Layer[] = [];
let nextLayerId = 1;
let keyListening = false;

/** ダイアログやコマンドパレットが開いているか（開いている間はアプリ全体のショートカットを止める）。 */
export function isModalOpen(): boolean {
  return layers.length > 0;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
}

/** 一番上以外を inert にする。背景の #app も含める。 */
function updateInert(): void {
  const app = document.getElementById('app');
  if (app) app.inert = layers.length > 0;
  layers.forEach((l, i) => (l.element.inert = i !== layers.length - 1));
  // 通知をダイアログの右下のボタンに重ねないための目印（styles.css の .modal-open .toasts）
  document.body.classList.toggle('modal-open', layers.length > 0);
}

function onDocumentKey(e: KeyboardEvent): void {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    // 一番上のレイヤーだけを閉じる。下のダイアログまで閉じないよう伝播を止める
    e.stopPropagation();
    e.preventDefault();
    if (top.onEscape?.()) return;
    if (top.closable) top.close();
    return;
  }
  if (e.key === 'Tab') {
    const items = focusables(top.dialog);
    if (items.length === 0) {
      e.preventDefault();
      top.dialog.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    const inside = active !== null && top.dialog.contains(active);
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * レイヤーを積む（ダイアログ以外の重なるもの、例：コマンドパレットにも使う）。
 * element は document.body に追加済みでなくてよい。閉じるときは返り値の close を呼ぶ。
 */
export function pushLayer(opts: { element: HTMLElement; dialog: HTMLElement; closable?: boolean; key?: string; onClose?: () => void; onEscape?: () => boolean }): ModalHandle {
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const layer: Layer = {
    id: nextLayerId++,
    key: opts.key,
    element: opts.element,
    dialog: opts.dialog,
    closable: opts.closable ?? true,
    onEscape: opts.onEscape,
    close: () => {
      if (closed) return;
      closed = true;
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      opts.element.remove();
      updateInert();
      if (layers.length === 0 && keyListening) {
        document.removeEventListener('keydown', onDocumentKey, true);
        keyListening = false;
      }
      opts.onClose?.();
      // 開く前にフォーカスがあった場所へ戻す。消えていれば一番上のレイヤーへ
      if (previous && previous.isConnected && !previous.closest('[inert]')) previous.focus();
      else layers[layers.length - 1]?.dialog.focus();
    },
    handle: undefined as unknown as ModalHandle,
  };
  layer.handle = { close: layer.close, root: opts.dialog };
  if (!opts.element.isConnected) document.body.append(opts.element);
  layers.push(layer);
  updateInert();
  if (!keyListening) {
    document.addEventListener('keydown', onDocumentKey, true);
    keyListening = true;
  }
  return layer.handle;
}

/** 名前（key）で開いているレイヤーを探す。 */
function findLayer(key: string): Layer | undefined {
  return layers.find((l) => l.key === key);
}

/** フォーカスしてよい最初の要素を選ぶ。入力欄 → 主ボタン → そのほかのボタン の順。 */
function initialFocusTarget(dialog: HTMLElement): HTMLElement {
  const body = dialog.querySelector<HTMLElement>('.modal-body');
  const field = body && focusables(body).find((el) => el.matches('input, select, textarea, [contenteditable="true"]'));
  if (field) return field;
  // 閉じるだけのダイアログの［閉じる］は主ボタン（緑）にせず、この印で最初のフォーカスを置く（総点検 D-9）
  const closeOnly = dialog.querySelector<HTMLElement>('footer button[data-initial-focus]:not(:disabled)');
  if (closeOnly) return closeOnly;
  const primary = dialog.querySelector<HTMLElement>('footer button.primary:not(:disabled)');
  if (primary) return primary;
  const other = body && focusables(body)[0];
  if (other) return other;
  return dialog.querySelector<HTMLElement>('footer button:not(:disabled)') ?? dialog;
}

export function openModal(title: string, content: HTMLElement, opts: ModalOptions = {}): ModalHandle {
  if (opts.key) {
    const existing = findLayer(opts.key);
    if (existing) {
      existing.dialog.focus();
      return existing.handle;
    }
  }
  const closable = opts.closable ?? true;
  const size = opts.size ?? (opts.wide ? 'lg' : 'md');
  const titleId = `modal-title-${nextLayerId}`;
  const footerButtons = opts.footer ? orderFooter(opts.footer) : null;
  const dialog = h(
    'div',
    { class: `modal size-${size}${opts.wide ? ' wide' : ''}${opts.wide && opts.tall ? ' tall' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1 },
    h('header', null,
      h('h2', { id: titleId }, title),
      closable ? h('button', { type: 'button', class: 'icon-button modal-close', title: t('閉じる (Esc)'), 'aria-label': t('閉じる (Esc)'), onclick: () => handle.close() }, svg(uiIcons.close)) : null),
    h('div', { class: 'modal-body' }, content),
    footerButtons ? h('footer', null, footerButtons) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  // 背景のクリックで閉じる。ダイアログの中で押してから外で離したときは閉じない
  let downOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => (downOnBackdrop = e.target === backdrop));
  backdrop.addEventListener('mouseup', (e) => {
    if (closable && downOnBackdrop && e.target === backdrop) handle.close();
    downOnBackdrop = false;
  });
  // Enter で主ボタンを押す。複数行の入力欄・ボタン・リンクの上、日本語の変換中は除く
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest('textarea, button, a, select, [contenteditable="true"], [role="option"], [role="listbox"], .monaco-editor')) return;
    const primary = dialog.querySelector<HTMLButtonElement>('footer button.primary:not(:disabled)');
    if (!primary) return;
    e.preventDefault();
    primary.click();
  });
  const handle = pushLayer({ element: backdrop, dialog, closable, key: opts.key, onClose: opts.onClose, onEscape: opts.onEscape });
  (opts.initialFocus ?? initialFocusTarget(dialog)).focus();
  return handle;
}

const opening = new Set<string>();

/**
 * 同じダイアログを二重に開かないようにする。開いている（または開いている途中の）ときは、
 * 既存のダイアログを前に出して undefined を返す。fn の中で開いたダイアログには key を付けて覚える。
 */
export async function openOnce<T>(key: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  const existing = findLayer(key);
  if (existing) {
    existing.dialog.focus();
    return undefined;
  }
  if (opening.has(key)) return undefined;
  opening.add(key);
  const firstId = nextLayerId;
  try {
    return await fn();
  } finally {
    opening.delete(key);
    // fn の中で開いたレイヤー（key なし）に key を付ける。以後は findLayer で見つかる
    for (const l of layers) if (l.id >= firstId && l.key === undefined) l.key = key;
  }
}

/** 選択肢つきの確認。押したボタンの値を返す（閉じたら null）。 */
/** キャンセルのボタンか。ask() は data-role で、ほかのダイアログは文言で見分ける。 */
function isCancelButton(el: HTMLElement): boolean {
  return el.dataset['role'] === 'cancel' || (el.tagName === 'BUTTON' && el.textContent?.trim() === t('キャンセル'));
}

/**
 * 足もとのボタンを Windows の並びにする：肯定（主ボタン）を先に、キャンセルを右端に置く。
 * Excel の「保存しますか？」も［保存］［保存しない］［キャンセル］の順で、キャンセルが真ん中や左に来ると
 * 押し慣れた位置と違って押し間違えやすいため。class="footer-start" のもの（リンクなど）は左端に残す。
 */
export function orderFooter(items: HTMLElement[]): HTMLElement[] {
  const left = items.filter((b) => b.classList.contains('footer-start'));
  const rest = items.filter((b) => !b.classList.contains('footer-start'));
  const cancel = rest.filter(isCancelButton);
  const others = rest.filter((b) => !isCancelButton(b));
  const primary = others.filter((b) => b.classList.contains('primary'));
  const secondary = others.filter((b) => !b.classList.contains('primary'));
  return [...left, ...primary, ...secondary, ...cancel];
}

export function ask<T extends string>(title: string, message: string, buttons: { value: T; label: string; primary?: boolean; danger?: boolean }[], opts: { detail?: HTMLElement } = {}): Promise<T | null> {
  return new Promise((resolve) => {
    let answered = false;
    const footer = buttons.map((b) =>
      h('button', {
        type: 'button',
        class: [b.primary ? 'primary' : '', b.danger ? 'danger' : ''].filter(Boolean).join(' '),
        dataset: b.value === 'cancel' ? { role: 'cancel' } : undefined,
        onclick: () => {
          answered = true;
          resolve(b.value);
          m.close();
        },
      }, b.label),
    );
    const body = h('div', null, h('p', { class: 'modal-message' }, message), opts.detail ?? null);
    const m = openModal(title, body, {
      size: 'sm',
      footer,
      // 確認では、入力欄がないので主ボタンに最初からフォーカスを置く
      initialFocus: footer.find((b) => b.classList.contains('primary')) ?? footer[footer.length - 1],
      onClose: () => {
        if (!answered) resolve(null);
      },
    });
  });
}
