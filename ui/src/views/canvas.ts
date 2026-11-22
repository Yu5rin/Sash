// キャンバス（仕様書 §5.2）。本物の Excel に近い見た目でリボンを描き、ドラッグで部品を置く。
// 組み込みタブと組み込みグループはグレーのプレースホルダーで示し、自分で足した部分だけを編集対象にする。

import { app } from '../app';
import { catalog, labels } from '../catalog/catalog';
import { canDropInto, drop, draggedTag, endDrag, startDrag, dragPayload } from '../dnd';
import { h } from '../dom';
import { childElements, elementAt, pathOf, samePath, isAncestorPath, type Path } from '../model';
import { msoIcon, onMsoIconsLoaded } from '../msoIcons';
import { elements } from '../schema';

/** 表示する組み込みタブ（Excel の既定の並び）。 */
const BUILTIN_TABS: readonly [string, string][] = [
  ['TabHome', 'ホーム'],
  ['TabInsert', '挿入'],
  ['TabPageLayoutExcel', 'ページ レイアウト'],
  ['TabFormulas', '数式'],
  ['TabData', 'データ'],
  ['TabReview', '校閲'],
  ['TabView', '表示'],
  ['TabDeveloper', '開発'],
  ['HelpTab', 'ヘルプ'],
];

/** 表示中のタブ。自作タブはパス、組み込みタブは idMso で表す。 */
let activeTab: { kind: 'path'; path: Path } | { kind: 'builtin'; idMso: string } | null = null;

let onImageDrop: ((files: FileList, target: Path) => void) | null = null;

export function mountCanvas(host: HTMLElement, opts: { onImageDrop: (files: FileList, target: Path) => void }): void {
  onImageDrop = opts.onImageDrop;
  const render = () => renderCanvas(host);
  app.on('session', () => {
    activeTab = null;
    render();
  });
  app.on('store', (c) => {
    if (!c) return;
    if (c.kinds.has('selection')) followSelection();
    render();
  });
  app.on('problems', render);
  onMsoIconsLoaded(render);

  host.addEventListener('dragover', (e) => onDragOver(e, host));
  host.addEventListener('dragleave', (e) => {
    if (!host.contains(e.relatedTarget as Node)) hideIndicator(host);
  });
  host.addEventListener('drop', (e) => onDrop(e, host));
  host.addEventListener('click', (e) => {
    if (e.target === host) app.store?.select(null, 'canvas');
  });
}

/** 選択がタブの中に移ったら、そのタブを表示する。 */
function followSelection(): void {
  const store = app.store;
  const sel = store?.selection;
  if (!store || !sel) return;
  let el = elementAt(store.doc, sel);
  while (el && el.localName !== 'tab') el = el.parentElement;
  if (!el) return;
  const idMso = el.getAttribute('idMso');
  activeTab = idMso && isBuiltinTab(idMso) && !el.getAttribute('id') ? { kind: 'builtin', idMso } : { kind: 'path', path: pathOf(el) };
}

function isBuiltinTab(idMso: string): boolean {
  return BUILTIN_TABS.some(([id]) => id === idMso);
}

function builtinTabLabel(idMso: string): string {
  return BUILTIN_TABS.find(([id]) => id === idMso)?.[1] ?? labels.get(idMso) ?? idMso;
}

// ---- 描画 ----

interface TabEntry {
  key: string;
  label: string;
  builtin: boolean;
  /** 自作タブか、組み込みタブに手を加えた tab 要素。 */
  el: Element | null;
  idMso: string | null;
}

function findChild(el: Element | null | undefined, name: string): Element | undefined {
  return el ? childElements(el).find((c) => c.localName === name) : undefined;
}

