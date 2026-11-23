// キャンバス（仕様書 §5.2）。本物の Excel（Microsoft 365）に近い見た目でリボンを描き、ドラッグで部品を置く。
// 組み込みタブと組み込みグループはグレーのプレースホルダーで示し、自分で足した部分だけを編集対象にする。
// 表示はリボン・Backstage・コンテキストメニューの3つを切り替える（一度に全部出すと、どれを編集しているか分かりにくいため）。

import '../styles-views.css';
import { app } from '../app';
import { catalog, labels } from '../catalog/catalog';
import { allowedIndex, handleEditKey, moveSelected, runEdit } from '../clipboard';
import { canDropInto, drop, draggedTag, endDrag, startDrag, dragPayload } from '../dnd';
import { h } from '../dom';
import {
  allElements, childElements, createElement, elementAt, ensureContextMenus, ensureTabs, pathOf, samePath, isAncestorPath, type Path,
} from '../model';
import { msoIcon, onMsoIconsLoaded } from '../msoIcons';
import { followBackstageSelection, renderBackstage, resetBackstage } from './backstage';
import { closeMenu, openElementMenu } from './contextMenu';
import { focusField } from './inspector';
import { defFor, inBackstage } from '../schema';
import { lang, t as tr } from '../i18n';

/** 表示する組み込みタブ（Excel の既定の並び）。 */
const BUILTIN_TABS: readonly [string, string, string][] = [
  ['TabHome', 'ホーム', 'Home'],
  ['TabInsert', '挿入', 'Insert'],
  ['TabPageLayoutExcel', 'ページ レイアウト', 'Page Layout'],
  ['TabFormulas', '数式', 'Formulas'],
  ['TabData', 'データ', 'Data'],
  ['TabReview', '校閲', 'Review'],
  ['TabView', '表示', 'View'],
  ['TabDeveloper', '開発', 'Developer'],
  ['HelpTab', 'ヘルプ', 'Help'],
];

/** 組み込みタブの表示名。「表示」は属性の分類名と同じ文言なので、辞書ではなくここで英語にする。 */
function tabName(ja: string, en: string): string {
  return lang === 'en' ? en : ja;
}

export type CanvasMode = 'ribbon' | 'backstage' | 'contextMenu';

let mode: CanvasMode = 'ribbon';

/**
 * 表示中のタブ。自作タブは id（なければパス）で覚える。
 * パスだけで覚えると、前にタブを挿入しただけで別のタブに切り替わってしまうため（不具合 32）。
 */
let activeTab: { kind: 'el'; id: string | null; path: Path } | { kind: 'builtin'; idMso: string } | null = null;

let onImageDrop: ((files: FileList, target: Path) => void) | null = null;
let hostEl: HTMLElement | null = null;
/** 直前の描画にあった要素。編集のあとで選択が新しい要素に移ったら、挿入したものとして目立たせる。 */
let known = new WeakSet<Element>();
let flashPath: Path | null = null;
let scrollToSelection = false;
/** その場でラベルを編集している間は描き直さない（入力中の文字が消えるため）。 */
let renaming = false;
/** 枠の大きさの変化を見張る。mountCanvas が二度呼ばれても前のものを外せるよう、モジュールで持つ。 */
let popupObserver: ResizeObserver | null = null;
let layoutObserver: MutationObserver | null = null;
/** 直前の描画で選んでいた要素。選択が変わったときだけ、ポップアップの中の選択肢を見える位置まで送る。 */
let lastPopupSelection: string | null = null;

export function getCanvasMode(): CanvasMode {
  return mode;
}

/** 表示を切り替える。メニューバーなどが表示を合わせられるよう、sash:canvasmode を投げる。 */
export function setCanvasMode(next: CanvasMode): void {
  if (next !== 'ribbon' && app.store?.version === 'office2007') next = 'ribbon';
  const changed = next !== mode;
  mode = next;
  if (hostEl) renderCanvas(hostEl);
  if (changed) window.dispatchEvent(new CustomEvent('sash:canvasmode', { detail: { mode } }));
}

/** キャンバスにフォーカスを移す（Ctrl+1 / F6）。 */
export function focus(): void {
  hostEl?.focus({ preventScroll: true });
  revealNode(hostEl && app.store?.selection ? nodeOf(hostEl, app.store.selection) : null);
}

