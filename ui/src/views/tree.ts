// ツリー（仕様書 §5.3）。customUI の階層をそのまま表示し、キャンバスで選びにくい要素もここで操作する。

import { app } from '../app';
import { canDropInto, drop, endDrag, startDrag } from '../dnd';
import { h, svg } from '../dom';
import { kindIcon, uiIcons } from '../icons';
import { displayName, elementAt, isAncestorPath, pathOf, samePath, type Path } from '../model';

const collapsed = new Set<string>();

export function mountTree(host: HTMLElement): void {
  host.tabIndex = 0;
  host.addEventListener('keydown', (e) => onKey(e, host));
  const render = () => renderTree(host);
  app.on('session', render);
  app.on('problems', render);
  app.on('store', (c) => {
    if (!c) return;
    if (c.kinds.has('doc') || c.kinds.has('selection')) render();
    if (c.kinds.has('selection') && c.source !== 'tree') scrollToSelected(host);
  });
}

function key(path: Path): string {
  return path.join('.');
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
    const k = key(p.path);
    const c = counts.get(k) ?? { error: 0, warning: 0 };
    c[p.severity]++;
    counts.set(k, c);
  }

  const rows: HTMLElement[] = [];
  const walk = (el: Element, depth: number) => {
    const path = pathOf(el);
    const k = key(path);
    const hasKids = el.children.length > 0;
    const isCollapsed = collapsed.has(k);
    const c = counts.get(k);
    const selected = samePath(store.selection, path);
    const name = displayName(el);
    const id = el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ');
    const row = h(
      'div',
      {
        class: `tree-row${selected ? ' selected' : ''}`,
        role: 'treeitem',
        'aria-selected': String(selected),
        'aria-expanded': hasKids ? String(!isCollapsed) : undefined,
        draggable: depth > 0,
        dataset: { path: k },
        style: `padding-left:${4 + depth * 14}px`,
        onclick: () => store.select(path, 'tree'),
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
            if (isCollapsed) collapsed.delete(k);
            else collapsed.add(k);
            renderTree(host);
          },
        },
        hasKids ? svg(uiIcons.chevron) : null,
      ),
      h('span', { class: 'kind-icon', title: el.localName }, svg(kindIcon(el.localName))),
      h('span', { class: 'tree-label' }, name && name !== id ? name : el.localName),
      id ? h('span', { class: 'tree-id' }, id) : null,
      c && c.error > 0 ? h('span', { class: 'badge error', title: `エラー ${c.error}` }, String(c.error)) : null,
      c && c.error === 0 && c.warning > 0 ? h('span', { class: 'badge warning', title: `警告 ${c.warning}` }, String(c.warning)) : null,
    );
    rows.push(row);
    if (hasKids && !isCollapsed) for (const child of Array.from(el.children)) walk(child, depth + 1);
  };
  walk(store.doc.documentElement, 0);
  host.replaceChildren(...rows);
}

function scrollToSelected(host: HTMLElement): void {
  const sel = app.store?.selection;
  if (!sel) return;
  // 選択した要素の祖先が畳まれていたら開く
  let changed = false;
  for (let i = 0; i < sel.length; i++) {
    if (collapsed.delete(key(sel.slice(0, i)))) changed = true;
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
  if (canInside && (y > 0.25 && y < 0.75 || !canSibling)) return 'inside';
  if (canSibling) return y < 0.5 ? 'before' : 'after';
  return null;
}

function onDragOver(e: DragEvent, el: Element, row: HTMLElement): void {
  const zone = zoneOf(e, el, row);
  row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  if (!zone) return;
  e.preventDefault();
  row.classList.add(`drop-${zone}`);
}

function onDrop(e: DragEvent, el: Element, row: HTMLElement): void {
  const zone = zoneOf(e, el, row);
  row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  if (!zone) return;
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
  if (!store) return;
  const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row'));
  const idx = rows.findIndex((r) => r.classList.contains('selected'));
  const pathAt = (i: number) => rows[i]!.dataset['path']!.split('.').filter((s) => s !== '').map(Number);
  if (e.key === 'ArrowDown' && idx < rows.length - 1) {
    store.select(pathAt(idx + 1), 'tree');
  } else if (e.key === 'ArrowUp' && idx > 0) {
    store.select(pathAt(idx - 1), 'tree');
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && store.selection) {
    const k = key(store.selection);
    if (e.key === 'ArrowLeft') {
      if (!collapsed.has(k) && store.selectedElement?.children.length) collapsed.add(k);
      else if (store.selection.length > 0) store.select(store.selection.slice(0, -1), 'tree');
    } else {
      collapsed.delete(k);
    }
    renderTree(host);
  } else {
    return;
  }
  e.preventDefault();
}

/** 選択中の要素が、指定のパスの子孫か（キャンバスでの表示判定に使う）。 */
export function selectionWithin(path: Path): boolean {
  const sel = app.store?.selection;
  return sel !== null && sel !== undefined && (samePath(sel, path) || isAncestorPath(path, sel));
}

export { elementAt };