function collectTabs(doc: Document): TabEntry[] {
  const ribbon = findChild(doc.documentElement, 'ribbon');
  const fromScratch = ribbon?.getAttribute('startFromScratch') === 'true' || ribbon?.getAttribute('startFromScratch') === '1';
  const tabEls = childElements(findChild(ribbon, 'tabs') ?? doc.createElement('x')).filter((t) => t.localName === 'tab');
  const entries: TabEntry[] = fromScratch
    ? []
    : BUILTIN_TABS.map(([idMso, label]) => ({ key: `builtin:${idMso}`, label, builtin: true, el: null, idMso }));

  for (const t of tabEls) {
    const idMso = t.getAttribute('idMso');
    if (idMso) {
      const existing = entries.find((x) => x.idMso === idMso);
      if (existing) {
        existing.el = t;
        continue;
      }
      entries.push({ key: `builtin:${idMso}`, label: builtinTabLabel(idMso), builtin: true, el: t, idMso });
      continue;
    }
    const entry: TabEntry = { key: pathOf(t).join('.'), label: labelOf(t), builtin: false, el: t, idMso: null };
    const after = t.getAttribute('insertAfterMso');
    const before = t.getAttribute('insertBeforeMso');
    const anchor = entries.findIndex((x) => x.idMso === (after ?? before));
    if (anchor >= 0) entries.splice(after ? anchor + 1 : anchor, 0, entry);
    else entries.push(entry);
  }
  return entries;
}

function labelOf(el: Element): string {
  const label = el.getAttribute('label');
  if (label !== null) return label;
  const getLabel = el.getAttribute('getLabel');
  if (getLabel) return `{${getLabel}}`;
  const idMso = el.getAttribute('idMso');
  if (idMso) return labels.get(idMso) ?? idMso;
  return el.getAttribute('id') ?? '';
}

function renderCanvas(host: HTMLElement): void {
  const store = app.store;
  if (!store) {
    host.replaceChildren();
    return;
  }
  const doc = store.doc;
  const tabs = collectTabs(doc);

  // 表示するタブを決める。未選択なら最初の自作タブ、なければホーム
  let active = tabs.find((t) =>
    activeTab?.kind === 'path' ? t.el !== null && samePath(pathOf(t.el), activeTab.path) : activeTab?.kind === 'builtin' && t.idMso === activeTab.idMso,
  );
  active ??= tabs.find((t) => !t.builtin) ?? tabs.find((t) => t.el !== null) ?? tabs[0];

  const errorPaths = new Set(app.problems.filter((p) => p.severity === 'error').map((p) => p.path.join('.')));

  const tabBar = h(
    'div',
    { class: 'rb-tabs', role: 'tablist' },
    h('span', { class: 'rb-tab file' }, 'ファイル'),
    tabs.map((t) =>
      h(
        'span',
        {
          class: ['rb-tab', t.builtin && !t.el ? 'builtin' : '', t === active ? 'active' : '', t.el && isSelected(t.el) ? 'selected' : ''].join(' '),
          role: 'tab',
          'aria-selected': String(t === active),
          dataset: t.el ? { path: pathOf(t.el).join('.') } : {},
          draggable: t.el !== null && !t.builtin,
          title: t.el?.getAttribute('id') ?? t.idMso ?? '',
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            activeTab = t.el && !t.builtin ? { kind: 'path', path: pathOf(t.el) } : { kind: 'builtin', idMso: t.idMso! };
            if (t.el) store.select(pathOf(t.el), 'canvas');
            else renderCanvas(host);
          },
          ondragstart: (e: DragEvent) => t.el && startDrag(e, { kind: 'move', path: pathOf(t.el) }),
          ondragend: () => {
            endDrag();
            hideIndicator(host);
          },
        },
        t.label || '(ラベルなし)',
      ),
    ),
  );

  const body = h('div', { class: 'rb-body' });
  if (active) {
    // 組み込みタブ：組み込みグループのプレースホルダーと、足したグループを並べる
    const groups = active.el ? childElements(active.el).filter((g) => g.localName === 'group') : [];
    if (active.builtin) {
      const builtinGroups = catalog.filter((c) => c.type === 'group' && c.tab === active.idMso).slice(0, 8);
      const placed = new Set<Element>();
      for (const bg of builtinGroups) {
        for (const g of groups) if (g.getAttribute('insertBeforeMso') === bg.id && !placed.has(g)) {
          body.append(renderGroup(g, errorPaths));
          placed.add(g);
        }
        body.append(h('div', { class: 'rb-group builtin' }, h('div', { class: 'rb-controls' }), h('div', { class: 'rb-group-label' }, labels.get(bg.id) ?? bg.id.replace(/^Group/, ''))));
        for (const g of groups) if (g.getAttribute('insertAfterMso') === bg.id && !placed.has(g)) {
          body.append(renderGroup(g, errorPaths));
          placed.add(g);
        }
      }
      for (const g of groups) if (!placed.has(g)) body.append(renderGroup(g, errorPaths));
    } else {
      for (const g of groups) body.append(renderGroup(g, errorPaths));
    }
    if (active.el) body.dataset['path'] = pathOf(active.el).join('.');
    if (groups.length === 0 && !active.builtin) {
      body.append(h('div', { class: 'rb-empty' }, 'パレットから「グループ」をここにドラッグしてください'));
    }
  }

  const qat = renderQat(doc, errorPaths);
  const ctx = renderContextMenus(doc, errorPaths);
  host.replaceChildren(...[qat, tabBar, body, ctx, h('div', { class: 'drop-indicator', hidden: true })].filter((x): x is HTMLElement => x !== null));
}

