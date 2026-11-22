// メイン画面の上に重なるダイアログ。

import { h, svg } from '../dom';
import { uiIcons } from '../icons';

export interface ModalHandle {
  close(): void;
  root: HTMLElement;
}

export function openModal(title: string, content: HTMLElement, opts: { wide?: boolean; footer?: HTMLElement[]; onClose?: () => void } = {}): ModalHandle {
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
    previous?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const dialog = h(
    'div',
    { class: `modal${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', null, h('h2', null, title), h('button', { type: 'button', class: 'icon-button', title: '閉じる (Esc)', onclick: close }, svg(uiIcons.close))),
    h('div', { class: 'modal-body' }, content),
    opts.footer ? h('footer', null, opts.footer) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, dialog);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  (dialog.querySelector<HTMLElement>('input, select, button:not(.icon-button)') ?? dialog).focus();
  return { close, root: dialog };
}

/** 選択肢つきの確認。押したボタンの値を返す（閉じたら null）。 */
export function ask<T extends string>(title: string, message: string, buttons: { value: T; label: string; primary?: boolean }[]): Promise<T | null> {
  return new Promise((resolve) => {
    let answered = false;
    const footer = buttons.map((b) =>
      h('button', {
        type: 'button',
        class: b.primary ? 'primary' : '',
        onclick: () => {
          answered = true;
          resolve(b.value);
          m.close();
        },
      }, b.label),
    );
    const m = openModal(title, h('p', { class: 'modal-message' }, message), {
      footer,
      onClose: () => {
        if (!answered) resolve(null);
      },
    });
    footer.find((b) => b.classList.contains('primary'))?.focus();
  });
}
