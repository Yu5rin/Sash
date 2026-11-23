// キャンバスとツリーの右クリックメニュー（仕様書 §5.2・§5.3）。
// キーボードでも操作できるよう、矢印キーで項目を移り、→ でサブメニューを開き、Esc で閉じる。

import { app } from '../app';
import {
  canDuplicateEl, childTags, clipCount, copyId, hasClip, insertNew, moveDisabledReason, moveSelected, moveToNewGroupSelected, newGroupDisabledReason,
  runCommand, setSizeSelected, siblingTags, sizeTargets,
} from '../clipboard';
import { duplicateMany, dryRun } from '../multiEdit';
import { h } from '../dom';
import { childElements, elementAt, pathOf, type Path } from '../model';
import { titleOf } from '../schema';
import type { Source } from '../store';
import { t } from '../i18n';

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** 無効の理由。項目の下に小さく出す（無効の項目はツールチップが出ない環境があり、押せない理由が分からないため）。 */
  reason?: string;
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
          class: `ctx-item${entry.disabled ? ' disabled' : ''}${entry.submenu ? ' has-sub' : ''}${entry.reason ? ' has-reason' : ''}`,
          role: 'menuitem',
          title: entry.reason ?? '',
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
        h('span', { class: 'ctx-label' }, entry.label, entry.reason ? h('span', { class: 'ctx-reason' }, entry.reason) : null),
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
  /**
   * 末尾に足す項目（「マクロを Excel で実行」「VBE で表示」など。仕様書 §18.4・§18.5）。
   * Excel 連携の操作は main.ts 側で組み立て、このファイルは並べるだけにする（ビューが Excel 連携に依存しないように）。
   */
  extraItems?: (path: Path, el: Element) => MenuItem[];
}

let hooks: ElementMenuHooks = {};

/** XML で表示などの、他のビューへの橋渡しを登録する。 */
export function setElementMenuHooks(h0: ElementMenuHooks): void {
  hooks = { ...hooks, ...h0 };
}

/**
 * 挿入できたら、足した要素のラベルをキャンバスでその場編集に入れる（C-1。足した要素は毎回「クリック → F2 → 入力」が要ったため）。
 * キャンバスから開いたメニューのときだけ行う（ツリーから開いたときに、フォーカスをキャンバスへ奪わないため）。
 * canvas.ts を import すると循環するので、イベントで知らせる。
 */
function inserted(ok: boolean, source: Source): void {
  const sel = app.store?.selection;
  if (ok && source === 'canvas' && sel) window.dispatchEvent(new CustomEvent('sash:startRename', { detail: { path: [...sel] } }));
}

/** 要素の右クリックメニュー。開く前に、その要素を選択しておく。 */
export function openElementMenu(x: number, y: number, path: Path, source: Source, restoreFocus?: HTMLElement | null): void {
  const store = app.store;
  const el = store ? elementAt(store.doc, path) : null;
  if (!store || !el) return;
  if (store.isMulti && store.isSelected(path)) {
    openMultiMenu(x, y, source, restoreFocus);
    return;
  }
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
      submenu: () => tagItems(siblingTags(el), (tag) => parent && inserted(insertNew(pathOf(parent), tag, childElements(parent).indexOf(el), source), source)),
    },
    { label: t('子を追加'), disabled: childTags(el).length === 0, submenu: () => tagItems(childTags(el), (tag) => inserted(insertNew(path, tag, null, source), source)) },
    'sep',
    { label: t('上へ移動'), shortcut: 'Alt+↑', disabled: moveDisabledReason(-1) !== null, run: () => moveSelected(-1, source) },
    { label: t('下へ移動'), shortcut: 'Alt+↓', disabled: moveDisabledReason(1) !== null, run: () => moveSelected(1, source) },
    ...layoutItems(source),
    'sep',
    { label: t('XML で表示'), disabled: !hooks.revealInXml, run: () => hooks.revealInXml?.(path) },
    { label: t('ID をコピー'), disabled: !(el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ')), run: () => copyId() },
  ];
  const extra = hooks.extraItems?.(path, el) ?? [];
  if (extra.length) entries.push('sep', ...extra);
  openMenu(x, y, entries, { restoreFocus });
}

/**
 * 幅を詰めるときに使う操作（仕様書 §19）：新しいグループに移す・大きさをまとめて変える。
 * 新しいグループに移すは、リボンのグループの中のコントロールのときだけ出す（ほかの要素では意味がないため）。
 */
function layoutItems(source: Source): MenuItem[] {
  const items: MenuItem[] = [];
  const groupReason = newGroupDisabledReason();
  const store = app.store;
  const inGroups = store?.selectedElements.every((e) => e.parentElement?.localName === 'group' && e.parentElement.parentElement?.localName === 'tab') ?? false;
  if (inGroups) items.push({ label: t('新しいグループに移す'), disabled: groupReason !== null, reason: groupReason ?? undefined, run: () => moveToNewGroupSelected(source) });
  const sized = sizeTargets();
  if (sized.length > 0) {
    const n = store?.isMulti ? t('（{n} 個）', { n: sized.length }) : '';
    items.push(
      { label: t('大きく（size=large）') + n, run: () => setSizeSelected('large', source) },
      { label: t('小さく（size=normal）') + n, run: () => setSizeSelected('normal', source) },
    );
  }
  return items;
}

/**
 * 複数選択のときの右クリックメニュー。数を名前に出し、使えない操作は理由を添えて無効にする。
 * 前に挿入・子を追加・ID をコピーなど、1つの要素を前提にした操作は出さない。
 */
function openMultiMenu(x: number, y: number, source: Source, restoreFocus?: HTMLElement | null): void {
  const store = app.store;
  if (!store) return;
  const n = store.selections.length;
  const dupReason = dryRun(store.doc, (copy) => duplicateMany(copy, store.selections));
  const up = moveDisabledReason(-1);
  const down = moveDisabledReason(1);
  const clips = clipCount();
  const entries: Entry[] = [
    { label: t('{n} 個を切り取り', { n }), shortcut: 'Ctrl+X', run: () => runCommand('cut', source) },
    { label: t('{n} 個をコピー', { n }), shortcut: 'Ctrl+C', run: () => runCommand('copy', source) },
    { label: clips > 1 ? t('{n} 個を貼り付け', { n: clips }) : t('貼り付け'), shortcut: 'Ctrl+V', disabled: !hasClip(), run: () => runCommand('paste', source) },
    { label: t('{n} 個を複製', { n }), shortcut: 'Ctrl+D', disabled: dupReason !== null, reason: dupReason ?? undefined, run: () => runCommand('duplicate', source) },
    { label: t('{n} 個を削除', { n }), shortcut: 'Delete', run: () => runCommand('delete', source) },
    'sep',
    { label: t('上へ移動'), shortcut: 'Alt+↑', disabled: up !== null, reason: up ?? undefined, run: () => moveSelected(-1, source) },
    { label: t('下へ移動'), shortcut: 'Alt+↓', disabled: down !== null, reason: down ?? undefined, run: () => moveSelected(1, source) },
    ...layoutItems(source),
    'sep',
    { label: t('選択を解除（主な選択だけ残す）'), shortcut: 'Esc', run: () => store.clearMulti(source) },
  ];
  openMenu(x, y, entries, { restoreFocus });
}
