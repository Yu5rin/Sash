// メニューバー（ファイル(F)・編集(E)…）。WAI-ARIA の menubar / menu / menuitem に沿って、キーボードだけで操作できるようにする。
// - Alt を押して離す、または F10 でメニューバーに移る。Alt+F などのアクセスキーで直接開く
// - ←→ でメニューを移り、↓ / Enter / Space で開く。↑↓ で項目を選び、→ でサブメニュー、Esc で一段ずつ閉じる
// - 項目の有効・無効やラベルは、開くたびに作り直して今の状態を映す（無効な項目も見えるようにして、何ができないかを示す）

import { h, svg } from '../dom';
import { lang, t } from '../i18n';
import { shellIcons } from './icons';
import { normalizeForSearch } from './text';

export interface MenuItemDef {
  type?: 'item' | 'separator' | 'submenu';
  label?: string;
  shortcut?: string;
  /** 省略時は有効。 */
  enabled?: boolean;
  /** true / false を指定するとラジオ（チェック）付きの項目になる。 */
  checked?: boolean;
  /** 項目のツールチップ（無効な理由など）。 */
  hint?: string;
  run?: () => void;
  /** サブメニューの中身。開くときに呼ぶ。Promise なら読み込み中を出してから埋める。 */
  items?: () => MenuItemDef[] | Promise<MenuItemDef[]>;
}

export interface MenuDef {
  id: string;
  label: string;
  /** アクセスキー（英字 1 文字）。 */
  mnemonic: string;
  items: () => MenuItemDef[];
}

export interface MenubarHandle {
  /** メニューバーにフォーカスを移す（開かない）。 */
  focus(): void;
  /** 開いているメニューを閉じる。 */
  close(): void;
  isOpen(): boolean;
  /** メニューバーにフォーカスがあるか、メニューが開いているか。 */
  isActive(): boolean;
  /** 指定したメニューを開く（テストやコマンドからも使う）。 */
  open(id: string): void;
}

interface Level {
  el: HTMLElement;
  items: MenuItemDef[];
  itemEls: HTMLElement[];
  active: number;
  /** サブメニューを開いた親の項目。 */
  parentEl: HTMLElement | null;
}

/** アクセスキーを表示用にする。日本語は「ファイル(F)」、英語はラベル中の文字に下線を引く。 */
function labelWithMnemonic(label: string, mnemonic: string): (Node | string)[] {
  if (lang === 'en') {
    const i = label.toLowerCase().indexOf(mnemonic.toLowerCase());
    if (i >= 0) return [label.slice(0, i), h('u', { class: 'mnemonic' }, label[i]!), label.slice(i + 1)];
  }
  return [label, h('span', { class: 'mnemonic-paren' }, '(', h('u', { class: 'mnemonic' }, mnemonic.toUpperCase()), ')')];
}

/** aria-keyshortcuts の書式（Control+S）にする。 */
function ariaShortcut(s: string): string {
  return s.replace(/Ctrl/g, 'Control').replace(/Del$/, 'Delete');
}

