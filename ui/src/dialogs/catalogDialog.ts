// idMso / imageMso カタログ（仕様書 §9.1）。あいまい検索し、クリックで選択中のコントロールに設定する。
// 矢印キーで候補を移り、Enter で決める。名前のコピーと、組み込みコントロールとしての挿入もここからできる。

import { app } from '../app';
import { catalog, ensureLabels, favorites, labels, recent, search, type CatalogEntry } from '../catalog/catalog';
import { copyText, findInsertSpot, notify, runEdit } from '../clipboard';
import { debounce, h, svg } from '../dom';
import { uiIcons } from '../icons';
import { createIn, elementAt, pathOf } from '../model';
import { describePrefetch, msoIcon, msoIconsEnabled, onMsoIconsLoaded, onPrefetchStatus, prefetchStatus, startMsoPrefetch } from '../msoIcons';
import type { IconPrefetchStatus } from '../bridge';
import { openModal, openOnce, type ModalHandle } from './modal';
import { t } from '../i18n';

export type CatalogMode = 'idMso' | 'imageMso';

const TYPE_FILTERS: readonly [string, string][] = [
  ['', 'すべて'],
  ['tab', 'タブ'],
  ['group', 'グループ'],
  ['button', 'ボタン'],
  ['toggleButton', 'トグル'],
  ['menu', 'メニュー'],
  ['splitButton', '分割ボタン'],
  ['gallery', 'ギャラリー'],
  ['contextMenu', '右クリックメニュー'],
];

export interface CatalogOptions {
  /** 選ばずに閉じたときに呼ぶ（呼び出し元で「種類だけ選んだ」状態を戻すため）。 */
  onCancel?: () => void;
}

/** コピーのアイコン（16px、currentColor）。 */
const COPY_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5V3.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2"/></svg>';

/**
 * アイコンの読み込みを待って描き直す相手。onMsoIconsLoaded は登録を外せないので、
 * 開くたびに登録すると閉じたダイアログが残り続ける（不具合 31）。登録は1回だけにして、開いているものだけを描き直す。
 */
let rerenderOpen: (() => void) | null = null;
let iconListenerAdded = false;

/**
 * アイコンを出せないときの案内（仕様書 §17.7）。取り込んでいない・取り込み中・Excel がない、の理由と、取り込みを始めるボタン。
 * 取り込み済み（または一部でもキャッシュがあり Excel がある）なら出さない。
 */
export function iconBanner(st: IconPrefetchStatus | null, enabled: boolean, excelInstalled: boolean): { text: string; canStart: boolean } | null {
  if (!st) return enabled ? null : { text: t('Excel が見つからないため、アイコンは表示できません。'), canStart: false };
  if (st.state === 'done') return null;
  if (st.state === 'running') return { text: t('Excel のアイコンを取り込んでいます。終わると表示されます。') + ' ' + describePrefetch(st), canStart: false };
  if (st.state === 'unavailable' || !(st.excelInstalled ?? excelInstalled)) {
    return st.cached > 0 ? null : { text: t('Excel が見つからないため、アイコンは表示できません。Excel のある PC で取り込むと表示されます。'), canStart: false };
  }
  if (st.state === 'failed') return { text: describePrefetch(st), canStart: true };
  if (st.cached > 0) return { text: `${describePrefetch(st)} ${t('残りも取り込むと、すべてのアイコンが表示されます。')}`, canStart: true };
  return { text: t('アイコンはまだ取り込まれていません。この PC の Excel から一度だけ取り込むと、ここに表示されます（Excel を起動しなくても表示できるようになります）。'), canStart: true };
}

/** 組み込みのコントロールを、選択中の場所に idMso の参照として置く。 */
function insertBuiltin(c: CatalogEntry): void {
  const store = app.store;
  if (!store) return;
  const tag = c.type === 'tab' || c.type === 'group' ? c.type : 'control';
  const spot = findInsertSpot(store.selectedElement, tag, store.doc);
  if (!spot) {
    notify({ kind: 'warning', message: tag === 'control' ? t('組み込みのコマンドはグループかメニューの中に置けます。置き先を選択してください') : t('<{tag}> を置ける場所がありません。置き先の要素を選択してください', { tag }) });
    return;
  }
  const parentPath = pathOf(spot.parent);
  runEdit('canvas', (doc) => {
    const parent = elementAt(doc, parentPath);
    if (!parent) return undefined;
    // 接頭辞付きの文書（<mso:customUI xmlns:mso=…>）でも、ほかの要素と同じ接頭辞で作る
    const el = createIn(doc, tag);
    el.setAttribute('idMso', c.id);
    parent.insertBefore(el, parent.children[spot.index] ?? null);
    return pathOf(el);
  }, t('組み込みの {id} を挿入', { id: c.id }));
}