/** 要素を見える位置に出す。ポップアップの中の項目は、ポップアップの中だけを送る。 */
function revealNode(node: HTMLElement | null | undefined): void {
  if (!node) return;
  const popup = node.closest<HTMLElement>('.rb-menu-popup');
  if (popup) revealInPopup(popup, node);
  else node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function mountCanvas(host: HTMLElement, opts: { onImageDrop: (files: FileList, target: Path) => void }): void {
  onImageDrop = opts.onImageDrop;
  hostEl = host;
  // tabindex がないと Ctrl+1 で focus() しても移らない（不具合 23）
  host.tabIndex = 0;
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', tr('キャンバス'));
  const render = () => renderCanvas(host);
  // スクロールや大きさの変更でメニューの開き口が動いたら、ポップアップも付いていかせる。
  // スクロールするのはキャンバスの枠（.canvas-pane）なので、host ではなくその枠で捕まえる。
  // ポップアップ自身のスクロールは無視する（置き直すと高さを測り直す間に scrollTop が 0 に戻り、長いメニューを下まで送れないため）
  const pane = paneOf(host);
  pane.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.closest('.rb-menu-popup')) return;
    placePopups(host);
  }, true);
  window.addEventListener('resize', () => placePopups(host));
  // スプリッターのドラッグや隣の枠を畳んだときは window の resize が来ないので、枠の大きさの変化を見張る。
  // 左の枠を広げてもキャンバスの幅が変わらない（位置だけずれる）ことがあるので、大きさだけでなく、
  // レイアウトの変数（--left など）とクラス（collapsed-*）を書き換える #app の属性の変化も見張る
  popupObserver?.disconnect();
  layoutObserver?.disconnect();
  let queued = false;
  const queuePlace = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      placePopups(host);
    });
  };
  if (typeof ResizeObserver !== 'undefined') {
    popupObserver = new ResizeObserver(queuePlace);
    popupObserver.observe(pane);
    if (pane !== host) popupObserver.observe(host);
  }
  const layoutRoot = host.closest<HTMLElement>('#app');
  if (layoutRoot && typeof MutationObserver !== 'undefined') {
    layoutObserver = new MutationObserver(queuePlace);
    layoutObserver.observe(layoutRoot, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  app.on('session', () => {
    activeTab = null;
    resetBackstage();
    known = new WeakSet();
    if (mode !== 'ribbon') setCanvasMode('ribbon');
    render();
  });
  app.on('store', (c) => {
    const store = app.store;
    if (!c || !store) return;
    if (c.kinds.has('selection')) {
      followSelection(c.source === 'canvas');
      if (c.source !== 'canvas') scrollToSelection = true;
    }
    // 挿入（貼り付け・複製・ドロップを含む）の直後は、新しい要素を目立たせる（A3）
    if (c.kinds.has('doc') && c.source !== 'xml' && c.source !== 'history') {
      const sel = store.selectedElement;
      if (sel && !known.has(sel)) {
        flashPath = store.selection;
        scrollToSelection = true;
      }
    }
    render();
  });
  app.on('problems', render);
  onMsoIconsLoaded(render);

  host.addEventListener('dragover', (e) => onDragOver(e, host));
  host.addEventListener('dragleave', (e) => {
    if (!host.contains(e.relatedTarget as Node)) hideIndicator(host);
  });
  host.addEventListener('drop', (e) => onDrop(e, host));
  // ドラッグを Esc で取り消したときやキャンバスの外に落としたときも、表示と状態を残さない（不具合 33）
  window.addEventListener('dragend', () => {
    hideIndicator(host);
    endDrag();
  }, true);
  host.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === host || target.classList.contains('rb-body') || target.classList.contains('cv-stage')) app.store?.select(null, 'canvas');
  });
  host.addEventListener('keydown', (e) => onKey(e, host));
  host.addEventListener('contextmenu', (e) => {
    const node = (e.target as HTMLElement).closest<HTMLElement>('[data-sel]');
    const path = parsePath(node?.dataset['path']);
    if (!path || !app.store) return;
    e.preventDefault();
    app.store.select(path, 'canvas');
    openElementMenu(e.clientX, e.clientY, path, 'canvas', host);
  });
}

/** 選択がタブ（または Backstage・コンテキストメニュー）の中に移ったら、そこを表示する。 */
function followSelection(fromCanvas: boolean): void {
  const store = app.store;
  const sel = store?.selection;
  if (!store || !sel) return;
  if (followBackstageSelection(store.doc, sel)) {
    if (mode !== 'backstage') setModeQuiet('backstage');
    return;
  }
  let el = elementAt(store.doc, sel);
  for (let cur = el; cur; cur = cur.parentElement) {
    if (cur.localName === 'contextMenus') {
      if (mode !== 'contextMenu') setModeQuiet('contextMenu');
      return;
    }
  }
  while (el && el.localName !== 'tab') el = el.parentElement;
  if (!el) {
    if (!fromCanvas && mode !== 'ribbon' && sel.length > 0) setModeQuiet('ribbon');
    return;
  }
  if (mode !== 'ribbon') setModeQuiet('ribbon');
  const idMso = el.getAttribute('idMso');
  activeTab = idMso && isBuiltinTab(idMso) && !el.getAttribute('id') ? { kind: 'builtin', idMso } : { kind: 'el', id: el.getAttribute('id'), path: pathOf(el) };
}

/** 描き直しは呼び出し元に任せて、表示だけを切り替える。 */
function setModeQuiet(next: CanvasMode): void {
  mode = next;
  window.dispatchEvent(new CustomEvent('sash:canvasmode', { detail: { mode } }));
}

function isBuiltinTab(idMso: string): boolean {
  return BUILTIN_TABS.some(([id]) => id === idMso);
}

