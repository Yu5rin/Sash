// idMso / imageMso カタログ（仕様書 §9.1）。あいまい検索し、クリックで選択中のコントロールに設定する。

import { app } from '../app';
import { catalog, ensureLabels, favorites, labels, recent, search, type CatalogEntry } from '../catalog/catalog';
import { debounce, h, svg } from '../dom';
import { uiIcons } from '../icons';
import { msoIcon, onMsoIconsLoaded } from '../msoIcons';
import { openModal } from './modal';

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

export function openCatalog(mode: CatalogMode, current: string, apply: (value: string) => void, preferType = ''): void {
  let type = preferType;
  const input = h('input', { type: 'search', placeholder: mode === 'idMso' ? 'idMso を検索（例：TabHome、sum、貼り付け）' : 'imageMso を検索（例：AutoSum、save）', value: current, spellcheck: false });
  const filters = h('div', { class: 'segmented wrap' });
  const results = h('div', { class: mode === 'imageMso' ? 'catalog-grid' : 'catalog-list' });
  const status = h('div', { class: 'catalog-status' });

  const choose = (id: string) => {
    recent.add(id);
    apply(id);
    modal.close();
  };

  const item = (c: CatalogEntry) => {
    const label = labels.get(c.id);
    const icon = msoIcon(c.id);
    const fav = favorites.has(c.id);
    return h(
      'div',
      { class: `catalog-item${c.id === current ? ' selected' : ''}`, tabIndex: 0, title: [c.id, label, c.tab && `タブ：${c.tab}`, c.group && `グループ：${c.group}`].filter(Boolean).join('\n'), onclick: () => choose(c.id), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && choose(c.id) },
      mode === 'imageMso' || icon ? (icon ? h('img', { src: icon, width: 32, height: 32, alt: '' }) : h('span', { class: 'rb-icon placeholder', style: 'width:32px;height:32px' }, c.id.slice(0, 1))) : null,
      h('span', { class: 'catalog-id' }, c.id),
      label ? h('span', { class: 'catalog-label' }, label) : null,
      mode === 'idMso' ? h('span', { class: 'catalog-type' }, c.type) : null,
      h('button', {
        type: 'button',
        class: `icon-button fav${fav ? ' on' : ''}`,
        title: fav ? 'お気に入りから外す' : 'お気に入りに追加',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          favorites.toggle(c.id);
          render();
        },
      }, svg(uiIcons.star)),
    );
  };

  const render = () => {
    const q = input.value.trim();
    const filter = (c: CatalogEntry) => (mode === 'imageMso' ? c.type !== 'tab' && c.type !== 'group' && c.type !== 'tabSet' && c.type !== 'contextMenu' : !type || c.type === type);
    let list = search(q, filter, mode === 'imageMso' ? 240 : 300);
    if (!q) {
      // 検索語がなければ、お気に入りと最近使ったものを先頭に出す
      const pinned = [...favorites.list(), ...recent.list()];
      const byId = new Map(catalog.map((c) => [c.id, c]));
      const head = [...new Set(pinned)].map((id) => byId.get(id)).filter((c): c is CatalogEntry => c !== undefined && filter(c));
      list = [...head, ...list.filter((c) => !head.includes(c))];
    }
    results.replaceChildren(...list.map(item));
    status.textContent = `${list.length} 件${list.length >= 240 ? '（上位のみ表示）' : ''}${labels.size === 0 ? ' ・ 日本語名はExcelがある環境で取得します' : ''}`;
  };

  if (mode === 'idMso') {
    for (const [v, text] of TYPE_FILTERS) {
      filters.append(h('button', {
        type: 'button',
        class: v === type ? 'active' : '',
        onclick: (e: MouseEvent) => {
          type = v;
          filters.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
          (e.currentTarget as HTMLElement).classList.add('active');
          render();
        },
      }, text));
    }
  }

  input.addEventListener('input', debounce(render, 80));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') results.querySelector<HTMLElement>('.catalog-item')?.click();
    if (e.key === 'ArrowDown') results.querySelector<HTMLElement>('.catalog-item')?.focus();
  });

  const content = h('div', { class: 'catalog' }, input, mode === 'idMso' ? filters : null, results, status);
  const modal = openModal(mode === 'idMso' ? 'idMso を選ぶ' : 'imageMso を選ぶ', content, { wide: true });
  input.select();
  render();
  onMsoIconsLoaded(() => {
    if (document.body.contains(results)) render();
  });
  void ensureLabels(app.info.excelInstalled).then(() => {
    if (document.body.contains(results)) render();
  });
}
