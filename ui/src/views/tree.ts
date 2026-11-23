// ツリー（仕様書 §5.3）。customUI の階層をそのまま表示し、キャンバスで選びにくい要素もここで操作する。

import '../styles-views.css';
import { app } from '../app';
import { handleEditKey, moveSelected } from '../clipboard';
import { canDropInto, canDropManyAt, drop, endDrag, startDrag } from '../dnd';
import { debounce, h, svg } from '../dom';
import { kindIcon, uiIcons } from '../icons';
import { allElements, displayName, elementAt, identifierOf, pathOf, samePath, type Path } from '../model';
import { defFor } from '../schema';
import { openElementMenu } from './contextMenu';
import { focusField } from './inspector';
import { t } from '../i18n';
import { filterTree, splitHighlight, type TreeFilterResult } from '../treeFilter';
import '../styles-w3.css';

/**
 * 畳んだ要素。id（なければパス）で覚える。
 * パスだけで覚えると、前に要素を挿入しただけで別の要素が畳まれてしまうため（不具合 32）。
 */
const collapsed = new Set<string>();

let hostEl: HTMLElement | null = null;
let known = new WeakSet<Element>();
let flashPath: Path | null = null;
let typeAhead = '';
let typeAheadTimer: number | undefined;
/** 絞り込みの検索語。空なら絞り込まない。 */
let filterQuery = '';
let filterInput: HTMLInputElement | null = null;
let filterCount: HTMLElement | null = null;
/** 行の中でラベルを書き換えている間。描き直しで入力欄を消してしまわないよう、この間は描き直しを止める。 */
let renaming = false;

/** 絞り込みの欄にフォーカスを移す（コマンドから呼ぶ）。 */
export function focusTreeFilter(): void {
  filterInput?.focus();
  filterInput?.select();
}

/** ツリーにフォーカスを移す（Ctrl+2 / F6）。 */
export function focus(): void {
  if (!hostEl) return;
  hostEl.focus({ preventScroll: true });
  scrollToSelected(hostEl);
}

export function mountTree(host: HTMLElement): void {
  hostEl = host;
  host.tabIndex = 0;
  // Ctrl+クリック・Shift+クリックで複数を選べる（仕様書 §19）
  host.setAttribute('aria-multiselectable', 'true');
  mountFilter(host);
  host.addEventListener('keydown', (e) => onKey(e, host));
  host.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
    const path = row ? parsePath(row.dataset['path']) : null;
    if (!path || !app.store) return;
    e.preventDefault();
    // 複数選択の中の行で開いたときは、選択を保ったまま、まとめての操作のメニューを出す
    if (!(app.store.isMulti && app.store.isSelected(path))) app.store.select(path, 'tree');
    openElementMenu(e.clientX, e.clientY, path, 'tree', host);
  });
  // ドラッグを Esc で取り消したり、ツリーの外に落としたりしたときも印を残さない（不具合 33）
  window.addEventListener('dragend', () => clearDropMarks(host), true);
  window.addEventListener('drop', () => clearDropMarks(host), true);
  const render = () => renderTree(host);
  app.on('session', () => {
    known = new WeakSet();
    // 別のファイルを開いたら、前のファイルの検索語は意味がないので消す
    setFilter('', host);
    render();
  });
  app.on('problems', render);
  app.on('store', (c) => {
    const store = app.store;
    if (!c || !store) return;
    if (c.kinds.has('doc') && c.source !== 'xml' && c.source !== 'history') {
      const sel = store.selectedElement;
      if (sel && !known.has(sel)) flashPath = store.selection;
    }
    if (c.kinds.has('doc') || c.kinds.has('selection')) render();
    // ツリーの中で選び直したとき（矢印キーなど）も、選んだ行が見えるようにする（不具合 23）
    if (c.kinds.has('selection') || flashPath) scrollToSelected(host);
    flashPath = null;
  });
}

/**
 * 絞り込み中なら、ツリーに見えている行のパス（上から順）。絞り込んでいなければ null。
 * メニューやコマンドパレットの「同じ階層をすべて選択」が、絞り込みで隠れた要素まで選ばないようにするため。
 */
export function filteredTreePaths(): Path[] | null {
  return hostEl && filterQuery.trim() ? visibleRowPaths(hostEl) : null;
}

/** いま見えている行のパス（上から順）。 */
function visibleRowPaths(host: HTMLElement): Path[] {
  return Array.from(host.querySelectorAll<HTMLElement>('.tree-row'), (r) => parsePath(r.dataset['path'])!);
}