function builtinTabLabel(idMso: string): string {
  const builtin = BUILTIN_TABS.find(([id]) => id === idMso);
  return builtin ? tabName(builtin[1], builtin[2]) : labels.get(idMso) ?? idMso;
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
  const tabsEl = findChild(ribbon, 'tabs');
  const tabEls = tabsEl ? childElements(tabsEl).filter((x) => x.localName === 'tab') : [];
  const entries: TabEntry[] = fromScratch
    ? []
    : BUILTIN_TABS.map(([idMso, ja, en]) => ({ key: `builtin:${idMso}`, label: tabName(ja, en), builtin: true, el: null, idMso }));

  for (const x of tabEls) {
    const idMso = x.getAttribute('idMso');
    if (idMso) {
      const existing = entries.find((e) => e.idMso === idMso);
      if (existing) {
        existing.el = x;
        continue;
      }
      entries.push({ key: `builtin:${idMso}`, label: builtinTabLabel(idMso), builtin: true, el: x, idMso });
      continue;
    }
    const entry: TabEntry = { key: pathOf(x).join('.'), label: labelOf(x), builtin: false, el: x, idMso: null };
    const after = x.getAttribute('insertAfterMso');
    const before = x.getAttribute('insertBeforeMso');
    const anchor = entries.findIndex((e) => e.idMso === (after ?? before));
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

function isSelected(el: Element): boolean {
  return samePath(app.store?.selection ?? null, pathOf(el));
}

/** 表示中のタブを決める。未選択なら最初の自作タブ、なければホーム。 */
function resolveActive(tabs: TabEntry[]): TabEntry | undefined {
  let active: TabEntry | undefined;
  const at = activeTab;
  if (at?.kind === 'el') {
    active = tabs.find((x) => x.el !== null && !x.builtin && (at.id !== null ? x.el.getAttribute('id') === at.id : samePath(pathOf(x.el), at.path)));
    // id を変えたときなどは、パスで探し直す
    active ??= tabs.find((x) => x.el !== null && samePath(pathOf(x.el), at.path));
  } else if (at?.kind === 'builtin') {
    active = tabs.find((x) => x.idMso === at.idMso);
  }
  return active ?? tabs.find((x) => !x.builtin) ?? tabs.find((x) => x.el !== null) ?? tabs[0];
}

function renderHeader(): HTMLElement {
  const v2007 = app.store?.version === 'office2007';
  const seg = (m: CanvasMode, label: string) =>
    h('button', {
      type: 'button',
      class: mode === m ? 'active' : '',
      'aria-pressed': String(mode === m),
      disabled: m !== 'ribbon' && v2007,
      title: m !== 'ribbon' && v2007 ? tr('customUI14（2010以降）の形式でのみ使えます') : '',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        setCanvasMode(m);
      },
    }, label);
  return h(
    'div',
    { class: 'cv-header' },
    h('div', { class: 'segmented cv-modes', role: 'group', 'aria-label': tr('キャンバスの表示') }, seg('ribbon', tr('リボン')), seg('backstage', 'Backstage'), seg('contextMenu', tr('コンテキストメニュー'))),
    h('span', { class: 'cv-hint' }, tr('矢印キーで移動・Enter で編集・右クリックでメニュー')),
  );
}

function renderCanvas(host: HTMLElement): void {
  if (renaming) return;
  const store = app.store;
  if (!store) {
    host.replaceChildren();
    return;
  }
  const doc = store.doc;
  const errorPaths = new Set(app.problems.filter((p) => p.severity === 'error').map((p) => p.path.join('.')));
  let stage: HTMLElement;
  if (mode === 'backstage') {
    stage = h('div', { class: 'cv-stage' }, renderBackstage(doc, errorPaths));
  } else if (mode === 'contextMenu') {
    stage = h('div', { class: 'cv-stage' }, renderContextMenus(doc, errorPaths));
  } else {
    stage = h('div', { class: 'cv-stage' }, renderRibbon(host, doc, errorPaths));
  }
  // 描き直すとポップアップも作り直されるので、開いていたメニューごとのスクロール位置を覚えておいて戻す
  const popupScroll = new Map<string, number>();
  for (const popup of Array.from(host.querySelectorAll<HTMLElement>('.rb-menu-popup'))) {
    popupScroll.set(popup.dataset['container'] ?? '', popup.scrollTop);
  }
  host.replaceChildren(renderHeader(), stage, h('div', { class: 'drop-indicator', hidden: true }));

  placePopups(host);
  const selKey = store.selection ? store.selection.join('.') : null;
  for (const popup of Array.from(host.querySelectorAll<HTMLElement>('.rb-menu-popup'))) {
    const saved = popupScroll.get(popup.dataset['container'] ?? '');
    if (saved !== undefined) popup.scrollTop = saved;
    // 新しく開いたときと選択が変わったときだけ、選ばれた項目を見える位置へ送る。
    // 毎回送ると、別の理由（問題一覧の更新など）で描き直すたびに、利用者が送った位置から引き戻してしまう
    if (saved === undefined || selKey !== lastPopupSelection) {
      const item = popup.querySelector<HTMLElement>('.rb-menu-item.selected');
      if (item) revealInPopup(popup, item);
    }
  }
  lastPopupSelection = selKey;
  known = new WeakSet(allElements(doc));
  const sel = store.selection;
  if (sel && (flashPath || scrollToSelection)) {
    const node = nodeOf(host, sel);
    if (node) {
      revealNode(node);
      if (flashPath && samePath(flashPath, sel)) {
        node.classList.add('flash');
        window.setTimeout(() => node.classList.remove('flash'), 900);
      }
    }
  }
  flashPath = null;
  scrollToSelection = false;
}

function renderRibbon(host: HTMLElement, doc: Document, errorPaths: Set<string>): HTMLElement {
  const store = app.store!;
  const tabs = collectTabs(doc);
  const active = resolveActive(tabs);
  const hasCustom = tabs.some((x) => !x.builtin);

  const tabBar = h(
    'div',
    { class: 'rb-tabs', role: 'tablist' },
    h('span', {
      class: 'rb-tab file',
      role: 'tab',
      title: tr('Backstage（ファイル タブ）を表示'),
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        if (store.version !== 'office2007') setCanvasMode('backstage');
      },
    }, tr('ファイル')),
    tabs.map((x) =>
      h(
        'span',
        {
          class: ['rb-tab', x.builtin && !x.el ? 'builtin' : '', x === active ? 'active' : '', x.el && isSelected(x.el) ? 'selected' : ''].join(' '),
          role: 'tab',
          'aria-selected': String(x === active),
          dataset: x.el ? { path: pathOf(x.el).join('.'), sel: '1' } : {},
          draggable: x.el !== null && !x.builtin,
          title: x.el?.getAttribute('id') ?? x.idMso ?? '',
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            activeTab = x.el && !x.builtin ? { kind: 'el', id: x.el.getAttribute('id'), path: pathOf(x.el) } : { kind: 'builtin', idMso: x.idMso! };
            if (x.el) store.select(pathOf(x.el), 'canvas');
            else renderCanvas(host);
          },
          ondragstart: (e: DragEvent) => x.el && startDrag(e, { kind: 'move', path: pathOf(x.el) }),
          ondragend: () => {
            endDrag();
            hideIndicator(host);
          },
        },
        h('span', { class: 'rb-label' }, x.label || tr('(ラベルなし)')),
      ),
    ),
    h('button', {
      type: 'button',
      class: `rb-tab-add${hasCustom ? '' : ' empty'}`,
      title: tr('新しいタブを追加'),
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        addTab();
      },
    }, hasCustom ? '+' : tr('＋ ここにタブを追加')),
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
        body.append(h('div', { class: 'rb-group builtin', title: tr('組み込みのグループ（編集できません）') }, h('div', { class: 'rb-controls' }), h('div', { class: 'rb-group-label' }, h('span', null, labels.get(bg.id) ?? bg.id.replace(/^Group/, '')))));
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
    if (groups.length === 0 && !active.builtin && active.el) {
      const tabPath = pathOf(active.el);
      body.append(
        h('div', { class: 'cv-empty' },
          h('span', null, tr('ここにグループを追加')),
          h('button', { type: 'button', class: 'small', onclick: (e: MouseEvent) => { e.stopPropagation(); addChild(tabPath, 'group'); } }, tr('グループを追加'))),
      );
    }
  }
  if (!hasCustom) {
    body.append(h('div', { class: 'cv-empty floating' }, h('span', null, tr('まだ自分のタブがありません。タブを追加するか、組み込みタブにグループを足してください'))));
  }

  const qat = renderQat(doc, errorPaths);
  return h('div', { class: 'rb-window' }, qat, tabBar, body);
}

