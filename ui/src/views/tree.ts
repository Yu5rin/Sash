// ツリー（仕様書 §5.3）。customUI の階層をそのまま表示し、キャンバスで選びにくい要素もここで操作する。

import '../styles-views.css';
import { app } from '../app';
import { handleEditKey, moveSelected } from '../clipboard';
import { canDropInto, drop, endDrag, startDrag } from '../dnd';
import { h, svg } from '../dom';
import { kindIcon, uiIcons } from '../icons';
import { allElements, displayName, identifierOf, pathOf, samePath, type Path } from '../model';
import { openElementMenu } from './contextMenu';
import { focusField } from './inspector';
import { t } from '../i18n';

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

/** ツリーにフォーカスを移す（Ctrl+2 / F6）。 */
export function focus(): void {
  if (!hostEl) return;
  hostEl.focus({ preventScroll: true });
  scrollToSelected(hostEl);
}

export function mountTree(host: HTMLElement): void {
  hostEl = host;
  host.tabIndex = 0;
  host.addEventListener('keydown', (e) => onKey(e, host));
  host.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
    const path = row ? parsePath(row.dataset['path']) : null;
    if (!path || !app.store) return;
    e.preventDefault();
    app.store.select(path, 'tree');
    openElementMenu(e.clientX, e.clientY, path, 'tree', host);
  });
  // ドラッグを Esc で取り消したり、ツリーの外に落としたりしたときも印を残さない（不具合 33）
  window.addEventListener('dragend', () => clearDropMarks(host), true);
  window.addEventListener('drop', () => clearDropMarks(host), true);
  const render = () => renderTree(host);
  app.on('session', () => {
    known = new WeakSet();
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

  const rows: HTMLElement[] = [];
  const walk = (el: Element, depth: number) => {
    const path = pathOf(el);
    const k = path.join('.');
    const fk = foldKey(el, path);
    const hasKids = el.children.length > 0;
    const isCollapsed = collapsed.has(fk);
    const c = counts.get(k);
    const selected = samePath(store.selection, path);
    const name = displayName(el);
    const id = el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ');
    const label = name && name !== id ? name : el.localName;
    const tooltip = [label, `<${el.localName}>${id ? ` ${id}` : ''}`, c?.error ? t('エラー {n}', { n: c.error }) : '', c?.warning ? t('警告 {n}', { n: c.warning }) : ''].filter(Boolean).join('\n');
    const row = h(
      'div',
      {
        id: rowId(path),
        class: `tree-row${selected ? ' selected' : ''}${el.getAttribute('visible') === 'false' ? ' hidden-el' : ''}`,
        role: 'treeitem',
        'aria-selected': String(selected),
        'aria-expanded': hasKids ? String(!isCollapsed) : undefined,
        'aria-level': String(depth + 1),
        title: tooltip,
        draggable: depth > 0,
        dataset: { path: k, fold: fk },
        style: `padding-left:${4 + depth * 14}px`,
        onclick: () => store.select(path, 'tree'),
        ondblclick: () => focusField('label'),
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
            if (isCollapsed) collapsed.delete(fk);
            else collapsed.add(fk);
            renderTree(host);
          },
        },
        hasKids ? svg(uiIcons.chevron) : null,
      ),
      h('span', { class: 'kind-icon', title: el.localName }, svg(kindIcon(el.localName))),
      h('span', { class: 'tree-label' }, label),
      id ? h('span', { class: 'tree-id' }, id) : null,
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
  const canSibling = parent !== null && canDropInto(doc, parent);
  const canInside = canDropInto(doc, el);
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
  if (handleEditKey(e, 'tree')) return;
  const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row'));
  const idx = rows.findIndex((r) => r.classList.contains('selected'));
  const pathAt = (i: number) => parsePath(rows[i]!.dataset['path'])!;
  const selRow = idx >= 0 ? rows[idx]! : null;
  const sel = store.selection;

  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    moveSelected(e.key === 'ArrowUp' ? -1 : 1, 'tree');
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
    focusField('label');
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
