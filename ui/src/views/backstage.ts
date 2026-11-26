// Backstage（［ファイル］タブ）のプレビュー（仕様書 §5.2、第3弾）。
// 左に組み込みのメニュー（グレー）と自分で足したタブ・ボタン、右に選んだタブの列とグループを並べる。

import { app } from '../app';
import { runEdit } from '../clipboard';
import { endDrag, startDrag } from '../dnd';
import { h } from '../dom';
import { uiIcons } from '../icons';
import { emptyState } from './emptyState';
import { childElements, createElement, elementAt, pathOf, samePath, type Path } from '../model';
import { msoIcon } from '../msoIcons';
import { lang, t as tr } from '../i18n';

/** 組み込みの Backstage のメニュー（表示だけ）。 */
const BUILTIN_NAV = ['ホーム', '新規', '開く', '情報', '上書き保存', '名前を付けて保存', '印刷', '共有', 'エクスポート', '閉じる'];

/**
 * 表示中の Backstage のタブ。id（なければパス）で覚える。
 * パスだけだと、前にタブを足しただけで別のタブに切り替わってしまうため（不具合 32）。
 */
let selectedTab: { id: string | null; path: Path } | null = null;

function remember(tab: Element): void {
  selectedTab = { id: tab.getAttribute('id'), path: pathOf(tab) };
}

export function resetBackstage(): void {
  selectedTab = null;
}

/** 選択が Backstage のタブの中に移ったら、そのタブを表示する。 */
export function followBackstageSelection(doc: Document, sel: Path | null): boolean {
  let el = sel ? elementAt(doc, sel) : null;
  let inBs = false;
  for (let cur = el; cur; cur = cur.parentElement) if (cur.localName === 'backstage') inBs = true;
  if (!inBs) return false;
  while (el && !(el.localName === 'tab' && el.parentElement?.localName === 'backstage')) el = el.parentElement;
  if (el) remember(el);
  return true;
}

interface Ctx {
  sel: Path | null;
  errors: Set<string>;
}