/** 新しいタブを作って選択する。 */
function addTab(): void {
  runEdit('canvas', (doc) => {
    const tabs = ensureTabs(doc);
    const el = createElement(doc, 'tab', tabs);
    tabs.insertBefore(el, tabs.children[allowedIndex(tabs, 'tab', tabs.children.length) ?? tabs.children.length] ?? null);
    return pathOf(el);
  }, tr('タブを追加'));
}

function addChild(parentPath: Path, tag: string): void {
  runEdit('canvas', (doc) => {
    const parent = elementAt(doc, parentPath);
    if (!parent) return undefined;
    const at = allowedIndex(parent, tag, parent.children.length);
    if (at === null) return undefined;
    const el = createElement(doc, tag, parent);
    parent.insertBefore(el, parent.children[at] ?? null);
    return pathOf(el);
  }, tr('<{tag}> を追加', { tag }));
}

/** コンテキストメニュー（右クリックメニュー）に足す項目を、メニューの形で並べる。 */
function renderContextMenus(doc: Document, errorPaths: Set<string>): HTMLElement {
  if (app.store?.version === 'office2007') return h('div', { class: 'cv-empty' }, tr('コンテキストメニューは customUI14（2010以降）の形式でのみ編集できます'));
  const cms = findChild(doc.documentElement, 'contextMenus');
  const menus = cms ? childElements(cms).filter((c) => c.localName === 'contextMenu') : [];
  const sel = app.store?.selection ?? null;
  const item = (c: Element, depth: number): HTMLElement[] => {
    const cp = pathOf(c);
    const row = h(
      'div',
      {
        class: `rb-menu-item${samePath(sel, cp) ? ' selected' : ''}${errorPaths.has(cp.join('.')) ? ' has-error' : ''}${c.getAttribute('visible') === 'false' ? ' hidden-ctl' : ''}`,
        style: `padding-left:${8 + depth * 14}px`,
        dataset: { path: cp.join('.'), sel: '1' },
        draggable: true,
        title: c.getAttribute('id') ?? c.getAttribute('idMso') ?? c.localName,
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
      c.localName === 'menuSeparator' ? h('span', { class: 'rb-menu-sep' }, c.getAttribute('title') ?? '') : [c.hasAttribute('image') || c.hasAttribute('imageMso') ? iconFor(c, 'small') : h('span', { class: 'rb-icon-gap' }), h('span', { class: 'rb-label' }, labelOf(c) || c.localName), c.localName === 'menu' || c.localName === 'splitButton' || c.localName === 'dynamicMenu' ? h('span', { class: 'rb-submenu' }, '›') : null],
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
        dataset: { path: mp.join('.'), sel: '1' },
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          app.store?.select(mp, 'canvas');
        },
      },
      h('div', { class: 'ctx-title', title: idMso }, labels.get(idMso) ?? idMso),
      h('div', { class: 'ctx-builtin' }, tr('（組み込みの項目）')),
      h('div', { class: 'ctx-items', dataset: { container: mp.join('.') } }, m.children.length ? childElements(m).flatMap((c) => item(c, 0)) : h('div', { class: 'rb-menu-item muted' }, tr('ここに項目をドラッグ'))),
    );
  });
  const addButton = h('button', { type: 'button', class: 'small', onclick: (e: MouseEvent) => { e.stopPropagation(); addContextMenu(); } }, tr('コンテキストメニューを追加'));
  if (menus.length === 0) {
    return h('section', { class: 'ctx-section empty', dataset: { ctxNew: '1' } },
      h('h3', null, tr('コンテキストメニュー（右クリック）')),
      h('p', { class: 'muted' }, tr('パレットの「コンテキストメニュー」をここにドラッグすると、右クリックメニューに項目を足せます')),
      addButton);
  }
  return h('section', { class: 'ctx-section', dataset: { container: cms ? pathOf(cms).join('.') : '' } }, h('h3', null, tr('コンテキストメニュー（右クリック）'), addButton), h('div', { class: 'ctx-cards' }, cards));
}

function addContextMenu(): void {
  runEdit('canvas', (doc) => {
    const cms = ensureContextMenus(doc);
    const el = createElement(doc, 'contextMenu', cms);
    cms.append(el);
    return pathOf(el);
  }, tr('コンテキストメニューを追加'));
}

function renderQat(doc: Document, errorPaths: Set<string>): HTMLElement | null {
  const qat = findChild(findChild(doc.documentElement, 'ribbon'), 'qat');
  if (!qat) return null;
  const items = childElements(qat).flatMap((c) => childElements(c));
  return h('div', { class: 'rb-qat', dataset: { path: pathOf(qat).join('.'), sel: '1' }, onclick: (e: MouseEvent) => { e.stopPropagation(); app.store?.select(pathOf(qat), 'canvas'); } }, h('span', { class: 'rb-qat-label' }, tr('クイック アクセス')), items.map((c) => renderControl(c, 'small', errorPaths)));
}