export function openCatalog(mode: CatalogMode, current: string, apply: (value: string) => void, preferType = '', opts: CatalogOptions = {}): void {
  // ボタンの連打などで同じカタログが二重に開かないようにする
  void openOnce(`catalog:${mode}`, () => openCatalogDialog(mode, current, apply, preferType, opts));
}

function openCatalogDialog(mode: CatalogMode, current: string, apply: (value: string) => void, preferType: string, opts: CatalogOptions): ModalHandle {
  let type = preferType;
  let chosen = false;
  const input = h('input', { type: 'search', placeholder: mode === 'idMso' ? t('idMso を検索（例：TabHome、sum、貼り付け）') : t('imageMso を検索（例：AutoSum、save）'), value: current, spellcheck: false, 'aria-label': t('検索') });
  const filters = h('div', { class: 'segmented wrap', role: 'group', 'aria-label': t('種類で絞り込む') });
  const results = h('div', { class: mode === 'imageMso' ? 'catalog-grid' : 'catalog-list', role: 'listbox', 'aria-label': t('候補') });
  const status = h('div', { class: 'catalog-status', 'aria-live': 'polite' });
  // 長い名前は 2 行までの表示で切れることがあるので、注目している項目（フォーカス・マウス・選択中）の名前の全文をここに出す（D-3）
  const fullName = h('div', { class: 'catalog-fullname', 'aria-hidden': 'true' });
  const showFull = (id: string | undefined) => {
    const label = id ? labels.get(id) : undefined;
    fullName.textContent = id ? (label ? `${id}（${label}）` : id) : '';
  };

  const choose = (id: string) => {
    chosen = true;
    recent.add(id);
    dialog.close();
    apply(id);
  };

  const item = (c: CatalogEntry) => {
    const label = labels.get(c.id);
    const icon = msoIcon(c.id);
    const fav = favorites.has(c.id);
    const insertable = mode === 'idMso' && c.type !== 'contextMenu' && c.type !== 'tabSet';
    return h(
      'div',
      {
        class: `catalog-item${c.id === current ? ' selected' : ''}`,
        role: 'option',
        tabIndex: -1,
        'aria-selected': String(c.id === current),
        dataset: { id: c.id },
        title: [c.id, label, c.tab && t('タブ：{tab}', { tab: c.tab }), c.group && t('グループ：{group}', { group: c.group })].filter(Boolean).join('\n'),
        onclick: () => choose(c.id),
      },
      mode === 'imageMso' || icon ? (icon ? h('img', { src: icon, width: 32, height: 32, alt: '' }) : h('span', { class: 'rb-icon placeholder', style: 'width:32px;height:32px' }, c.id.slice(0, 1))) : null,
      h('span', { class: 'catalog-text' }, h('span', { class: 'catalog-id' }, c.id), label ? h('span', { class: 'catalog-label' }, label) : null),
      mode === 'idMso' ? h('span', { class: 'catalog-type' }, c.type) : null,
      h(
        'span',
        { class: 'catalog-actions' },
        h('button', {
          type: 'button',
          class: 'icon-button',
          title: t('名前をコピー'),
          'aria-label': t('名前をコピー'),
          tabIndex: -1,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            copyText(c.id, t('{value} をコピーしました', { value: c.id }));
          },
        }, svg(COPY_ICON)),
        insertable
          ? h('button', {
              type: 'button',
              class: 'small',
              title: t('選択中の場所に、組み込みのコントロールとして置く'),
              tabIndex: -1,
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                chosen = true;
                dialog.close();
                insertBuiltin(c);
              },
            }, t('挿入'))
          : null,
        h('button', {
          type: 'button',
          class: `icon-button fav${fav ? ' on' : ''}`,
          title: fav ? t('お気に入りから外す') : t('お気に入りに追加'),
          'aria-label': fav ? t('お気に入りから外す') : t('お気に入りに追加'),
          'aria-pressed': String(fav),
          tabIndex: -1,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            favorites.toggle(c.id);
            render();
          },
        }, svg(uiIcons.star)),
      ),
    );
  };

  const render = () => {
    const q = input.value.trim();
    const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.catalog-item')?.dataset['id'];
    const filter = (c: CatalogEntry) => (mode === 'imageMso' ? c.type !== 'tab' && c.type !== 'group' && c.type !== 'tabSet' && c.type !== 'contextMenu' : !type || c.type === type);
    let list = search(q, filter, mode === 'imageMso' ? 240 : 300);
    if (!q) {
      // 検索語がなければ、お気に入りと最近使ったものを先頭に出す
      const pinned = [...favorites.list(), ...recent.list()];
      const byId = new Map(catalog.map((c) => [c.id, c]));
      const head = [...new Set(pinned)].map((id) => byId.get(id)).filter((c): c is CatalogEntry => c !== undefined && filter(c));
      list = [...head, ...list.filter((c) => !head.includes(c))];
    }
    results.replaceChildren(...(list.length ? list.map(item) : [h('div', { class: 'panel-empty' }, t('見つかりませんでした。別の言葉で検索してください'))]));
    const first = results.querySelector<HTMLElement>('.catalog-item');
    if (first) first.tabIndex = 0;
    showFull(focusedId ?? (current && list.some((c) => c.id === current) ? current : undefined));
    if (focusedId) results.querySelector<HTMLElement>(`.catalog-item[data-id="${CSS.escape(focusedId)}"]`)?.focus();
    status.textContent = t('{n} 件', { n: list.length }) + (list.length >= 240 ? t('（上位のみ表示）') : '') + (labels.size === 0 ? t(' ・ 日本語名はExcelがある環境で取得します') : '');
  };

  if (mode === 'idMso') {
    for (const [v, text] of TYPE_FILTERS) {
      filters.append(h('button', {
        type: 'button',
        class: v === type ? 'active' : '',
        'aria-pressed': String(v === type),
        onclick: (e: MouseEvent) => {
          type = v;
          filters.querySelectorAll('button').forEach((b) => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
          });
          (e.currentTarget as HTMLElement).classList.add('active');
          (e.currentTarget as HTMLElement).setAttribute('aria-pressed', 'true');
          render();
        },
      }, t(text)));
    }
  }

  /** 格子の1行の個数（上端の位置が同じものを数える）。 */
  const perRow = (items: HTMLElement[]) => {
    if (mode !== 'imageMso' || items.length === 0) return 1;
    const top = items[0]!.offsetTop;
    const n = items.findIndex((x) => x.offsetTop !== top);
    return n < 0 ? items.length : n;
  };
  results.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const items = Array.from(results.querySelectorAll<HTMLElement>('.catalog-item'));
    const idx = items.indexOf((e.target as HTMLElement).closest<HTMLElement>('.catalog-item')!);
    if (idx < 0) return;
    const cols = perRow(items);
    let next = -1;
    if (e.key === 'ArrowDown') next = idx + cols;
    else if (e.key === 'ArrowUp') next = idx - cols;
    else if (e.key === 'ArrowRight' && cols > 1) next = idx + 1;
    else if (e.key === 'ArrowLeft' && cols > 1) next = idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[idx]!.dataset['id']!);
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      const id = items[idx]!.dataset['id']!;
      copyText(id, t('{value} をコピーしました', { value: id }));
      return;
    } else return;
    e.preventDefault();
    if (next < 0 && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
      input.focus();
      return;
    }
    const target = items[Math.max(0, Math.min(next, items.length - 1))];
    if (target) {
      items.forEach((x) => (x.tabIndex = -1));
      target.tabIndex = 0;
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    }
  });

  // 打つたびに全件を検索し直すと重いので、少し待ってから描き直す
  input.addEventListener('input', debounce(render, 120));
  input.addEventListener('keydown', (e) => {
    // 日本語入力の変換確定の Enter で候補を決めてしまわないようにする（不具合 39）
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      render();
      results.querySelector<HTMLElement>('.catalog-item')?.click();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      results.querySelector<HTMLElement>('.catalog-item')?.focus();
    }
  });

  const hint = h('div', { class: 'catalog-hint muted' }, t('↑↓ で移動・Enter で決定・Ctrl+C で名前をコピー'));
  const banner = h('div', { class: 'notice catalog-banner', role: 'status', hidden: true });
  const renderBanner = () => {
    const b = mode === 'imageMso' ? iconBanner(prefetchStatus(), msoIconsEnabled(), app.info.excelInstalled) : null;
    banner.hidden = !b;
    if (!b) return;
    banner.replaceChildren(h('span', null, b.text));
    if (b.canStart) banner.append(h('button', { type: 'button', class: 'small', onclick: () => void startMsoPrefetch(false) }, t('アイコンを取り込む')));
  };
  renderBanner();
  const offBanner = onPrefetchStatus(() => {
    if (!banner.isConnected) {
      offBanner();
      return;
    }
    renderBanner();
  });
  const idOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.catalog-item')?.dataset['id'];
  results.addEventListener('focusin', (e) => showFull(idOf(e)));
  results.addEventListener('mouseover', (e) => showFull(idOf(e)));
  const content = h('div', { class: 'catalog' }, input, banner, mode === 'idMso' ? filters : null, results, fullName, h('div', { class: 'catalog-foot' }, status, hint));
  const dialog = openModal(mode === 'idMso' ? t('idMso を選ぶ') : t('imageMso を選ぶ'), content, {
    wide: true,
    onClose: () => {
      offBanner();
      if (rerenderOpen === render) rerenderOpen = null;
      if (!chosen) opts.onCancel?.();
    },
  });
  input.focus();
  input.select();
  render();
  rerenderOpen = render;
  if (!iconListenerAdded) {
    iconListenerAdded = true;
    onMsoIconsLoaded(() => rerenderOpen?.());
  }
  void ensureLabels(app.info.excelInstalled).then(() => {
    if (document.body.contains(results)) render();
  });
  return dialog;
}