/** コンテキストメニュー（右クリックメニュー）に足す項目を、メニューの形で並べる。 */
function renderContextMenus(doc: Document, errorPaths: Set<string>): HTMLElement | null {
  if (app.store?.version === 'office2007') return null;
  const cms = findChild(doc.documentElement, 'contextMenus');
  const menus = cms ? childElements(cms).filter((c) => c.localName === 'contextMenu') : [];
  const sel = app.store?.selection ?? null;
  const item = (c: Element, depth: number): HTMLElement[] => {
    const cp = pathOf(c);
    const row = h(
      'div',
      {
        class: `rb-menu-item${samePath(sel, cp) ? ' selected' : ''}${errorPaths.has(cp.join('.')) ? ' has-error' : ''}`,
        style: `padding-left:${8 + depth * 14}px`,
        dataset: { path: cp.join('.') },
        draggable: true,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          app.store?.select(cp, 'canvas');
        },
        ondragstart: (e: DragEvent) => {
          e.stopPropagation();
          startDrag(e, { kind: 'move', path: cp });
        },
        ondragend: () => endDrag(),
      },
      c.localName === 'menuSeparator' ? h('span', { class: 'rb-menu-sep' }, c.getAttribute('title') ?? '') : [c.hasAttribute('image') || c.hasAttribute('imageMso') ? iconFor(c, 'small') : h('span', { class: 'rb-icon-gap' }), h('span', null, labelOf(c) || c.localName), c.localName === 'menu' || c.localName === 'splitButton' || c.localName === 'dynamicMenu' ? h('span', { class: 'rb-submenu' }, '›') : null],
    );
    const kids = c.localName === 'menu' || c.localName === 'splitButton' ? childElements(c).flatMap((k) => item(k, depth + 1)) : [];
    return [row, ...kids];
  };
  const cards = menus.map((m) => {
    const mp = pathOf(m);
    const idMso = m.getAttribute('idMso') ?? '';
    return h(
      'div',
      {
        class: `ctx-card${samePath(sel, mp) ? ' selected' : ''}${errorPaths.has(mp.join('.')) ? ' has-error' : ''}`,
        dataset: { path: mp.join('.') },
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          app.store?.select(mp, 'canvas');
        },
      },
      h('div', { class: 'ctx-title', title: idMso }, labels.get(idMso) ?? idMso),
      h('div', { class: 'ctx-builtin' }, '（組み込みの項目）'),
      h('div', { class: 'ctx-items', dataset: { container: mp.join('.') } }, m.children.length ? childElements(m).flatMap((c) => item(c, 0)) : h('div', { class: 'rb-menu-item muted' }, 'ここに項目をドラッグ')),
    );
  });
  if (!cms && menus.length === 0) {
    return h('section', { class: 'ctx-section empty', dataset: { ctxNew: '1' } }, h('h3', null, 'コンテキストメニュー（右クリック）'), h('div', { class: 'muted' }, 'パレットの「コンテキストメニュー」をここにドラッグすると、右クリックメニューに項目を足せます'));
  }
  return h('section', { class: 'ctx-section', dataset: { container: cms ? pathOf(cms).join('.') : '' } }, h('h3', null, 'コンテキストメニュー（右クリック）'), h('div', { class: 'ctx-cards' }, cards));
}

function isSelected(el: Element): boolean {
  return samePath(app.store?.selection ?? null, pathOf(el));
}