export function mountMenubar(host: HTMLElement, menus: readonly MenuDef[]): MenubarHandle {
  host.setAttribute('role', 'menubar');
  host.setAttribute('aria-label', t('メニュー'));
  host.classList.add('menubar');

  const buttons = menus.map((m, i) =>
    h('button', {
      type: 'button',
      class: 'menubar-item',
      role: 'menuitem',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      tabIndex: i === 0 ? 0 : -1,
      dataset: { menu: m.id },
    }, ...labelWithMnemonic(m.label, m.mnemonic)),
  );
  host.replaceChildren(...buttons);

  let openIndex: number | null = null;
  let levels: Level[] = [];
  /** メニューバーに入る前にフォーカスがあった要素。閉じたら戻す。 */
  let returnFocus: HTMLElement | null = null;
  let hoverTimer: number | undefined;

  const rememberReturn = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && !host.contains(a) && !a.closest('.menu-popup')) returnFocus = a;
  };

  const setRoving = (index: number) => buttons.forEach((b, i) => (b.tabIndex = i === index ? 0 : -1));

  const restoreFocus = () => {
    host.classList.remove('show-mnemonics');
    const target = returnFocus;
    returnFocus = null;
    if (target && target.isConnected) target.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };

  const closeLevelsFrom = (depth: number) => {
    for (const l of levels.splice(depth)) {
      l.el.remove();
      l.parentEl?.setAttribute('aria-expanded', 'false');
    }
  };

  const closeAll = (focusButton: boolean) => {
    window.clearTimeout(hoverTimer);
    closeLevelsFrom(0);
    if (openIndex !== null) {
      buttons[openIndex]!.setAttribute('aria-expanded', 'false');
      buttons[openIndex]!.classList.remove('open');
      if (focusButton) buttons[openIndex]!.focus();
    }
    openIndex = null;
  };

  const isEnabled = (item: MenuItemDef) => item.enabled !== false;
  const isFocusable = (item: MenuItemDef) => item.type !== 'separator';

  const focusItem = (level: Level, index: number) => {
    if (index < 0 || index >= level.items.length) return;
    level.active = index;
    level.itemEls.forEach((el, i) => el.classList.toggle('active', i === index));
    level.itemEls[index]?.focus();
  };

  const move = (level: Level, from: number, delta: 1 | -1) => {
    const n = level.items.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + delta * step) % n) + n) % n;
      if (isFocusable(level.items[i]!)) return focusItem(level, i);
    }
  };

  const activate = (item: MenuItemDef, depth: number) => {
    if (!isEnabled(item)) return;
    if (item.type === 'submenu' || item.items) {
      void openSubmenu(depth, true);
      return;
    }
    // 実行の前にフォーカスを元へ戻す（コマンドがダイアログを開くとき、閉じたあとの戻り先を正しくするため）
    closeAll(false);
    restoreFocus();
    item.run?.();
  };

  const renderItems = (level: Level, depth: number) => {
    level.itemEls = level.items.map((item, i) => {
      if (item.type === 'separator') return h('li', { role: 'separator', class: 'menu-sep' });
      const hasSub = item.type === 'submenu' || item.items !== undefined;
      const radio = item.checked !== undefined;
      const el = h(
        'li',
        {
          role: radio ? 'menuitemradio' : 'menuitem',
          class: `menu-item${isEnabled(item) ? '' : ' disabled'}`,
          tabIndex: -1,
          'aria-disabled': isEnabled(item) ? null : 'true',
          'aria-checked': radio ? String(item.checked) : null,
          'aria-haspopup': hasSub ? 'menu' : null,
          'aria-expanded': hasSub ? 'false' : null,
          'aria-keyshortcuts': item.shortcut ? ariaShortcut(item.shortcut) : null,
          title: item.hint ?? null,
        },
        h('span', { class: 'mi-check' }, item.checked ? svg(shellIcons.check) : null),
        h('span', { class: 'mi-label' }, item.label ?? ''),
        h('span', { class: 'mi-shortcut' }, item.shortcut ?? ''),
        h('span', { class: 'mi-sub' }, hasSub ? svg(shellIcons.submenu) : null),
      );
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        activate(item, depth);
      });
      el.addEventListener('mouseenter', () => {
        focusItem(level, i);
        window.clearTimeout(hoverTimer);
        // マウスで別の項目に移ったら、開いていた深いサブメニューを閉じ、サブメニューなら少し待って開く
        closeLevelsFrom(depth + 1);
        if (hasSub && isEnabled(item)) hoverTimer = window.setTimeout(() => void openSubmenu(depth, false), 180);
      });
      return el;
    });
    level.el.replaceChildren(...level.itemEls);
  };

  const place = (popup: HTMLElement, anchor: DOMRect, side: 'below' | 'right') => {
    popup.style.visibility = 'hidden';
    document.body.append(popup);
    const r = popup.getBoundingClientRect();
    let left = side === 'below' ? anchor.left : anchor.right - 2;
    let top = side === 'below' ? anchor.bottom : anchor.top - 4;
    if (left + r.width > window.innerWidth - 4) left = side === 'below' ? window.innerWidth - r.width - 4 : anchor.left - r.width + 2;
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
    popup.style.left = `${Math.max(4, left)}px`;
    popup.style.top = `${top}px`;
    popup.style.visibility = '';
  };

  const newLevel = (items: MenuItemDef[], labelledBy: HTMLElement, parentEl: HTMLElement | null): Level => {
    const el = h('ul', { class: 'menu-popup', role: 'menu', 'aria-label': labelledBy.textContent ?? '' });
    const level: Level = { el, items, itemEls: [], active: -1, parentEl };
    el.addEventListener('keydown', (e) => onMenuKey(e, levels.indexOf(level)));
    el.addEventListener('mousedown', (e) => e.preventDefault());
    return level;
  };

  const openMenu = (index: number, focus: 'first' | 'last' | 'none') => {
    closeAll(false);
    const menu = menus[index]!;
    const button = buttons[index]!;
    openIndex = index;
    setRoving(index);
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('open');
    const level = newLevel(menu.items(), button, null);
    levels = [level];
    renderItems(level, 0);
    place(level.el, button.getBoundingClientRect(), 'below');
    if (focus === 'none') {
      button.focus();
      return;
    }
    const order = level.items.map((_, i) => i);
    const pick = (focus === 'first' ? order : order.reverse()).find((i) => isFocusable(level.items[i]!));
    if (pick !== undefined) focusItem(level, pick);
  };

  const openSubmenu = async (depth: number, focusFirst: boolean) => {
    const parent = levels[depth];
    if (!parent) return;
    const item = parent.items[parent.active];
    const parentEl = parent.itemEls[parent.active];
    if (!item?.items || !parentEl) return;
    closeLevelsFrom(depth + 1);
    const level = newLevel([{ label: t('読み込み中…'), enabled: false }], parentEl, parentEl);
    level.el.classList.add('submenu');
    levels.push(level);
    parentEl.setAttribute('aria-expanded', 'true');
    renderItems(level, depth + 1);
    place(level.el, parentEl.getBoundingClientRect(), 'right');
    const loaded = await item.items();
    // 読み込んでいる間に閉じられていたら何もしない
    if (!levels.includes(level)) return;
    level.items = loaded.length > 0 ? loaded : [{ label: t('（なし）'), enabled: false }];
    renderItems(level, depth + 1);
    place(level.el, parentEl.getBoundingClientRect(), 'right');
    if (focusFirst) {
      const first = level.items.findIndex(isFocusable);
      if (first >= 0) focusItem(level, first);
    }
  };

  const typeAhead = (level: Level, ch: string) => {
    const c = normalizeForSearch(ch);
    const n = level.items.length;
    for (let step = 1; step <= n; step++) {
      const i = (level.active + step) % n;
      const it = level.items[i]!;
      if (isFocusable(it) && normalizeForSearch(it.label ?? '').startsWith(c)) return focusItem(level, i);
    }
  };

  const onMenuKey = (e: KeyboardEvent, depth: number) => {
    const level = levels[depth];
    if (!level || openIndex === null) return;
    const item = level.items[level.active];
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        move(level, level.active, 1);
        break;
      case 'ArrowUp':
        move(level, level.active < 0 ? 0 : level.active, -1);
        break;
      case 'Home':
        move(level, -1, 1);
        break;
      case 'End':
        move(level, 0, -1);
        break;
      case 'ArrowRight':
        if (item && (item.items || item.type === 'submenu') && isEnabled(item)) void openSubmenu(depth, true);
        else openMenu((openIndex + 1) % menus.length, 'first');
        break;
      case 'ArrowLeft':
        if (depth > 0) {
          closeLevelsFrom(depth);
          const parent = levels[depth - 1]!;
          focusItem(parent, parent.active);
        } else {
          openMenu((openIndex - 1 + menus.length) % menus.length, 'first');
        }
        break;
      case 'Enter':
      case ' ':
        if (item) activate(item, depth);
        break;
      case 'Escape':
        if (depth > 0) {
          closeLevelsFrom(depth);
          const parent = levels[depth - 1]!;
          focusItem(parent, parent.active);
        } else {
          closeAll(true);
        }
        break;
      case 'Tab':
        closeAll(false);
        restoreFocus();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) typeAhead(level, e.key);
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  buttons.forEach((b, i) => {
    b.addEventListener('mousedown', (e) => {
      // クリックでフォーカスが動く前に戻り先を覚える
      rememberReturn();
      e.preventDefault();
      if (openIndex === i) {
        closeAll(false);
        restoreFocus();
      } else {
        openMenu(i, 'none');
      }
    });
    b.addEventListener('mouseenter', () => {
      if (openIndex !== null && openIndex !== i) openMenu(i, 'none');
    });
    b.addEventListener('keydown', (e) => {
      let handled = true;
      switch (e.key) {
        case 'ArrowRight':
          if (openIndex !== null) openMenu((i + 1) % menus.length, 'first');
          else {
            setRoving((i + 1) % menus.length);
            buttons[(i + 1) % menus.length]!.focus();
          }
          break;
        case 'ArrowLeft':
          if (openIndex !== null) openMenu((i - 1 + menus.length) % menus.length, 'first');
          else {
            setRoving((i - 1 + menus.length) % menus.length);
            buttons[(i - 1 + menus.length) % menus.length]!.focus();
          }
          break;
        case 'ArrowDown':
        case 'Enter':
        case ' ':
          openMenu(i, 'first');
          break;
        case 'ArrowUp':
          openMenu(i, 'last');
          break;
        case 'Home':
          setRoving(0);
          buttons[0]!.focus();
          break;
        case 'End':
          setRoving(buttons.length - 1);
          buttons[buttons.length - 1]!.focus();
          break;
        case 'Escape':
          if (openIndex !== null) closeAll(true);
          else restoreFocus();
          break;
        case 'Tab':
          closeAll(false);
          host.classList.remove('show-mnemonics');
          handled = false;
          break;
        default: {
          // メニューバーにいるときは、Alt なしでもアクセスキーで開ける
          const idx = e.key.length === 1 && !e.ctrlKey && !e.metaKey ? menus.findIndex((m) => m.mnemonic.toLowerCase() === e.key.toLowerCase()) : -1;
          if (idx >= 0) openMenu(idx, 'first');
          else handled = false;
        }
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    b.addEventListener('focus', () => setRoving(i));
  });

  // メニューの外を押したら閉じる
  document.addEventListener('pointerdown', (e) => {
    if (openIndex === null) return;
    const target = e.target as Node;
    if (host.contains(target) || levels.some((l) => l.el.contains(target))) return;
    closeAll(false);
  }, true);
  window.addEventListener('blur', () => {
    if (openIndex !== null) closeAll(false);
  });
  window.addEventListener('resize', () => {
    if (openIndex !== null) closeAll(false);
  });
  host.addEventListener('focusout', (e) => {
    const next = e.relatedTarget as Node | null;
    if (next && (host.contains(next) || levels.some((l) => l.el.contains(next)))) return;
    if (openIndex === null) host.classList.remove('show-mnemonics');
  });

  // Alt の単独押し・F10 でメニューバーへ。Alt+文字で直接開く
  let altAlone = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') {
      altAlone = !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      return;
    }
    altAlone = false;
    if (document.getElementById('app')?.inert) return;
    if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      toggleFocus();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^Key[A-Z]$/.test(e.code)) {
      const letter = e.code.slice(3).toLowerCase();
      const idx = menus.findIndex((m) => m.mnemonic.toLowerCase() === letter);
      if (idx < 0) return;
      e.preventDefault();
      e.stopPropagation();
      rememberReturn();
      host.classList.add('show-mnemonics');
      openMenu(idx, 'first');
    }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altAlone) return;
    altAlone = false;
    if (document.getElementById('app')?.inert) return;
    e.preventDefault();
    toggleFocus();
  }, true);
  // マウス操作（Alt+クリックの複数カーソルなど）のあとの Alt はメニューに移らない
  window.addEventListener('pointerdown', () => (altAlone = false), true);

  const isActive = () => openIndex !== null || host.contains(document.activeElement);

  const toggleFocus = () => {
    if (isActive()) {
      closeAll(false);
      restoreFocus();
      return;
    }
    rememberReturn();
    host.classList.add('show-mnemonics');
    const i = buttons.findIndex((b) => b.tabIndex === 0);
    buttons[Math.max(0, i)]!.focus();
  };

  return {
    focus: () => {
      if (!isActive()) toggleFocus();
    },
    close: () => closeAll(false),
    isOpen: () => openIndex !== null,
    isActive,
    open: (id: string) => {
      const i = menus.findIndex((m) => m.id === id);
      if (i < 0) return;
      rememberReturn();
      openMenu(i, 'first');
    },
  };
}