function common(el: Element, cls: string, ctx: Ctx): Record<string, unknown> {
  const path = pathOf(el);
  return {
    class: [cls, samePath(ctx.sel, path) ? 'selected' : '', ctx.errors.has(path.join('.')) ? 'has-error' : '', el.getAttribute('visible') === 'false' ? 'hidden-ctl' : ''].join(' '),
    dataset: { path: path.join('.'), sel: '1' },
    draggable: true,
    title: el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName,
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
}

function labelOf(el: Element): string {
  const l = el.getAttribute('label');
  if (l !== null) return l;
  const g = el.getAttribute('getLabel');
  return g ? `{${g}}` : el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName;
}

/** アイコン（image / imageMso / getImage）を持っているか。 */
function hasIcon(el: Element): boolean {
  return el.hasAttribute('image') || el.hasAttribute('imageMso') || el.hasAttribute('getImage');
}

function icon(el: Element, px: number): HTMLElement {
  const store = app.store!;
  const image = el.getAttribute('image');
  const mso = el.getAttribute('imageMso');
  const src = image ? store.images.get(image)?.dataUrl : mso ? msoIcon(mso) : null;
  if (src) return h('img', { class: 'rb-icon', src, width: px, height: px, alt: '' });
  // getImage は VBA が返すので中身は描けない。リボンのキャンバスと同じ「動的」の印を出す
  const cls = el.hasAttribute('getImage') ? ' dynamic' : image || mso ? '' : ' none';
  return h('span', { class: `rb-icon placeholder${cls}`, style: `width:${px}px;height:${px}px`, title: mso ?? image ?? el.getAttribute('getImage') ?? '' }, mso ? mso.slice(0, 1) : '');
}

function list(parent: Element | undefined, cls: string, ctx: Ctx, empty: string): HTMLElement | null {
  if (!parent) return null;
  const kids = childElements(parent);
  return h('div', { class: `bs-list ${cls}`, dataset: { container: pathOf(parent).join('.') } }, kids.length ? kids.map((k) => item(k, ctx)) : h('div', { class: 'bs-empty' }, empty));
}

function item(el: Element, ctx: Ctx): HTMLElement {
  const c = (cls: string) => common(el, `bs-item ${cls}`, ctx);
  const label = labelOf(el);
  switch (el.localName) {
    case 'button':
    case 'toggleButton':
      return h('div', c(el.getAttribute('style') === 'large' ? 'bs-button large' : 'bs-button'), hasIcon(el) ? icon(el, el.getAttribute('style') === 'large' ? 32 : 16) : null, h('span', null, label));
    case 'menu':
      return h('div', c('bs-button'), icon(el, 16), h('span', null, label), h('span', { class: 'rb-arrow' }));
    case 'checkBox':
      return h('div', c('bs-check'), h('span', { class: 'rb-check' }), h('span', null, label));
    case 'editBox':
    case 'comboBox':
    case 'dropDown':
      return h('div', c('bs-field'), h('span', null, label), h('span', { class: 'rb-field' }, el.localName === 'editBox' ? null : h('span', { class: 'rb-arrow' })));
    case 'radioGroup':
      return h('div', c('bs-radio'), h('span', null, label), h('div', { class: 'bs-radios' }, childElements(el).map((r) => h('span', null, h('span', { class: 'bs-radio-dot' }), labelOf(r)))));
    case 'hyperlink':
      return h('div', c('bs-link'), hasIcon(el) ? icon(el, 16) : null, h('span', null, label));
    case 'labelControl':
      return h('div', c('bs-label'), label);
    case 'imageControl':
      return h('div', c('bs-image'), icon(el, 48));
    case 'groupBox':
      return h('div', c('bs-groupbox'), h('div', { class: 'bs-groupbox-label' }, label), list(el, '', ctx, tr('ここに項目をドラッグ')));
    case 'layoutContainer':
      return h('div', c(`bs-layout ${el.getAttribute('layoutChildren') === 'horizontal' ? 'horizontal' : 'vertical'}`), list(el, '', ctx, tr('ここに項目をドラッグ')));
    default:
      return h('div', c('bs-label'), `<${el.localName}> ${label}`);
  }
}

function group(el: Element, ctx: Ctx): HTMLElement {
  const find = (n: string) => childElements(el).find((c) => c.localName === n);
  if (el.localName === 'taskGroup' || el.localName === 'taskFormGroup') {
    return h(
      'div',
      common(el, 'bs-group task', ctx),
      el.getAttribute('showLabel') === 'false' ? null : h('div', { class: 'bs-group-title' }, labelOf(el)),
      el.getAttribute('helperText') ? h('div', { class: 'bs-helper' }, el.getAttribute('helperText')) : null,
      childElements(el).map((cat) =>
        h('div', { ...common(cat, 'bs-category', ctx), class: `bs-category${samePath(ctx.sel, pathOf(cat)) ? ' selected' : ''}` },
          h('div', { class: 'bs-category-title' }, labelOf(cat)),
          h('div', { class: 'bs-list', dataset: { container: pathOf(cat).join('.') } },
            childElements(cat).map((t) => h('div', common(t, 'bs-item bs-task', ctx), icon(t, 32), h('div', null, h('div', null, labelOf(t)), t.getAttribute('description') ? h('div', { class: 'bs-helper' }, t.getAttribute('description')) : null))))),
      ),
    );
  }
  return h(
    'div',
    common(el, `bs-group ${el.getAttribute('style') ?? ''}`, ctx),
    el.getAttribute('showLabel') === 'false' ? null : h('div', { class: 'bs-group-title' }, labelOf(el)),
    el.getAttribute('helperText') ? h('div', { class: 'bs-helper' }, el.getAttribute('helperText')) : null,
    h('div', { class: 'bs-group-body' }, list(find('primaryItem'), 'primary', ctx, tr('主な項目')), h('div', { class: 'bs-group-items' }, list(find('topItems'), 'top', ctx, tr('ここに項目をドラッグ')), list(find('bottomItems'), 'bottom', ctx, ''))),
  );
}

/** Backstage の画面を作る。backstage 要素がなければ追加の案内を出す。 */
export function renderBackstage(doc: Document, errors: Set<string>): HTMLElement {
  const store = app.store!;
  if (store.version === 'office2007') {
    return h('div', { class: 'bs-view empty' }, h('p', { class: 'muted' }, tr('Backstage は customUI14（2010以降）の形式でのみ編集できます')));
  }
  const bs = childElements(doc.documentElement).find((c) => c.localName === 'backstage');
  if (!bs) {
    // 同じ役割の「空の状態」は 1 つの部品で出す（総点検 C-1）。ここはパレットからのドロップ先でもある（data-bs-new）
    const card = emptyState({
      icon: uiIcons.info,
      title: tr('Backstage はまだありません'),
      text: [tr('［ファイル］タブ（Backstage）に、自分のタブやボタンを足せます。'), tr('パレットの「Backstage」をここにドラッグするか、ダブルクリックしてください。')].join(lang === 'en' ? ' ' : ''),
      action: h('button', { type: 'button', class: 'small', onclick: (e: MouseEvent) => { e.stopPropagation(); addBackstage(); } }, tr('Backstage を追加')),
    });
    card.dataset['bsNew'] = '1';
    return card;
  }
  const ctx: Ctx = { sel: store.selection, errors };
  const tabs = childElements(bs).filter((c) => c.localName === 'tab');
  const remembered = selectedTab;
  let tab = remembered ? (remembered.id !== null ? tabs.find((x) => x.getAttribute('id') === remembered.id) : undefined) ?? elementAt(doc, remembered.path) : null;
  if (!tab || tab.parentElement !== bs || tab.localName !== 'tab') tab = tabs[0] ?? null;

  const nav = h(
    'nav',
    { class: 'bs-nav', dataset: { container: pathOf(bs).join('.') } },
    h('div', { class: 'bs-back' }, '←'),
    BUILTIN_NAV.map((n) => h('div', { class: 'bs-nav-builtin' }, tr(n))),
    h('div', { class: 'bs-nav-sep' }),
    childElements(bs).map((c) =>
      c.localName === 'tab'
        ? h('div', { ...common(c, `bs-nav-item bs-item${c === tab ? ' active' : ''}`, ctx), onclick: (e: MouseEvent) => { e.stopPropagation(); remember(c); app.store?.select(pathOf(c), 'canvas'); } }, labelOf(c))
        : h('div', common(c, 'bs-nav-item bs-item command', ctx), hasIcon(c) ? icon(c, 16) : null, labelOf(c)),
    ),
  );

  let content: HTMLElement;
  if (!tab) {
    content = h('div', { class: 'bs-content' }, h('p', { class: 'muted' }, tr('パレットの「タブ」を左のメニューにドラッグすると、Backstage にタブを足せます')));
  } else {
    const col = (name: string) => childElements(tab!).find((c) => c.localName === name);
    const column = (el: Element | undefined) =>
      el ? h('div', { ...common(el, 'bs-column', ctx), draggable: false, dataset: { path: pathOf(el).join('.'), container: pathOf(el).join('.'), sel: '1' } }, el.children.length ? childElements(el).map((g) => group(g, ctx)) : h('div', { class: 'bs-empty' }, tr('グループをドラッグ'))) : null;
    content = h('div', { class: 'bs-content' }, h('h2', { class: 'bs-title' }, tab.getAttribute('title') ?? labelOf(tab)), h('div', { class: 'bs-columns', dataset: { container: pathOf(tab).join('.') } }, column(col('firstColumn')), column(col('secondColumn'))));
  }
  return h('div', { class: 'bs-view' }, nav, content);
}

/** customUI の中に、最低限の中身を持つ backstage を作る（ribbon の後ろ、contextMenus の前）。 */
function addBackstage(): void {
  runEdit('canvas', (doc) => {
    const root = doc.documentElement;
    if (childElements(root).some((c) => c.localName === 'backstage')) return undefined;
    const bs = createElement(doc, 'backstage', root);
    root.insertBefore(bs, childElements(root).find((c) => c.localName === 'contextMenus') ?? null);
    return pathOf(bs);
  }, tr('Backstage を追加'));
}