function renderQat(doc: Document, errorPaths: Set<string>): HTMLElement | null {
  const qat = findChild(findChild(doc.documentElement, 'ribbon'), 'qat');
  if (!qat) return null;
  const items = childElements(qat).flatMap((c) => childElements(c));
  return h('div', { class: 'rb-qat', dataset: { path: pathOf(qat).join('.') } }, h('span', { class: 'rb-qat-label' }, 'クイック アクセス'), items.map((c) => renderControl(c, 'small', errorPaths)));
}

function renderGroup(g: Element, errorPaths: Set<string>): HTMLElement {
  const path = pathOf(g);
  const builtinRef = g.hasAttribute('idMso');
  const launcher = childElements(g).find((c) => c.localName === 'dialogBoxLauncher');
  const controls = h('div', { class: 'rb-controls', dataset: { container: path.join('.') } });
  layoutControls(childElements(g).filter((c) => c.localName !== 'dialogBoxLauncher'), controls, errorPaths);

  return h(
    'div',
    {
      class: ['rb-group', builtinRef ? 'builtin-ref' : '', isSelected(g) ? 'selected' : '', errorPaths.has(path.join('.')) ? 'has-error' : ''].join(' '),
      dataset: { path: path.join('.') },
      draggable: true,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        app.store?.select(path, 'canvas');
      },
      ondragstart: (e: DragEvent) => {
        e.stopPropagation();
        startDrag(e, { kind: 'move', path });
      },
      ondragend: () => endDrag(),
    },
    controls,
    h(
      'div',
      { class: 'rb-group-label' },
      h('span', null, labelOf(g)),
      launcher
        ? h('span', {
            class: `rb-launcher${isSelected(launcher) ? ' selected' : ''}`,
            title: 'ダイアログ起動ツール',
            dataset: { path: pathOf(launcher).join('.') },
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              app.store?.select(pathOf(launcher), 'canvas');
            },
          })
        : null,
    ),
  );
}

type Size = 'large' | 'small';

function isLarge(el: Element): boolean {
  if (el.getAttribute('size') === 'large') return true;
  return false;
}

/** large は1列を占め、それ以外は3段ずつ縦に積む（本物のリボンと同じ並べ方）。 */
function layoutControls(items: Element[], host: HTMLElement, errorPaths: Set<string>): void {
  let stack: HTMLElement | null = null;
  for (const c of items) {
    if (c.localName === 'separator') {
      stack = null;
      host.append(renderControl(c, 'small', errorPaths));
      continue;
    }
    if (isLarge(c)) {
      stack = null;
      host.append(renderControl(c, 'large', errorPaths));
      continue;
    }
    if (!stack || stack.children.length >= 3) {
      stack = h('div', { class: 'rb-stack' });
      host.append(stack);
    }
    stack.append(renderControl(c, 'small', errorPaths));
  }
}

function iconFor(el: Element, size: Size): HTMLElement {
  const store = app.store!;
  const px = size === 'large' ? 32 : 16;
  const image = el.getAttribute('image');
  const imageMso = el.getAttribute('imageMso') ?? (el.localName === 'control' ? el.getAttribute('idMso') : null);
  let src: string | null | undefined = null;
  if (image) src = store.images.get(image)?.dataUrl ?? null;
  else if (imageMso) src = msoIcon(imageMso);
  if (src) return h('img', { class: 'rb-icon', src, width: px, height: px, alt: '', draggable: false });
  const cls = el.hasAttribute('getImage') ? 'rb-icon placeholder dynamic' : image || imageMso ? 'rb-icon placeholder' : 'rb-icon placeholder none';
  return h('span', { class: cls, style: `width:${px}px;height:${px}px`, title: imageMso ?? image ?? el.getAttribute('getImage') ?? '' }, imageMso ? imageMso.slice(0, 1) : '');
}

