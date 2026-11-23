// パレット。部品をキャンバスかツリーへドラッグして置く。ダブルクリック・Enter で選択中の場所に追加する。
// - 分類ごとに畳める。検索欄で日本語名・タグ名（英語）から絞り込める
// - 今の選択では置けない部品も隠さずに薄く表示し、ツールチップで理由を示す（なぜ置けないかが分かるように）
// - ↑↓ で項目を移り、Enter で追加、←→ で分類を畳む・開く

import { app } from '../app';
import { endDrag, startDrag } from '../dnd';
import { h, svg } from '../dom';
import { kindIcon, uiIcons } from '../icons';
import { backstageElements, elements, titleOf } from '../schema';
import { t } from '../i18n';
import { insertAtSelection, probeInsert } from '../shell/compat';
import { normalizeForSearch } from '../shell/text';
import { toast } from '../shell/toast';

interface Category {
  id: string;
  title: string;
  tags: readonly string[];
}

/** 分類と並び。よく使うものを上に置く。 */
const CATEGORIES: readonly Category[] = [
  { id: 'ribbon', title: 'リボン', tags: ['tab', 'group'] },
  { id: 'controls', title: 'コントロール', tags: ['button', 'toggleButton', 'checkBox', 'dropDown', 'comboBox', 'editBox', 'gallery', 'labelControl', 'item', 'separator', 'menuSeparator', 'dialogBoxLauncher'] },
  { id: 'containers', title: 'コンテナ', tags: ['menu', 'splitButton', 'dynamicMenu', 'box', 'buttonGroup'] },
  { id: 'backstage', title: 'Backstage', tags: ['backstage', 'taskGroup', 'taskFormGroup', 'hyperlink', 'imageControl', 'groupBox', 'layoutContainer', 'radioGroup'] },
  { id: 'contextMenu', title: 'コンテキストメニュー', tags: ['contextMenu'] },
];

export const PALETTE_ITEMS: readonly string[] = CATEGORIES.flatMap((c) => c.tags);

const COLLAPSED_KEY = 'sash.palette.collapsed';

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // 保存できなくても、畳んだ状態がこの画面の間だけになるだけ
  }
}

/** 検索に使う文字列（今の言語の名前、日本語の名前、タグ名）。 */
function searchText(tag: string): string {
  const ja = elements.get(tag)?.title ?? backstageElements.get(tag)?.title ?? '';
  return normalizeForSearch(`${titleOf(tag)} ${ja} ${tag}`);
}

/** 置けない理由。置けるなら null。ファイルを開いていないときも理由を返す。 */
function unavailableReason(tag: string): string | null {
  const store = app.store;
  if (!store) return t('ファイルを開くと追加できます');
  return probeInsert(store.doc, store.selection, tag);
}

/** 選択中の場所に追加する。置けなければ理由を警告で知らせる。追加できたら true。 */
export function insertNearSelection(tag: string): boolean {
  const store = app.store;
  if (!store) {
    toast({ kind: 'warning', message: t('ファイルを開くと追加できます') });
    return false;
  }
  const r = insertAtSelection(store, tag, t('{name}を追加', { name: titleOf(tag) }));
  if (!r.ok && r.error) toast({ kind: 'warning', message: r.error });
  return r.ok;
}

