// キャンバスとツリーの右クリックメニュー（仕様書 §5.2・§5.3）。
// キーボードでも操作できるよう、矢印キーで項目を移り、→ でサブメニューを開き、Esc で閉じる。

import { app } from '../app';
import {
  canDuplicateEl, canMove, childTags, copyId, hasClip, insertNew, moveSelected, runCommand, siblingTags,
} from '../clipboard';
import { h } from '../dom';
import { childElements, elementAt, pathOf, type Path } from '../model';
import { titleOf } from '../schema';
import type { Source } from '../store';
import { t } from '../i18n';

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run?: () => void;
  submenu?: () => MenuItem[];
}

type Entry = MenuItem | 'sep';

let current: { root: HTMLElement; close: () => void } | null = null;

/** 開いているメニューを閉じる。 */
export function closeMenu(): void {
  current?.close();
}

/** x, y（画面座標）にメニューを出す。 */
export function openMenu(x: number, y: number, entries: Entry[], opts: { restoreFocus?: HTMLElement | null } = {}): void {
  closeMenu();
  const layers: HTMLElement[] = [];
  // サブメニューを開いた親の項目（← で戻るときにフォーカスを返す）
  const openers = new WeakMap<HTMLElement, HTMLElement>();
  const restore = opts.restoreFocus ?? (document.activeElement as HTMLElement | null);

  const close = () => {
    for (const l of layers) l.remove();
    layers.length = 0;
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', close, true);
    current = null;
    restore?.focus({ preventScroll: true });
  };

  const onDown = (e: MouseEvent) => {
    if (!layers.some((l) => l.contains(e.target as Node))) close();
  };

  const build = (list: Entry[], px: number, py: number, depth: number): HTMLElement => {
    const menu = h('div', { class: 'ctx-menu', role: 'menu', tabIndex: -1 });
    const items: HTMLElement[] = [];
    const closeDeeper = () => {
      while (layers.length > depth + 1) layers.pop()!.remove();
    };
    const openSub = (row: HTMLElement, item: MenuItem, focusFirst: boolean) => {
      closeDeeper();
      const sub = item.submenu?.() ?? [];
      const r = row.getBoundingClientRect();
      const child = build(sub.length ? sub : [{ label: t('（追加できるものはありません）'), disabled: true }], r.right - 2, r.top - 4, depth + 1);
      openers.set(child, row);
      if (focusFirst) child.querySelector<HTMLElement>('.ctx-item:not(.disabled)')?.focus();
    };
    for (const entry of list) {
      if (entry === 'sep') {
        menu.append(h('div', { class: 'ctx-sep', role: 'separator' }));
        continue;
      }
      const row = h(
        'div',
        {
          class: `ctx-item${entry.disabled ? ' disabled' : ''}${entry.submenu ? ' has-sub' : ''}`,
          role: 'menuitem',
          tabIndex: -1,
          'aria-disabled': entry.disabled ? 'true' : undefined,
          'aria-haspopup': entry.submenu ? 'menu' : undefined,
          onmouseenter: () => {
            row.focus({ preventScroll: true });
            if (entry.submenu && !entry.disabled) openSub(row, entry, false);
            else closeDeeper();
          },
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            if (entry.disabled) return;
            if (entry.submenu) {
              openSub(row, entry, true);
              return;
            }
            close();
            entry.run?.();
          },
        },
        h('span', { class: 'ctx-label' }, entry.label),
        entry.shortcut ? h('span', { class: 'ctx-shortcut' }, entry.shortcut) : null,
        entry.submenu ? h('span', { class: 'ctx-arrow', 'aria-hidden': 'true' }, '›') : null,
      );
      items.push(row);
      menu.append(row);
    }
    menu.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const enabled = items.filter((i) => !i.classList.contains('disabled'));
      const idx = enabled.indexOf(document.activeElement as HTMLElement);
      const focusAt = (i: number) => enabled[(i + enabled.length) % enabled.length]?.focus();
      if (e.key === 'ArrowDown') focusAt(idx + 1);
      else if (e.key === 'ArrowUp') focusAt(idx < 0 ? enabled.length - 1 : idx - 1);
      else if (e.key === 'Home') focusAt(0);
      else if (e.key === 'End') focusAt(enabled.length - 1);
      else if (e.key === 'Enter' || e.key === ' ') (document.activeElement as HTMLElement | null)?.click();
      else if (e.key === 'ArrowRight') {
        const row = document.activeElement as HTMLElement;
        if (row.classList.contains('has-sub')) row.click();
      } else if (e.key === 'ArrowLeft' && depth > 0) {
        closeDeeper();
        layers.pop()?.remove();
        // 親メニューの、このサブメニューを開いた項目に戻る
        openers.get(menu)?.focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    document.body.append(menu);
    // 画面からはみ出さないよう位置を直す
    const r = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(px, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(py, window.innerHeight - r.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    layers.push(menu);
    return menu;
  };

  const root = build(entries, x, y, 0);
  current = { root, close };
  root.querySelector<HTMLElement>('.ctx-item:not(.disabled)')?.focus({ preventScroll: true });
  // 開いたときのクリックで閉じないよう、次のタスクから外側のクリックを見る
  window.setTimeout(() => {
    if (current?.root !== root) return;
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
  });
}

export interface ElementMenuHooks {
  /** XML エディタでその要素を表示する。 */
  revealInXml?: (path: Path) => void;
}

let hooks: ElementMenuHooks = {};

/** XML で表示などの、他のビューへの橋渡しを登録する。 */
export function setElementMenuHooks(h0: ElementMenuHooks): void {
  hooks = { ...hooks, ...h0 };
}

/** 要素の右クリックメニュー。開く前に、その要素を選択しておく。 */
export function openElementMenu(x: number, y: number, path: Path, source: Source, restoreFocus?: HTMLElement | null): void {
  const store = app.store;
  const el = store ? elementAt(store.doc, path) : null;
  if (!store || !el) return;
  const isRoot = el === store.doc.documentElement;
  const tagItems = (tags: string[], make: (tag: string) => void): MenuItem[] => tags.map((tag) => ({ label: `${titleOf(tag)}  <${tag}>`, run: () => make(tag) }));
  const parent = el.parentElement;
  const entries: Entry[] = [
    { label: t('切り取り'), shortcut: 'Ctrl+X', disabled: isRoot, run: () => runCommand('cut', source) },
    { label: t('コピー'), shortcut: 'Ctrl+C', disabled: isRoot, run: () => runCommand('copy', source) },
    { label: t('貼り付け'), shortcut: 'Ctrl+V', disabled: !hasClip(), run: () => runCommand('paste', source) },
    { label: t('複製'), shortcut: 'Ctrl+D', disabled: isRoot || !canDuplicateEl(el), run: () => runCommand('duplicate', source) },
    { label: t('削除'), shortcut: 'Delete', disabled: isRoot, run: () => runCommand('delete', source) },
    'sep',
    {
      label: t('前に挿入'),
      disabled: !parent || siblingTags(el).length === 0,
      submenu: () => tagItems(siblingTags(el), (tag) => parent && insertNew(pathOf(parent), tag, childElements(parent).indexOf(el), source)),
    },
    { label: t('子を追加'), disabled: childTags(el).length === 0, submenu: () => tagItems(childTags(el), (tag) => insertNew(path, tag, null, source)) },
    'sep',
    { label: t('上へ移動'), shortcut: 'Alt+↑', disabled: !canMove(el, -1), run: () => moveSelected(-1, source) },
    { label: t('下へ移動'), shortcut: 'Alt+↓', disabled: !canMove(el, 1), run: () => moveSelected(1, source) },
    'sep',
    { label: t('XML で表示'), disabled: !hooks.revealInXml, run: () => hooks.revealInXml?.(path) },
    { label: t('ID をコピー'), disabled: !(el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ')), run: () => copyId() },
  ];
  openMenu(x, y, entries, { restoreFocus });
}