function renderControl(el: Element, size: Size, errorPaths: Set<string>): HTMLElement {
  const path = pathOf(el);
  const tag = el.localName;
  const label = labelOf(el);
  const showLabel = el.getAttribute('showLabel') !== 'false' && !(size === 'small' && el.parentElement?.localName === 'buttonGroup' && !el.hasAttribute('showLabel'));
  const hidden = el.getAttribute('visible') === 'false';
  const disabled = el.getAttribute('enabled') === 'false';
  const cls = ['rb-ctl', `rb-${tag}`, size, isSelected(el) ? 'selected' : '', hidden ? 'hidden-ctl' : '', disabled ? 'disabled' : '', errorPaths.has(path.join('.')) ? 'has-error' : '', el.hasAttribute('idMso') ? 'builtin-ref' : ''].join(' ');
  const common = {
    class: cls,
    dataset: { path: path.join('.') },
    draggable: true,
    title: el.getAttribute('id') ?? el.getAttribute('idMso') ?? tag,
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      app.store?.select(path, 'canvas');
    },
    ondragstart: (e: DragEvent) => {
      e.stopPropagation();
      startDrag(e, { kind: 'move', path });
    },
    ondragend: () => endDrag(),
  };
  const arrow = h('span', { class: 'rb-arrow' });

  switch (tag) {
    case 'separator':
      return h('div', { ...common, class: `${cls} rb-sep` });
    case 'checkBox':
      return h('div', common, h('span', { class: 'rb-check' }), h('span', { class: 'rb-label' }, label));
    case 'labelControl':
      return h('div', common, h('span', { class: 'rb-label' }, label));
    case 'editBox':
    case 'comboBox':
    case 'dropDown':
      return h(
        'div',
        common,
        el.hasAttribute('image') || el.hasAttribute('imageMso') ? iconFor(el, 'small') : null,
        showLabel && label ? h('span', { class: 'rb-label' }, label) : null,
        h('span', { class: 'rb-field' }, tag === 'editBox' ? null : arrow),
        menuPopup(el),
      );
    case 'box': {
      const inner = h('div', { class: `rb-box-inner ${el.getAttribute('boxStyle') === 'vertical' ? 'vertical' : 'horizontal'}`, dataset: { container: path.join('.') } });
      for (const c of childElements(el)) inner.append(renderControl(c, 'small', errorPaths));
      if (el.children.length === 0) inner.append(h('span', { class: 'rb-empty-slot' }, 'box'));
      return h('div', common, inner);
    }
    case 'buttonGroup': {
      const inner = h('div', { class: 'rb-bg-inner', dataset: { container: path.join('.') } });
      for (const c of childElements(el)) inner.append(renderControl(c, 'small', errorPaths));
      if (el.children.length === 0) inner.append(h('span', { class: 'rb-empty-slot' }, 'buttonGroup'));
      return h('div', common, inner);
    }
    case 'splitButton': {
      const main = childElements(el).find((c) => c.localName === 'button' || c.localName === 'toggleButton');
      const mainLabel = main ? labelOf(main) : label;
      return h(
        'div',
        common,
        main ? iconFor(main, size) : iconFor(el, size),
        showLabel ? h('span', { class: 'rb-label' }, mainLabel) : null,
        arrow,
        menuPopup(el),
      );
    }
    default: {
      const hasArrow = tag === 'menu' || tag === 'dynamicMenu' || tag === 'gallery';
      return h(
        'div',
        common,
        el.getAttribute('showImage') === 'false' ? null : iconFor(el, size),
        showLabel && label ? h('span', { class: 'rb-label' }, label) : null,
        hasArrow ? arrow : null,
        hasArrow ? menuPopup(el) : null,
      );
    }
  }
}

/** メニュー類が選択されているときだけ、中身を一覧で開いて選べるようにする。 */
function menuPopup(el: Element): HTMLElement | null {
  const sel = app.store?.selection;
  const path = pathOf(el);
  if (!sel || !(samePath(sel, path) || isAncestorPath(path, sel))) return null;
  const items: HTMLElement[] = [];
  const walk = (parent: Element, depth: number) => {
    for (const c of childElements(parent)) {
      const cp = pathOf(c);
      items.push(
        h(
          'div',
          {
            class: `rb-menu-item${samePath(sel, cp) ? ' selected' : ''}`,
            style: `padding-left:${8 + depth * 12}px`,
            dataset: { path: cp.join('.') },
            draggable: true,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              app.store?.select(cp, 'canvas');
            },
            ondragstart: (e: DragEvent) => {
              e.stopPropagation();
              startDrag(e, { kind: 'move', path: cp });
            },
          },
          c.localName === 'menuSeparator' ? h('span', { class: 'rb-menu-sep' }, c.getAttribute('title') ?? '') : labelOf(c) || c.localName,
        ),
      );
      if (c.localName === 'menu' || c.localName === 'splitButton') walk(c, depth + 1);
    }
  };
  walk(el, 0);
  if (items.length === 0) items.push(h('div', { class: 'rb-menu-item muted' }, el.localName === 'dynamicMenu' ? '中身は getContent で作られます' : '（空）'));
  return h('div', { class: 'rb-menu-popup', dataset: { container: path.join('.') } }, items);
}