export function mountPalette(host: HTMLElement): void {
  const collapsed = loadCollapsed();
  const search = h('input', { type: 'search', placeholder: t('部品を検索'), 'aria-label': t('部品を検索'), spellcheck: false });
  const cats = h('div', { class: 'palette-cats' });
  host.replaceChildren(h('div', { class: 'palette-search' }, search), cats);

  /** キーボードで移れる要素（分類の見出しと項目）。描き直すたびに作り直す。 */
  let stops: HTMLElement[] = [];
  let focusKey: string | null = null;
  const itemEls = new Map<string, HTMLElement>();

  const render = () => {
    const q = normalizeForSearch(search.value.trim());
    itemEls.clear();
    const sections = CATEGORIES.map((cat) => {
      const tags = cat.tags.filter((tag) => !q || searchText(tag).includes(q));
      if (tags.length === 0) return null;
      // 検索中は畳んでいても開いて見せる
      const open = q !== '' || !collapsed.has(cat.id);
      const listId = `palette-cat-${cat.id}`;
      const head = h('button', {
        type: 'button',
        class: 'palette-cat-head',
        'aria-expanded': String(open),
        'aria-controls': listId,
        tabIndex: -1,
        dataset: { stop: `cat:${cat.id}` },
        onclick: () => toggle(cat.id),
      }, svg(uiIcons.chevron), t(cat.title), h('span', { class: 'palette-cat-count' }, String(tags.length)));
      const list = h('ul', { class: 'palette-list', id: listId, role: 'listbox', 'aria-label': t(cat.title), hidden: !open },
        tags.map((tag) => {
          const li = h('li', {
            class: 'palette-item',
            role: 'option',
            'aria-selected': 'false',
            tabIndex: -1,
            draggable: true,
            dataset: { stop: `item:${tag}`, tag },
            ondragstart: (e: DragEvent) => startDrag(e, { kind: 'new', tag }),
            ondragend: () => endDrag(),
            ondblclick: () => insertNearSelection(tag),
          },
          h('span', { class: 'kind-icon' }, svg(kindIcon(tag))),
          h('span', { class: 'palette-name' }, titleOf(tag)),
          h('span', { class: 'palette-tag' }, tag));
          itemEls.set(tag, li);
          return li;
        }));
      return h('div', { class: 'palette-cat' }, head, list);
    }).filter((x): x is HTMLDivElement => x !== null);
    cats.replaceChildren(...(sections.length ? sections : [h('p', { class: 'palette-empty' }, t('一致する部品はありません'))]));
    stops = Array.from(cats.querySelectorAll<HTMLElement>('[data-stop]')).filter((el) => !el.closest('[hidden]'));
    const keep = stops.find((s) => s.dataset['stop'] === focusKey) ?? stops[0];
    if (keep) keep.tabIndex = 0;
    refreshAvailability();
  };

  const toggle = (id: string) => {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    saveCollapsed(collapsed);
    focusKey = `cat:${id}`;
    const hadFocus = cats.contains(document.activeElement);
    render();
    if (hadFocus) stops.find((s) => s.dataset['stop'] === focusKey)?.focus();
  };

  /** 置ける・置けないの表示を今の選択に合わせる。文書の写しで試すので、XML の入力中など続けて呼ばれたらまとめる。 */
  let timer = 0;
  const refreshAvailability = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      for (const [tag, li] of itemEls) {
        const reason = unavailableReason(tag);
        li.classList.toggle('unavailable', reason !== null);
        li.setAttribute('aria-disabled', String(reason !== null));
        li.title = reason
          ? `${titleOf(tag)}（${tag}）\n${reason}`
          : t('{name}（{tag}）\nダブルクリックか Enter で選択中の場所に追加、ドラッグで好きな場所に置く', { name: titleOf(tag), tag });
      }
    }, 80);
  };

  const focusStop = (i: number) => {
    const el = stops[Math.max(0, Math.min(i, stops.length - 1))];
    if (!el) return;
    for (const s of stops) s.tabIndex = -1;
    el.tabIndex = 0;
    focusKey = el.dataset['stop'] ?? null;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
  };

  cats.addEventListener('keydown', (e) => {
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-stop]');
    if (!current) return;
    const i = stops.indexOf(current);
    const key = current.dataset['stop']!;
    const isCat = key.startsWith('cat:');
    switch (e.key) {
      case 'ArrowDown':
        focusStop(i + 1);
        break;
      case 'ArrowUp':
        if (i === 0) search.focus();
        else focusStop(i - 1);
        break;
      case 'Home':
        focusStop(0);
        break;
      case 'End':
        focusStop(stops.length - 1);
        break;
      case 'ArrowLeft':
        if (isCat && current.getAttribute('aria-expanded') === 'true') toggle(key.slice(4));
        else if (!isCat) {
          // 項目からは、その分類の見出しへ
          const head = current.closest('.palette-cat')?.querySelector<HTMLElement>('.palette-cat-head');
          if (head) focusStop(stops.indexOf(head));
        }
        break;
      case 'ArrowRight':
        if (isCat && current.getAttribute('aria-expanded') === 'false') toggle(key.slice(4));
        break;
      case 'Enter':
      case ' ':
        if (isCat) toggle(key.slice(4));
        else insertNearSelection(key.slice(5));
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  cats.addEventListener('focusin', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-stop]');
    if (!el) return;
    for (const s of stops) s.tabIndex = s === el ? 0 : -1;
    focusKey = el.dataset['stop'] ?? null;
  });

  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusStop(stops.findIndex((s) => s.dataset['stop']?.startsWith('item:')));
    } else if (e.key === 'Enter') {
      // 検索して Enter で、最初に見つかった置ける部品を追加する
      const first = [...itemEls.entries()].find(([tag]) => unavailableReason(tag) === null);
      if (first) {
        e.preventDefault();
        insertNearSelection(first[0]);
      }
    } else if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation();
      search.value = '';
      render();
    }
  });

  app.on('session', refreshAvailability);
  app.on('store', (c) => {
    if (!c || c.kinds.has('doc') || c.kinds.has('selection')) refreshAvailability();
  });
  render();
}
