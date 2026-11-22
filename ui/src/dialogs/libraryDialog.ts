// アイコンライブラリ（仕様書 §6.4、第3弾）。加工済みのアイコンを検索して、別のブックでも使い回す。

import { invoke, type LibraryIconDetail, type LibraryIconDto } from '../bridge';
import { debounce, h, svg } from '../dom';
import { uiIcons } from '../icons';
import { fuzzyScore } from '../catalog/catalog';
import { ask, openModal } from './modal';

export type LibraryPick = (icon: LibraryIconDetail) => void;

/** 開く。onPick を渡すと、クリックでそのアイコンを選んで閉じる（渡さなければ管理だけ）。 */
export async function openLibrary(onPick?: LibraryPick, toast?: (m: string, k?: 'info' | 'error') => void): Promise<void> {
  let data: { root: string; icons: LibraryIconDto[] };
  try {
    data = await invoke('library.list');
  } catch (e) {
    toast?.((e as Error).message, 'error');
    return;
  }
  let tag = '';
  let favOnly = false;
  const search = h('input', { type: 'search', placeholder: '名前やタグで検索', spellcheck: false });
  const tags = h('div', { class: 'segmented wrap' });
  const grid = h('div', { class: 'library-grid' });
  const status = h('div', { class: 'catalog-status' });

  const allTags = () => [...new Set(data.icons.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b));
  const renderTags = () =>
    tags.replaceChildren(
      h('button', { type: 'button', class: !tag && !favOnly ? 'active' : '', onclick: () => { tag = ''; favOnly = false; render(); } }, 'すべて'),
      h('button', { type: 'button', class: favOnly ? 'active' : '', onclick: () => { favOnly = !favOnly; render(); } }, 'お気に入り'),
      ...allTags().map((t) => h('button', { type: 'button', class: t === tag ? 'active' : '', onclick: () => { tag = tag === t ? '' : t; render(); } }, t)),
    );

  const pick = async (icon: LibraryIconDto) => {
    if (!onPick) return;
    const detail = await invoke('library.get', { id: icon.id });
    if (!detail) return;
    modal.close();
    onPick(detail);
  };

  const edit = async (icon: LibraryIconDto) => {
    const name = h('input', { type: 'text', value: icon.name });
    const tagInput = h('input', { type: 'text', value: icon.tags.join(', '), placeholder: 'カンマ区切り' });
    const m = openModal('アイコンの情報', h('div', { class: 'settings' }, h('label', null, '名前', name), h('label', null, 'タグ', tagInput)), {
      footer: [
        h('button', { type: 'button', onclick: () => m.close() }, 'キャンセル'),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: async () => {
            await invoke('library.update', { id: icon.id, name: name.value, tags: tagInput.value.split(/[,、]/) });
            icon.name = name.value.trim() || icon.name;
            icon.tags = tagInput.value.split(/[,、]/).map((t) => t.trim()).filter(Boolean);
            m.close();
            render();
          },
        }, '保存'),
      ],
    });
  };

  const remove = async (icon: LibraryIconDto) => {
    const r = await ask('アイコンを削除', `ライブラリから「${icon.name}」を削除します。共有フォルダの場合は、ほかの人のライブラリからも消えます。`, [
      { value: 'ok', label: '削除する', primary: true },
      { value: 'cancel', label: 'キャンセル' },
    ]);
    if (r !== 'ok') return;
    await invoke('library.delete', { id: icon.id });
    data.icons = data.icons.filter((i) => i !== icon);
    render();
  };

  const render = () => {
    renderTags();
    const q = search.value.trim();
    const list = data.icons
      .filter((i) => (!tag || i.tags.includes(tag)) && (!favOnly || i.favorite))
      .map((i) => ({ i, s: q ? Math.max(fuzzyScore(q, i.name), ...i.tags.map((t) => fuzzyScore(q, t)), fuzzyScore(q, i.id)) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => Number(b.i.favorite) - Number(a.i.favorite) || b.s - a.s)
      .map((x) => x.i);
    grid.replaceChildren(
      ...list.map((icon) =>
        h(
          'div',
          { class: `library-item${onPick ? ' pickable' : ''}`, tabIndex: 0, title: [icon.name, icon.tags.join(', ')].filter(Boolean).join('\n'), onclick: () => void pick(icon), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void pick(icon) },
          h('img', { src: `data:image/png;base64,${icon.png}`, width: 32, height: 32, alt: '' }),
          h('span', { class: 'library-name' }, icon.name),
          icon.tags.length ? h('span', { class: 'library-tags' }, icon.tags.join(' ・ ')) : null,
          h(
            'span',
            { class: 'library-actions' },
            h('button', { type: 'button', class: `icon-button fav${icon.favorite ? ' on' : ''}`, title: 'お気に入り', onclick: async (e: MouseEvent) => { e.stopPropagation(); icon.favorite = await invoke('library.toggleFavorite', { id: icon.id }); render(); } }, svg(uiIcons.star)),
            h('button', { type: 'button', class: 'icon-button', title: '名前とタグ', onclick: (e: MouseEvent) => { e.stopPropagation(); void edit(icon); } }, svg(uiIcons.format)),
            h('button', { type: 'button', class: 'icon-button', title: '削除', onclick: (e: MouseEvent) => { e.stopPropagation(); void remove(icon); } }, svg(uiIcons.trash)),
          ),
        ),
      ),
    );
    status.textContent = data.icons.length === 0 ? 'ライブラリは空です。アイコンエディタの「ライブラリにも保存」で追加できます' : `${list.length} / ${data.icons.length} 件 ・ 場所：${data.root}`;
  };

  search.addEventListener('input', debounce(render, 80));
  const modal = openModal(onPick ? 'ライブラリからアイコンを選ぶ' : 'アイコンライブラリ', h('div', { class: 'catalog' }, search, tags, grid, status), { wide: true });
  search.focus();
  render();
}

/** ライブラリのアイコンを、画像として使える形にする。 */
export function detailToBlobs(d: LibraryIconDetail): { png: string; source: Blob | null } {
  const toBlob = (b64: string, type: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });
  return {
    png: `data:image/png;base64,${d.png}`,
    source: d.source ? toBlob(d.source, d.sourceContentType ?? 'application/octet-stream') : null,
  };
}