function renderGroup(g: Element, errorPaths: Set<string>): HTMLElement {
  const path = pathOf(g);
  const builtinRef = g.hasAttribute('idMso');
  const launcher = childElements(g).find((c) => c.localName === 'dialogBoxLauncher');
  const controls = h('div', { class: 'rb-controls', dataset: { container: path.join('.') } });
  const items = childElements(g).filter((c) => c.localName !== 'dialogBoxLauncher');
  layoutControls(items, controls, errorPaths);
  if (items.length === 0 && !builtinRef) controls.append(h('span', { class: 'rb-empty-slot group' }, tr('ここにコントロールをドラッグ')));

  return h(
    'div',
    {
      class: ['rb-group', builtinRef ? 'builtin-ref' : '', isSelected(g) ? 'selected' : '', errorPaths.has(path.join('.')) ? 'has-error' : '', g.getAttribute('visible') === 'false' ? 'hidden-ctl' : ''].join(' '),
      dataset: { path: path.join('.'), sel: '1' },
      draggable: true,
      title: g.getAttribute('id') ?? g.getAttribute('idMso') ?? 'group',
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
      h('span', { class: 'rb-label' }, labelOf(g)),
      launcher
        ? h('span', {
            class: `rb-launcher${isSelected(launcher) ? ' selected' : ''}`,
            title: tr('ダイアログ起動ツール'),
            dataset: { path: pathOf(launcher).join('.'), sel: '1' },
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
  return el.getAttribute('size') === 'large';
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
    dataset: { path: path.join('.'), sel: '1' },
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
  const arrow = () => h('span', { class: 'rb-arrow', 'aria-hidden': 'true' });
  const labelEl = (text: string) => h('span', { class: 'rb-label' }, text);

  switch (tag) {
    case 'separator':
      return h('div', { ...common, class: `${cls} rb-sep` });
    case 'checkBox':
      return h('div', common, h('span', { class: 'rb-check' }), labelEl(label));
    case 'labelControl':
      return h('div', common, labelEl(label));
    case 'editBox':
    case 'comboBox':
    case 'dropDown':
      return h(
        'div',
        common,
        el.hasAttribute('image') || el.hasAttribute('imageMso') ? iconFor(el, 'small') : null,
        showLabel && label ? labelEl(label) : null,
        h('span', { class: 'rb-field' }, tag === 'editBox' ? null : h('span', { class: 'rb-field-drop' }, arrow())),
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
      // 分割ボタンは「押す部分」と「メニューを開く部分」を線で分ける（本物と同じ見た目）
      const main = childElements(el).find((c) => c.localName === 'button' || c.localName === 'toggleButton');
      const mainLabel = main ? labelOf(main) : label;
      const icon = el.getAttribute('showImage') === 'false' ? null : main ? iconFor(main, size) : iconFor(el, size);
      return size === 'large'
        ? h('div', common, h('span', { class: 'rb-split-main' }, icon), h('span', { class: 'rb-split-drop' }, showLabel ? labelEl(mainLabel) : null, arrow()), menuPopup(el))
        : h('div', common, h('span', { class: 'rb-split-main' }, icon, showLabel ? labelEl(mainLabel) : null), h('span', { class: 'rb-split-drop' }, arrow()), menuPopup(el));
    }
    default: {
      const hasArrow = tag === 'menu' || tag === 'dynamicMenu' || tag === 'gallery';
      return h(
        'div',
        common,
        el.getAttribute('showImage') === 'false' ? null : iconFor(el, size),
        showLabel && label ? labelEl(label) : null,
        hasArrow ? arrow() : null,
        hasArrow ? menuPopup(el) : null,
      );
    }
  }
}

/** キャンバスのスクロールする枠。見える範囲の基準にもする。 */
function paneOf(host: HTMLElement): HTMLElement {
  return host.closest<HTMLElement>('.canvas-pane') ?? host;
}

/**
 * メニューのポップアップを、開き口のすぐ下に画面基準（fixed）で置く。
 * リボン本体は横スクロールのために overflow-x:auto にしており、CSS の決まりで縦も auto 扱いになる。
 * そのまま absolute で置くと本体の中に閉じ込められて選択肢が隠れるため、本体の枠の外に出す。
 * ただし置ける範囲はキャンバスの枠の中に限る。XML エディタで <menu> の中にカーソルがあると
 * 選択が同期してポップアップが開くので、枠の外まで伸ばすと、いま打っている XML を覆ってしまうため。
 * 入りきらない分はポップアップの中でスクロールさせる。
 */
function placePopups(host: HTMLElement): void {
  const margin = 4;
  const popups = Array.from(host.querySelectorAll<HTMLElement>('.rb-menu-popup'));
  if (popups.length === 0) return;
  const pr = paneOf(host).getBoundingClientRect();
  const viewTop = Math.max(0, pr.top);
  const viewBottom = Math.min(window.innerHeight, pr.bottom);
  const viewLeft = Math.max(0, pr.left);
  const viewRight = Math.min(window.innerWidth, pr.right);
  for (const popup of popups) {
    const anchor = popup.parentElement;
    if (!anchor) continue;
    const r = anchor.getBoundingClientRect();
    popup.style.position = 'fixed';
    // 開き口が枠の外へスクロールしたら、ポップアップだけが宙に浮いて残らないよう隠す
    const anchorVisible = r.bottom > viewTop && r.top < viewBottom && r.right > viewLeft && r.left < viewRight;
    // 高さは maxHeight を外して測らない。外すと中身が一瞬縮んで scrollTop が 0 に戻るため、
    // 中身の高さ（scrollHeight）と枠線の分から本来の高さを出す
    const scrollTop = popup.scrollTop;
    const ph = popup.scrollHeight + (popup.offsetHeight - popup.clientHeight);
    const w = popup.offsetWidth;
    const below = viewBottom - r.bottom - margin;
    const above = r.top - viewTop - margin;
    // 下に入りきらず、上のほうが広ければ上に開く（Excel と同じ振る舞い）。どちらも枠の中で
    let top: number;
    let room: number;
    if (ph <= below || below >= above) {
      top = r.bottom;
      room = below;
    } else {
      room = above;
      top = r.top - Math.min(ph, above);
    }
    popup.style.maxHeight = ph > room ? `${Math.max(0, Math.floor(room))}px` : '';
    popup.style.visibility = anchorVisible && room >= 24 ? '' : 'hidden';
    const left = Math.max(viewLeft + margin, Math.min(r.left, viewRight - w - margin));
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
    // 高さを詰めると scrollTop が切り詰められることがあるので、測る前の位置に戻す
    popup.scrollTop = scrollTop;
  }
}

/**
 * ポップアップの中だけをスクロールして、項目を見える位置に出す。
 * scrollIntoView はキャンバスの枠まで一緒にスクロールさせ、リボンがずれてしまうため使わない。
 */
function revealInPopup(popup: HTMLElement, item: HTMLElement): void {
  const pr = popup.getBoundingClientRect();
  const ir = item.getBoundingClientRect();
  const top = pr.top + popup.clientTop;
  const bottom = top + popup.clientHeight;
  if (ir.top < top) popup.scrollTop -= top - ir.top;
  else if (ir.bottom > bottom) popup.scrollTop += Math.min(ir.bottom - bottom, ir.top - top);
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
            dataset: { path: cp.join('.'), sel: '1' },
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
          c.localName === 'menuSeparator' ? h('span', { class: 'rb-menu-sep' }, c.getAttribute('title') ?? '') : h('span', { class: 'rb-label' }, labelOf(c) || c.localName),
        ),
      );
      if (c.localName === 'menu' || c.localName === 'splitButton') walk(c, depth + 1);
    }
  };
  walk(el, 0);
  if (items.length === 0) items.push(h('div', { class: 'rb-menu-item muted' }, el.localName === 'dynamicMenu' ? tr('中身は getContent で作られます') : tr('（空）')));
  return h('div', { class: 'rb-menu-popup', dataset: { container: path.join('.') } }, items);
}