// ---- ドラッグ＆ドロップ ----

interface DropSpot {
  parentPath: Path | null | 'contextMenus';
  index: number;
  rect: { left: number; top: number; width: number; height: number };
}

function parsePath(s: string | undefined): Path | null {
  if (s === undefined) return null;
  return s === '' ? [] : s.split('.').map(Number);
}

/** ポインタの位置から、置ける場所を探す。置けなければ null。 */
function findDropSpot(e: DragEvent, host: HTMLElement): DropSpot | null {
  const store = app.store;
  const payload = dragPayload();
  if (!store || !payload) return null;
  const doc = store.doc;
  const target = e.target as HTMLElement;

  // タブを運んでいるときは、タブバーの上だけを受け付ける
  const tabBar = target.closest('.rb-tabs');
  if (tabBar) {
    const tabsEl = findChild(findChild(doc.documentElement, 'ribbon'), 'tabs');
    if (tabsEl ? !canDropInto(doc, tabsEl) : !(payload.kind === 'new' && payload.tag === 'tab')) return null;
    const tabNodes = Array.from(tabBar.querySelectorAll<HTMLElement>('.rb-tab[data-path]'));
    const tabsPath = tabsEl ? pathOf(tabsEl) : null;
    const own = tabNodes.filter((n) => {
      const p = parsePath(n.dataset['path']);
      return p !== null && tabsPath !== null && p.length === tabsPath.length + 1;
    });
    for (const n of own) {
      const r = n.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        return { parentPath: tabsPath, index: parsePath(n.dataset['path'])!.at(-1)!, rect: { left: r.left - 2, top: r.top, width: 2, height: r.height } };
      }
    }
    const last = own.at(-1) ?? tabNodes.at(-1);
    const r = (last ?? tabBar).getBoundingClientRect();
    return { parentPath: tabsPath, index: tabsEl?.children.length ?? 0, rect: { left: r.right + 1, top: r.top, width: 2, height: r.height } };
  }

  // コンテキストメニューの一覧がまだないときは、空の欄へのドロップで作る
  const ctxNew = target.closest<HTMLElement>('[data-ctx-new]');
  if (ctxNew) {
    if (draggedTag(doc) !== 'contextMenu') return null;
    const r = ctxNew.getBoundingClientRect();
    return { parentPath: 'contextMenus', index: 0, rect: { left: r.left + 4, top: r.bottom - 6, width: r.width - 8, height: 2 } };
  }

  // 内側のコンテナから順に、置けるところを探す
  let node: HTMLElement | null = target.closest<HTMLElement>('[data-container], [data-path]');
  while (node && host.contains(node)) {
    const containerPath = parsePath(node.dataset['container']);
    const container = containerPath ? elementAt(doc, containerPath) : null;
    if (container && canDropInto(doc, container)) return spotInContainer(e, node, containerPath!, container);

    const path = parsePath(node.dataset['path']);
    const el = path ? elementAt(doc, path) : null;
    if (el && !node.dataset['container']) {
      // グループ本体やタブ本体（data-path）は、その要素自身がコンテナになりうる
      if (canDropInto(doc, el) && (node.classList.contains('rb-body') || node.classList.contains('rb-group'))) {
        const inner = node.classList.contains('rb-group') ? node.querySelector<HTMLElement>('.rb-controls') ?? node : node;
        return spotInContainer(e, inner, path!, el);
      }
      const parent = el.parentElement;
      if (parent && canDropInto(doc, parent)) {
        const r = node.getBoundingClientRect();
        const idx = Array.prototype.indexOf.call(parent.children, el) as number;
        // メニューの項目は縦に並ぶので、上下で前後を決める
        const vertical = node.classList.contains('rb-menu-item') || node.classList.contains('ctx-card');
        const before = vertical && !node.classList.contains('ctx-card') ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
        return {
          parentPath: pathOf(parent),
          index: before ? idx : idx + 1,
          rect: vertical && !node.classList.contains('ctx-card')
            ? { left: r.left, top: (before ? r.top : r.bottom) - 1, width: r.width, height: 2 }
            : { left: (before ? r.left : r.right) - 1, top: r.top, width: 2, height: r.height },
        };
      }
    }
    node = node.parentElement?.closest<HTMLElement>('[data-container], [data-path]') ?? null;
  }
  return null;
}