function parsePath(s: string | undefined): Path | null {
  if (s === undefined) return null;
  return s === '' ? [] : s.split('.').map(Number);
}

/** 畳んだ状態を覚えるためのキー。 */
function foldKey(el: Element, path: Path): string {
  const ident = identifierOf(el);
  return ident ? `${el.localName}#${ident}` : `path:${path.join('.')}`;
}

function rowId(path: Path): string {
  return `tree-row-${path.join('-') || 'root'}`;
}

function renderTree(host: HTMLElement): void {
  if (renaming) return;
  const store = app.store;
  if (!store) {
    host.replaceChildren();
    return;
  }
  const counts = new Map<string, { error: number; warning: number }>();
  for (const p of app.problems) {
    if (p.severity === 'info') continue;
    const k = p.path.join('.');
    const c = counts.get(k) ?? { error: 0, warning: 0 };
    c[p.severity]++;
    counts.set(k, c);
  }

  const filter = filterTree(store.doc, filterQuery);
  updateFilterCount(filter);
  const rows: HTMLElement[] = [];
  const walk = (el: Element, depth: number) => {
    // 絞り込み中は、合った要素とその祖先だけを出す
    if (filter && !filter.visible.has(el)) return;
    const path = pathOf(el);
    const k = path.join('.');
    const fk = foldKey(el, path);
    const hasKids = filter ? Array.from(el.children).some((c) => filter.visible.has(c)) : el.children.length > 0;
    // 絞り込み中は畳んだ状態を無視して開く（畳んだ中に合った要素が隠れて「0 件ではないのに見えない」にならないよう）
    const isCollapsed = !filter && collapsed.has(fk);
    const hit = filter?.matches.has(el) ?? false;
    const c = counts.get(k);
    const selected = samePath(store.selection, path);
    // 主な選択以外に選んでいる行（複数選択）
    const secondary = !selected && store.isMulti && store.isSelected(path);
    const name = displayName(el);
    const id = el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ');
    const label = name && name !== id ? name : el.localName;
    const tooltip = [label, `<${el.localName}>${id ? ` ${id}` : ''}`, c?.error ? t('エラー {n}', { n: c.error }) : '', c?.warning ? t('警告 {n}', { n: c.warning }) : ''].filter(Boolean).join('\n');
    const row = h(
      'div',
      {
        id: rowId(path),
        class: `tree-row${selected ? ' selected' : ''}${secondary ? ' multi-selected' : ''}${el.getAttribute('visible') === 'false' ? ' hidden-el' : ''}${filter ? (hit ? ' filter-hit' : ' filter-ancestor') : ''}`,
        role: 'treeitem',
        'aria-selected': String(selected || secondary),
        // 絞り込み中は畳めないので、開閉の状態を伝えない（← で親へ移れるようにする）
        'aria-expanded': hasKids && !filter ? String(!isCollapsed) : undefined,
        'aria-level': String(depth + 1),
        title: tooltip,
        draggable: depth > 0,
        dataset: { path: k, fold: fk },
        style: `padding-left:${4 + depth * 14}px`,
        onclick: (e: MouseEvent) => {
          if (e.ctrlKey || e.metaKey) store.toggleSelect(path, 'tree');
          // 親が違う行の間は、いま見えている行の順で範囲を決める（畳んだ中の要素は選ばない）
          else if (e.shiftKey) store.selectRange(path, 'tree', visibleRowPaths(host));
          else store.select(path, 'tree');
        },
        ondblclick: () => {
          if (!startRename(host, path)) focusField('label');
        },
        ondragstart: (e: DragEvent) => startDrag(e, { kind: 'move', path }),
        ondragend: () => {
          endDrag();
          clearDropMarks(host);
        },
        ondragover: (e: DragEvent) => onDragOver(e, el, row),
        ondragleave: () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'),
        ondrop: (e: DragEvent) => onDrop(e, el, row),
      },
      h(
        'span',
        {
          class: `twisty${hasKids ? '' : ' empty'}${isCollapsed ? '' : ' open'}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            if (filter) return;
            if (isCollapsed) collapsed.delete(fk);
            else collapsed.add(fk);
            renderTree(host);
          },
        },
        hasKids ? svg(uiIcons.chevron) : null,
      ),
      h('span', { class: 'kind-icon', title: el.localName }, svg(kindIcon(el.localName))),
      h('span', { class: 'tree-label' }, highlighted(label, hit)),
      id ? h('span', { class: 'tree-id' }, highlighted(id, hit)) : null,
      c && c.error > 0 ? h('span', { class: 'badge error', 'aria-label': t('エラー {n}', { n: c.error }) }, String(c.error)) : null,
      c && c.error === 0 && c.warning > 0 ? h('span', { class: 'badge warning', 'aria-label': t('警告 {n}', { n: c.warning }) }, String(c.warning)) : null,
    );
    if (flashPath && samePath(flashPath, path)) {
      row.classList.add('flash');
      window.setTimeout(() => row.classList.remove('flash'), 900);
    }
    rows.push(row);
    if (hasKids && !isCollapsed) for (const child of Array.from(el.children)) walk(child, depth + 1);
  };
  walk(store.doc.documentElement, 0);
  host.replaceChildren(...rows);
  known = new WeakSet(allElements(store.doc));
  if (store.selection) host.setAttribute('aria-activedescendant', rowId(store.selection));
  else host.removeAttribute('aria-activedescendant');
}

/** 検索語に合った部分を <mark> で囲む。合った要素の行だけ強調する（祖先の行は場所を示すだけなので強調しない）。 */
function highlighted(text: string, hit: boolean): (string | HTMLElement)[] {
  if (!hit) return [text];
  return splitHighlight(text, filterQuery).map((p) => (p.hit ? h('mark', { class: 'tree-mark' }, p.text) : p.text));
}

/** ツリーの上に絞り込みの欄を置く。#tree（role="tree"）の中に入れると行の並びと読み上げが崩れるので、兄弟として前に置く。 */
function mountFilter(host: HTMLElement): void {
  const input = h('input', {
    type: 'search',
    class: 'tree-filter-input',
    // 既定のペインの幅（248px）で切れないよう短くし、何で絞り込めるかはツールチップに出す
    placeholder: t('絞り込み'),
    title: t('ラベル・id・idMso・画像・コールバック名で絞り込みます（Ctrl+F）'),
    'aria-label': t('ツリーを絞り込む'),
    'aria-controls': host.id || undefined,
    spellcheck: false,
    autocomplete: 'off',
  });
  const count = h('span', { class: 'tree-filter-count', 'aria-live': 'polite' });
  filterInput = input;
  filterCount = count;
  // 日本語の変換中は絞り込まない（確定前の読みで一覧が跳ねないように）。確定したとき（compositionend）に絞り込む
  let composing = false;
  const apply = debounce(() => setFilter(input.value, host), 120);
  input.addEventListener('compositionstart', () => (composing = true));
  input.addEventListener('compositionend', () => {
    composing = false;
    apply();
  });
  input.addEventListener('input', (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    apply();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || composing) return;
    if (e.key === 'Escape') {
      // 検索語があれば消す。空ならツリーに戻る（Esc が上のダイアログなどに抜けないよう、ここで止める）
      e.preventDefault();
      e.stopPropagation();
      if (input.value) {
        input.value = '';
        setFilter('', host);
      } else {
        host.focus({ preventScroll: true });
      }
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      // ↓ と Enter でツリーへ移る。選択が見えていなければ、最初に合った行を選ぶ
      e.preventDefault();
      setFilter(input.value, host);
      enterTree(host);
    }
  });
  const bar = h('div', { class: 'tree-filter', role: 'search' }, svg(uiIcons.catalog), input, count);
  host.before(bar);
}

function enterTree(host: HTMLElement): void {
  const store = app.store;
  host.focus({ preventScroll: true });
  if (!store) return;
  const selected = host.querySelector('.tree-row.selected');
  if (selected) return;
  const first = host.querySelector<HTMLElement>('.tree-row.filter-hit') ?? host.querySelector<HTMLElement>('.tree-row');
  const path = first ? parsePath(first.dataset['path']) : null;
  if (path) store.select(path, 'tree');
}

function setFilter(query: string, host: HTMLElement): void {
  if (filterInput && filterInput.value !== query && query === '') filterInput.value = '';
  if (query === filterQuery) return;
  filterQuery = query;
  renderTree(host);
}

function updateFilterCount(filter: TreeFilterResult | null): void {
  if (!filterCount) return;
  filterCount.textContent = filter ? (filter.matches.size ? t('{n} 件', { n: filter.matches.size }) : t('一致なし')) : '';
  filterCount.classList.toggle('none', filter !== null && filter.matches.size === 0);
}

function scrollToSelected(host: HTMLElement): void {
  const store = app.store;
  const sel = store?.selection;
  if (!store || !sel) return;
  // 選択した要素の祖先が畳まれていたら開く
  let changed = false;
  let el: Element | null = store.doc.documentElement;
  for (let i = 0; i < sel.length && el; i++) {
    if (collapsed.delete(foldKey(el, sel.slice(0, i)))) changed = true;
    el = el.children[sel[i]!] ?? null;
  }
  if (changed) renderTree(host);
  host.querySelector('.tree-row.selected')?.scrollIntoView({ block: 'nearest' });
}

function clearDropMarks(host: HTMLElement): void {
  host.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((r) => r.classList.remove('drop-before', 'drop-after', 'drop-inside'));
}

type Zone = 'before' | 'after' | 'inside';

function zoneOf(e: DragEvent, el: Element, row: HTMLElement): Zone | null {
  const doc = el.ownerDocument;
  const rect = row.getBoundingClientRect();
  const y = (e.clientY - rect.top) / rect.height;
  const parent = el.parentElement;
  const index = parent ? Array.prototype.indexOf.call(parent.children, el) as number : -1;
  // まとめて運んでいるときは、並び順と個数まで確かめる（置けない位置には印を出さない）
  const canSibling = parent !== null && canDropInto(doc, parent) && (canDropManyAt(doc, pathOf(parent), y < 0.5 ? index : index + 1));
  const canInside = canDropInto(doc, el) && canDropManyAt(doc, pathOf(el), el.children.length);
  if (canInside && ((y > 0.25 && y < 0.75) || !canSibling)) return 'inside';
  if (canSibling) return y < 0.5 ? 'before' : 'after';
  return null;
}

function onDragOver(e: DragEvent, el: Element, row: HTMLElement): void {
  const zone = zoneOf(e, el, row);
  row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  if (!zone) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    return;
  }
  e.preventDefault();
  row.classList.add(`drop-${zone}`);
}

function onDrop(e: DragEvent, el: Element, row: HTMLElement): void {
  const zone = zoneOf(e, el, row);
  row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  if (!zone) {
    endDrag();
    return;
  }
  e.preventDefault();
  if (zone === 'inside') {
    drop(pathOf(el), el.children.length, 'tree');
    return;
  }
  const parent = el.parentElement!;
  const index = Array.prototype.indexOf.call(parent.children, el) as number;
  drop(pathOf(parent), zone === 'before' ? index : index + 1, 'tree');
}

function onKey(e: KeyboardEvent, host: HTMLElement): void {
  const store = app.store;
  if (!store || e.isComposing) return;
  // Ctrl+A は見えている行（絞り込み・畳んだ行で隠れていないもの）の兄弟だけを選ぶ（仕様書 §19.1）
  if (handleEditKey(e, 'tree', () => visibleRowPaths(host))) return;
  const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row'));
  const idx = rows.findIndex((r) => r.classList.contains('selected'));
  const pathAt = (i: number) => parsePath(rows[i]!.dataset['path'])!;
  const selRow = idx >= 0 ? rows[idx]! : null;
  const sel = store.selection;

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    // ツリーの中で Ctrl+F を押したら絞り込みの欄へ（ブラウザのページ内検索を出さない）
    focusTreeFilter();
  } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    moveSelected(e.key === 'ArrowUp' ? -1 : 1, 'tree');
  } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && idx >= 0) {
    // Shift+↑↓：起点から1行ずつ範囲を広げる・狭める（仕様書 §19）。主な選択が範囲の動く端になる
    const next = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
    if (next >= 0 && next < rows.length) store.selectRange(pathAt(next), 'tree', visibleRowPaths(host));
  } else if (e.key === 'Escape' && store.isMulti) {
    // 複数選択をやめ、主な選択だけに戻す
    store.clearMulti('tree');
  } else if (e.key === 'ArrowDown') {
    if (idx < rows.length - 1) store.select(pathAt(idx + 1), 'tree');
  } else if (e.key === 'ArrowUp') {
    if (idx > 0) store.select(pathAt(idx - 1), 'tree');
    else if (idx < 0 && rows.length) store.select(pathAt(0), 'tree');
  } else if (e.key === 'Home') {
    if (rows.length) store.select(pathAt(0), 'tree');
  } else if (e.key === 'End') {
    if (rows.length) store.select(pathAt(rows.length - 1), 'tree');
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel && selRow) {
    const fk = selRow.dataset['fold']!;
    const expandable = selRow.getAttribute('aria-expanded') !== null;
    const open = selRow.getAttribute('aria-expanded') === 'true';
    if (e.key === 'ArrowLeft') {
      // 開いていれば畳み、畳んでいれば（または子がなければ）親に移る
      if (expandable && open) {
        collapsed.add(fk);
        renderTree(host);
      } else if (sel.length > 0) {
        store.select(sel.slice(0, -1), 'tree');
      }
    } else if (expandable && !open) {
      collapsed.delete(fk);
      renderTree(host);
    } else if (expandable && open && idx < rows.length - 1) {
      // 開いていれば、最初の子に移る
      store.select(pathAt(idx + 1), 'tree');
    }
  } else if (e.key === 'Enter' || e.key === 'F2') {
    // その場でラベルを直す（インスペクタへ飛ぶと Esc で戻れず、確定してもフォーカスがツリーから離れてしまうため）。
    // ラベルを持たない要素や VBA で返すラベルのときだけ、従来どおりインスペクタの欄へ移る
    if (!sel || !startRename(host, sel)) focusField('label');
  } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && sel && selRow) {
    const r = selRow.getBoundingClientRect();
    openElementMenu(r.left + 24, r.bottom, sel, 'tree', host);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
    // 先頭の文字で探す（続けて打つと、その文字列で始まる行に移る）
    window.clearTimeout(typeAheadTimer);
    typeAhead += e.key.toLowerCase();
    typeAheadTimer = window.setTimeout(() => (typeAhead = ''), 700);
    const label = (r: HTMLElement) => (r.querySelector('.tree-label')?.textContent ?? '').toLowerCase();
    const start = typeAhead.length === 1 ? idx + 1 : Math.max(idx, 0);
    const order = [...rows.slice(start), ...rows.slice(0, start)];
    const hit = order.find((r) => label(r).startsWith(typeAhead) || (r.querySelector('.tree-id')?.textContent ?? '').toLowerCase().startsWith(typeAhead));
    if (hit) store.select(parsePath(hit.dataset['path'])!, 'tree');
  } else {
    return;
  }
  e.preventDefault();
}

/**
 * ツリーの行でラベルをその場で書き換える（キャンバスの F2 と同じ。Enter で確定、Esc で取り消し）。
 * 確定してもツリーにフォーカスを残す。ラベルを持てない要素や、VBA で返すラベルなら false。
 */
export function startRename(host: HTMLElement, path: Path): boolean {
  const store = app.store;
  const el = store ? elementAt(store.doc, path) : null;
  if (!store || !el || el.hasAttribute('getLabel') || !defFor(el)?.attrs.includes('label')) return false;
  const row = host.querySelector<HTMLElement>(`.tree-row[data-path="${path.join('.')}"]`);
  const labelNode = row?.querySelector<HTMLElement>('.tree-label');
  if (!row || !labelNode || renaming) return false;
  const original = el.getAttribute('label') ?? '';
  const input = h('input', { type: 'text', class: 'tree-rename', value: original, spellcheck: false, 'aria-label': t('ラベル') });
  const saved = Array.from(labelNode.childNodes);
  const wasDraggable = row.draggable;
  let done = false;
  /** keyboard：Enter・Esc で終えたとき。フォーカスをツリーに戻す。ほかの場所をクリックして外れたとき（blur）は、移った先を奪わない。 */
  const finish = (commit: boolean, keyboard: boolean) => {
    if (done) return;
    done = true;
    renaming = false;
    const v = input.value;
    if (!keyboard && (!commit || v === original)) {
      // 何も変えずに外れたときは、行を作り直さない（クリックした先の行が消えて、選べなくなるのを避ける）
      labelNode.replaceChildren(...saved);
      row.draggable = wasDraggable;
      return;
    }
    if (commit && v !== original) {
      store.edit('tree', (doc) => {
        const target = elementAt(doc, path);
        if (!target) return undefined;
        if (v === '') target.removeAttribute('label');
        else target.setAttribute('label', v);
        return undefined;
      }, t('ラベルを「{name}」に変更', { name: v }));
    }
    renderTree(host);
    if (keyboard) host.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    // 日本語入力の変換確定の Enter で確定しない
    if (e.isComposing || e.keyCode === 229) return;
    e.stopPropagation();
    if (e.key === 'Enter') finish(true, true);
    else if (e.key === 'Escape') finish(false, true);
  });
  input.addEventListener('blur', () => finish(true, false));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  renaming = true;
  row.draggable = false;
  labelNode.replaceChildren(input);
  input.focus();
  input.select();
  return true;
}