// ---- キーボード操作（A1） ----

function parsePath(s: string | undefined): Path | null {
  if (s === undefined) return null;
  return s === '' ? [] : s.split('.').map(Number);
}

/** 要素を表す（選択できる）ノード。 */
function nodeOf(host: HTMLElement, path: Path): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-sel][data-path="${path.join('.')}"]`);
}

function selectableNodes(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-sel][data-path]'));
}

/** 同じ親を持つノードの中から、方向に一番近いものを選ぶ。 */
function nearest(from: HTMLElement, candidates: HTMLElement[], dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === from) continue;
    const b = c.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const ok = dir === 'left' ? dx < -2 : dir === 'right' ? dx > 2 : dir === 'up' ? dy < -2 : dy > 2;
    if (!ok) continue;
    // 進む方向の距離を優先し、横（縦）のずれは重く数える
    const main = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
    const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = main + cross * 3;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function siblingsOf(host: HTMLElement, path: Path): HTMLElement[] {
  const parent = path.slice(0, -1).join('.');
  return selectableNodes(host).filter((n) => {
    const p = parsePath(n.dataset['path']);
    return p !== null && p.length === path.length && p.slice(0, -1).join('.') === parent;
  });
}

function childrenOf(host: HTMLElement, path: Path): HTMLElement[] {
  return selectableNodes(host).filter((n) => {
    const p = parsePath(n.dataset['path']);
    return p !== null && p.length === path.length + 1 && isAncestorPath(path, p);
  });
}

function selectNode(n: HTMLElement | null | undefined): boolean {
  const p = parsePath(n?.dataset['path']);
  if (!p || !app.store) return false;
  app.store.select(p, 'canvas');
  revealNode(nodeOf(hostEl!, p));
  return true;
}

function onKey(e: KeyboardEvent, host: HTMLElement): void {
  if (e.isComposing || renaming) return;
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea, button')) {
    // ヘッダーの切り替えボタンなど、キャンバスの中のボタンでは既定の動作に任せる
    if (target.tagName !== 'BUTTON' || e.key === 'Enter' || e.key === ' ') return;
  }
  if (handleEditKey(e, 'canvas')) return;
  const store = app.store;
  if (!store) return;
  const sel = store.selection;
  const cur = sel ? nodeOf(host, sel) : null;
  const key = e.key;

  if (!cur || !sel) {
    // 何も選んでいなければ、矢印キーで最初の要素を選ぶ
    if (key.startsWith('Arrow') || key === 'Home' || key === 'End') {
      e.preventDefault();
      const all = selectableNodes(host);
      selectNode(key === 'End' ? all.at(-1) : all[0]);
    }
    return;
  }

  if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    e.preventDefault();
    moveSelected(key === 'ArrowUp' ? -1 : 1, 'canvas');
    return;
  }

  const dirs: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const dir = dirs[key];
  if (dir) {
    e.preventDefault();
    const sibs = siblingsOf(host, sel);
    const next = nearest(cur, sibs, dir);
    if (next) {
      selectNode(next);
      return;
    }
    if (dir === 'down') {
      // 下に兄弟がなければ、中身（グループならコントロール、メニューなら項目）に入る
      const kids = childrenOf(host, sel);
      if (selectNode(nearest(cur, kids, 'down') ?? kids[0])) return;
    }
    if (dir === 'up' && sel.length > 0) {
      // 上に兄弟がなければ、親（コントロールならグループ、グループならタブ）に上がる
      if (selectNode(nodeOf(host, sel.slice(0, -1)))) return;
    }
    if ((dir === 'left' || dir === 'right') && sel.length > 1) {
      // 端まで来たら、隣のグループに移る
      const parent = nodeOf(host, sel.slice(0, -1));
      if (parent) {
        const pn = nearest(parent, siblingsOf(host, sel.slice(0, -1)), dir);
        const pp = parsePath(pn?.dataset['path']);
        if (pn && pp) {
          const kids = childrenOf(host, pp);
          selectNode((dir === 'right' ? kids[0] : kids.at(-1)) ?? pn);
        }
      }
    }
    return;
  }
  if (key === 'Home' || key === 'End') {
    e.preventDefault();
    const sibs = siblingsOf(host, sel);
    selectNode(key === 'Home' ? sibs[0] : sibs.at(-1));
  } else if (key === 'Escape') {
    closeMenu();
    if (sel.length > 0 && nodeOf(host, sel.slice(0, -1))) {
      e.preventDefault();
      store.select(sel.slice(0, -1), 'canvas');
    }
  } else if (key === 'Enter') {
    e.preventDefault();
    focusField('label');
  } else if (key === 'F2') {
    e.preventDefault();
    if (!startRename(host, sel)) focusField('label');
  } else if (key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    const r = cur.getBoundingClientRect();
    openElementMenu(r.left + Math.min(16, r.width / 2), r.bottom, sel, 'canvas', host);
  }
}

/** F2：ラベルをその場で書き換える。ラベルを持てない要素や、VBA で返すラベルなら false。 */
function startRename(host: HTMLElement, path: Path): boolean {
  const store = app.store;
  const el = store ? elementAt(store.doc, path) : null;
  const node = nodeOf(host, path);
  if (!store || !el || !node || el.hasAttribute('getLabel') || !defFor(el)?.attrs.includes('label')) return false;
  const labelNode = node.querySelector<HTMLElement>(':scope > .rb-label, :scope > .rb-group-label > .rb-label, :scope > .rb-split-main > .rb-label, :scope > .rb-split-drop > .rb-label, :scope > span:not([class])') ?? (inBackstage(el) ? node : null);
  if (!labelNode) return false;
  const original = el.getAttribute('label') ?? '';
  const input = h('input', { type: 'text', class: 'cv-rename', value: original, spellcheck: false, 'aria-label': tr('ラベル') });
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    renaming = false;
    const v = input.value;
    if (commit && v !== original) {
      runEdit('canvas', (doc) => {
        const target = elementAt(doc, path);
        if (!target) return undefined;
        if (v === '') target.removeAttribute('label');
        else target.setAttribute('label', v);
        return undefined;
      }, tr('ラベルを「{name}」に変更', { name: v }));
    }
    renderCanvas(host);
    host.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    // 日本語入力の変換確定の Enter で確定しない（不具合 39）
    if (e.isComposing || e.keyCode === 229) return;
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  renaming = true;
  labelNode.replaceChildren(input);
  node.draggable = false;
  input.focus();
  input.select();
  return true;
}

// ---- ドラッグ＆ドロップ ----

interface DropSpot {
  parentPath: Path | null | 'contextMenus' | 'backstage';
  index: number;
  rect: { left: number; top: number; width: number; height: number };
  /** 置き先として強調するノード。 */
  container: HTMLElement | null;
}

/** 運んでいる要素（移動のとき）。 */
function movingElement(doc: Document): Element | null {
  const p = dragPayload();
  return p?.kind === 'move' ? elementAt(doc, p.path) : null;
}

/** 並び順の決まりに合わない位置なら null にする（A16：置けない場所では表示を出さない）。 */
function checkOrder(doc: Document, spot: DropSpot | null): DropSpot | null {
  if (!spot || spot.parentPath === null || typeof spot.parentPath === 'string') return spot;
  const parent = elementAt(doc, spot.parentPath);
  const tag = draggedTag(doc);
  if (!parent || !tag) return null;
  const moving = movingElement(doc);
  const allowed = allowedIndex(parent, tag, spot.index, moving && moving.parentElement === parent ? moving : null);
  return allowed === null ? null : spot;
}

/** ポインタの位置から、置ける場所を探す。置けなければ null。 */
function findDropSpot(e: DragEvent, host: HTMLElement): DropSpot | null {
  const store = app.store;
  const payload = dragPayload();
  if (!store || !payload) return null;
  const doc = store.doc;
  const target = e.target as HTMLElement;

  // タブを運んでいるときは、タブバーの上だけを受け付ける
  const tabBar = target.closest<HTMLElement>('.rb-tabs');
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
        return { parentPath: tabsPath, index: parsePath(n.dataset['path'])!.at(-1)!, rect: { left: r.left - 2, top: r.top, width: 2, height: r.height }, container: tabBar };
      }
    }
    const last = own.at(-1) ?? tabNodes.at(-1);
    const r = (last ?? tabBar).getBoundingClientRect();
    return { parentPath: tabsPath, index: tabsEl?.children.length ?? 0, rect: { left: r.right + 1, top: r.top, width: 2, height: r.height }, container: tabBar };
  }

  // Backstage がまだないときは、空の欄へのドロップで作る
  const bsNew = target.closest<HTMLElement>('[data-bs-new]');
  if (bsNew) {
    if (draggedTag(doc) !== 'backstage') return null;
    const r = bsNew.getBoundingClientRect();
    return { parentPath: 'backstage', index: 0, rect: { left: r.left + 4, top: r.top + 4, width: r.width - 8, height: 2 }, container: bsNew };
  }

  // コンテキストメニューの一覧がまだないときは、空の欄へのドロップで作る
  const ctxNew = target.closest<HTMLElement>('[data-ctx-new]');
  if (ctxNew) {
    if (draggedTag(doc) !== 'contextMenu') return null;
    const r = ctxNew.getBoundingClientRect();
    return { parentPath: 'contextMenus', index: 0, rect: { left: r.left + 4, top: r.bottom - 6, width: r.width - 8, height: 2 }, container: ctxNew };
  }

  // 内側のコンテナから順に、置けるところを探す
  let node: HTMLElement | null = target.closest<HTMLElement>('[data-container], [data-path]');
  while (node && host.contains(node)) {
    const containerPath = parsePath(node.dataset['container']);
    const container = containerPath ? elementAt(doc, containerPath) : null;
    if (container && canDropInto(doc, container)) {
      const spot = checkOrder(doc, spotInContainer(e, node, containerPath!, container));
      if (spot) return spot;
    }

    const path = parsePath(node.dataset['path']);
    const el = path ? elementAt(doc, path) : null;
    if (el && !node.dataset['container']) {
      // グループ本体やタブ本体（data-path）は、その要素自身がコンテナになりうる
      if (canDropInto(doc, el) && (node.classList.contains('rb-body') || node.classList.contains('rb-group'))) {
        const inner = node.classList.contains('rb-group') ? node.querySelector<HTMLElement>('.rb-controls') ?? node : node;
        const spot = checkOrder(doc, spotInContainer(e, inner, path!, el));
        if (spot) return spot;
      }
      const parent = el.parentElement;
      if (parent && canDropInto(doc, parent)) {
        const r = node.getBoundingClientRect();
        const idx = Array.prototype.indexOf.call(parent.children, el) as number;
        // メニューの項目は縦に並ぶので、上下で前後を決める
        const vertical = node.classList.contains('rb-menu-item') || node.classList.contains('bs-item') || node.classList.contains('bs-group') || node.classList.contains('bs-category');
        const before = vertical ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
        const spot = checkOrder(doc, {
          parentPath: pathOf(parent),
          index: before ? idx : idx + 1,
          rect: vertical
            ? { left: r.left, top: (before ? r.top : r.bottom) - 1, width: r.width, height: 2 }
            : { left: (before ? r.left : r.right) - 1, top: r.top, width: 2, height: r.height },
          container: node.parentElement?.closest<HTMLElement>('[data-container], .rb-group, .rb-body') ?? null,
        });
        if (spot) return spot;
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
  const highlight = node.closest<HTMLElement>('.rb-group, .ctx-card, .bs-column, .bs-group, .rb-body') ?? node;
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    const inList = isVerticalList(k.parentElement);
    const before = inList
      ? e.clientY < r.top + r.height / 2
      : e.clientX < r.left || (e.clientX <= r.right && e.clientY < r.top + r.height / 2 && r.height < 40) || (e.clientX <= r.left + r.width / 2 && r.height >= 40);
    if (before) {
      const idx = parsePath(k.dataset['path'])!.at(-1)!;
      const stacked = inList || (r.height < 40 && k.parentElement?.classList.contains('rb-stack') && k.previousElementSibling !== null);
      return {
        parentPath: containerPath,
        index: idx,
        rect: stacked ? { left: r.left, top: r.top - 1, width: r.width, height: 2 } : { left: r.left - 2, top: r.top, width: 2, height: r.height },
        container: highlight,
      };
    }
  }
  const last = kids.at(-1);
  const r = (last ?? node).getBoundingClientRect();
  return {
    parentPath: containerPath,
    index: container.children.length,
    rect: last
      ? isVerticalList(last.parentElement)
        ? { left: r.left, top: r.bottom, width: r.width, height: 2 }
        : { left: r.right + 1, top: r.top, width: 2, height: r.height }
      : { left: r.left + 4, top: r.top + 4, width: 2, height: Math.max(r.height - 8, 16) },
    container: highlight,
  };
}

/** 縦に並ぶ一覧（メニュー、Backstage）か。前後を上下で決める。 */
function isVerticalList(el: Element | null): boolean {
  if (!el) return false;
  const c = el.classList;
  return c.contains('ctx-items') || c.contains('rb-menu-popup') || c.contains('bs-list') || c.contains('bs-column') || (c.contains('bs-nav') && !c.contains('horizontal'));
}

let highlighted: HTMLElement | null = null;

function showIndicator(host: HTMLElement, spot: DropSpot): void {
  const ind = host.querySelector<HTMLElement>('.drop-indicator');
  if (!ind) return;
  const base = host.getBoundingClientRect();
  ind.hidden = false;
  ind.style.left = `${spot.rect.left - base.left + host.scrollLeft}px`;
  ind.style.top = `${spot.rect.top - base.top + host.scrollTop}px`;
  ind.style.width = `${spot.rect.width}px`;
  ind.style.height = `${spot.rect.height}px`;
  if (highlighted !== spot.container) {
    highlighted?.classList.remove('drop-target');
    highlighted = spot.container;
    highlighted?.classList.add('drop-target');
  }
}

function hideIndicator(host: HTMLElement): void {
  const ind = host.querySelector<HTMLElement>('.drop-indicator');
  if (ind) ind.hidden = true;
  highlighted?.classList.remove('drop-target');
  highlighted = null;
}

function imageTarget(e: DragEvent): Path | null {
  const node = (e.target as HTMLElement).closest<HTMLElement>('.rb-ctl[data-path], .rb-group[data-path]');
  const path = parsePath(node?.dataset['path']);
  const el = path && app.store ? elementAt(app.store.doc, path) : null;
  return el && defFor(el)?.attrs.includes('image') ? path : null;
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
    // 置けない場所では「禁止」のカーソルにする
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    hideIndicator(host);
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = dragPayload()?.kind === 'new' ? 'copy' : 'move';
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
  if (!spot) {
    endDrag();
    return;
  }
  e.preventDefault();
  drop(spot.parentPath, spot.index, 'canvas');
}

/**
 * 反映後に前面に出すタブの id。キャンバスで表示中の自作タブ、なければ最初の自作タブ。
 * 組み込みタブ（idMso）は ActivateTabMso が要るので、ここでは扱わない。
 */
export function tabIdToActivate(): string | null {
  const store = app.store;
  if (!store) return null;
  if (activeTab?.kind === 'el') {
    if (activeTab.id) return activeTab.id;
    const id = elementAt(store.doc, activeTab.path)?.getAttribute('id');
    if (id) return id;
  }
  const tabs = store.doc.documentElement.querySelector(':scope > ribbon > tabs');
  return tabs ? childElements(tabs).find((x) => x.localName === 'tab' && x.hasAttribute('id'))?.getAttribute('id') ?? null : null;
}