function spotInContainer(e: DragEvent, node: HTMLElement, containerPath: Path, container: Element): DropSpot {
  const kids = Array.from(node.querySelectorAll<HTMLElement>('[data-path]')).filter((k) => {
    const p = parsePath(k.dataset['path']);
    return p !== null && p.length === containerPath.length + 1 && containerPath.every((v, i) => v === p[i]);
  });
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    const inList = k.parentElement?.classList.contains('ctx-items') || k.parentElement?.classList.contains('rb-menu-popup');
    const before = inList
      ? e.clientY < r.top + r.height / 2
      : e.clientX < r.left || (e.clientX <= r.right && e.clientY < r.top + r.height / 2 && r.height < 40) || (e.clientX <= r.left + r.width / 2 && r.height >= 40);
    if (before) {
      const idx = parsePath(k.dataset['path'])!.at(-1)!;
      const list = k.parentElement?.classList.contains('ctx-items') || k.parentElement?.classList.contains('rb-menu-popup');
      const stacked = list || (r.height < 40 && k.parentElement?.classList.contains('rb-stack') && k.previousElementSibling !== null);
      return {
        parentPath: containerPath,
        index: idx,
        rect: stacked ? { left: r.left, top: r.top - 1, width: r.width, height: 2 } : { left: r.left - 2, top: r.top, width: 2, height: r.height },
      };
    }
  }
  const last = kids.at(-1);
  const r = (last ?? node).getBoundingClientRect();
  return {
    parentPath: containerPath,
    index: container.children.length,
    rect: last ? { left: r.right + 1, top: r.top, width: 2, height: r.height } : { left: r.left + 4, top: r.top + 4, width: 2, height: Math.max(r.height - 8, 16) },
  };
}

function showIndicator(host: HTMLElement, spot: DropSpot): void {
  const ind = host.querySelector<HTMLElement>('.drop-indicator');
  if (!ind) return;
  const base = host.getBoundingClientRect();
  ind.hidden = false;
  ind.style.left = `${spot.rect.left - base.left + host.scrollLeft}px`;
  ind.style.top = `${spot.rect.top - base.top + host.scrollTop}px`;
  ind.style.width = `${spot.rect.width}px`;
  ind.style.height = `${spot.rect.height}px`;
}

function hideIndicator(host: HTMLElement): void {
  const ind = host.querySelector<HTMLElement>('.drop-indicator');
  if (ind) ind.hidden = true;
}

function imageTarget(e: DragEvent): Path | null {
  const node = (e.target as HTMLElement).closest<HTMLElement>('.rb-ctl[data-path], .rb-group[data-path]');
  const path = parsePath(node?.dataset['path']);
  const el = path && app.store ? elementAt(app.store.doc, path) : null;
  return el && elements.get(el.localName)?.attrs.includes('image') ? path : null;
}

function onDragOver(e: DragEvent, host: HTMLElement): void {
  if (e.dataTransfer?.types.includes('Files')) {
    // 画像ファイルをボタンに直接ドロップすると、アイコンエディタを開く（仕様書 §6.3）
    if (imageTarget(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
    return;
  }
  const spot = findDropSpot(e, host);
  if (!spot) {
    hideIndicator(host);
    return;
  }
  e.preventDefault();
  showIndicator(host, spot);
}

function onDrop(e: DragEvent, host: HTMLElement): void {
  hideIndicator(host);
  if (e.dataTransfer?.files.length) {
    const target = imageTarget(e);
    if (target) {
      e.preventDefault();
      onImageDrop?.(e.dataTransfer.files, target);
    }
    return;
  }
  const spot = findDropSpot(e, host);
  if (!spot) return;
  e.preventDefault();
  drop(spot.parentPath, spot.index, 'canvas');
}
