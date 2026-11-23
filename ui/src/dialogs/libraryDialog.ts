// アイコンライブラリ（仕様書 §6.4、第3弾）。加工済みのアイコンを検索して、別のブックでも使い回す。

import type { ToastKind } from '../shell/toast';
import { invoke, type LibraryIconDetail, type LibraryIconDto } from '../bridge';
import { app } from '../app';
import { debounce, h, svg } from '../dom';
import { uiIcons } from '../icons';
import { fuzzyScore } from '../catalog/catalog';
import { ask, openModal } from './modal';
import { t as tr } from '../i18n';

export type LibraryPick = (icon: LibraryIconDetail) => void;

export interface LibraryOptions {
  /** 閉じたときに呼ぶ。picked はアイコンを選んだか（取り消したときに呼び出し元の表示を戻すため）。 */
  onClose?: (picked: boolean) => void;
}

let opening = false;

/** 開く。onPick を渡すと、クリックでそのアイコンを選んで閉じる（渡さなければ管理だけ）。 */
export async function openLibrary(onPick?: LibraryPick, toast?: (m: string, k?: ToastKind) => void, opts: LibraryOptions = {}): Promise<void> {
  // 読み込み中にもう一度押されても、2つ開かないようにする
  if (opening || document.querySelector('.modal .library-grid')) return;
  opening = true;
  let data: { root: string; icons: LibraryIconDto[] };
  try {
    data = await invoke('library.list');
  } catch (e) {
    toast?.((e as Error).message, 'error');
    opts.onClose?.(false);
    return;
  } finally {
    opening = false;
  }
  let picked = false;
  /** 失敗したら知らせる（ホストの呼び出しは共有フォルダの権限などで失敗しうる）。 */
  const guard = async (p: () => Promise<void>) => {
    try {
      await p();
    } catch (e) {
      toast?.((e as Error).message, 'error');
    }
  };
  let tag = '';
  let favOnly = false;
  const search = h('input', { type: 'search', placeholder: tr('名前やタグで検索'), spellcheck: false });
  const tags = h('div', { class: 'segmented wrap library-filter' });
  const grid = h('div', { class: 'library-grid' });
  const status = h('div', { class: 'catalog-status' });
  // 空のときに検索欄・切り替え・空の格子を並べても意味がないので、代わりに次の一手を示す
  const emptyState = buildEmptyState(() => modal.close(), !!onPick);

  const allTags = () => [...new Set(data.icons.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b));
  const renderTags = () =>
    tags.replaceChildren(
      h('button', { type: 'button', class: !tag && !favOnly ? 'active' : '', onclick: () => { tag = ''; favOnly = false; render(); } }, tr('すべて')),
      h('button', { type: 'button', class: favOnly ? 'active' : '', onclick: () => { favOnly = !favOnly; render(); } }, tr('お気に入り')),
      ...allTags().map((t) => h('button', { type: 'button', class: t === tag ? 'active' : '', onclick: () => { tag = tag === t ? '' : t; render(); } }, t)),
    );

  const pick = (icon: LibraryIconDto) =>
    guard(async () => {
      if (!onPick) return;
      const detail = await invoke('library.get', { id: icon.id });
      if (!detail) return;
      picked = true;
      modal.close();
      onPick(detail);
    });

  const edit = async (icon: LibraryIconDto) => {
    const name = h('input', { type: 'text', value: icon.name });
    const tagInput = h('input', { type: 'text', value: icon.tags.join(', '), placeholder: tr('カンマ区切り') });
    const m = openModal(tr('アイコンの情報'), h('div', { class: 'settings' }, h('label', null, tr('名前'), name), h('label', null, tr('タグ'), tagInput)), {
      footer: [
        h('button', { type: 'button', onclick: () => m.close() }, tr('キャンセル')),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: () =>
            void guard(async () => {
              await invoke('library.update', { id: icon.id, name: name.value, tags: tagInput.value.split(/[,、]/) });
              icon.name = name.value.trim() || icon.name;
              icon.tags = tagInput.value.split(/[,、]/).map((t) => t.trim()).filter(Boolean);
              m.close();
              render();
            }),
        }, tr('保存')),
      ],
    });
  };

  const remove = async (icon: LibraryIconDto) => {
    const r = await ask(tr('アイコンを削除'), tr('ライブラリから「{name}」を削除します。共有フォルダの場合は、ほかの人のライブラリからも消えます。', { name: icon.name }), [
      { value: 'ok', label: tr('削除する'), primary: true },
      { value: 'cancel', label: tr('キャンセル') },
    ]);
    if (r !== 'ok') return;
    await guard(async () => {
      await invoke('library.delete', { id: icon.id });
      data.icons = data.icons.filter((i) => i !== icon);
      render();
    });
  };

  const render = () => {
    const empty = data.icons.length === 0;
    search.hidden = empty;
    tags.hidden = empty;
    grid.hidden = empty;
    emptyState.hidden = !empty;
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
          { class: `library-item${onPick ? ' pickable' : ''}`, tabIndex: 0, title: [icon.name, icon.tags.join(', ')].filter(Boolean).join('\n'), dataset: { id: icon.id }, onclick: () => void pick(icon), onkeydown: (e: KeyboardEvent) => !e.isComposing && e.key === 'Enter' && e.target === e.currentTarget && void pick(icon) },
          h('img', { src: `data:image/png;base64,${icon.png}`, width: 32, height: 32, alt: '' }),
          h('span', { class: 'library-name' }, icon.name),
          icon.tags.length ? h('span', { class: 'library-tags' }, icon.tags.join(' ・ ')) : null,
          h(
            'span',
            { class: 'library-actions' },
            h('button', { type: 'button', class: `icon-button fav${icon.favorite ? ' on' : ''}`, title: tr('お気に入り'), onclick: (e: MouseEvent) => { e.stopPropagation(); void guard(async () => { icon.favorite = await invoke('library.toggleFavorite', { id: icon.id }); render(); }); } }, svg(uiIcons.star)),
            h('button', { type: 'button', class: 'icon-button', title: tr('名前とタグ'), onclick: (e: MouseEvent) => { e.stopPropagation(); void edit(icon); } }, svg(uiIcons.format)),
            h('button', { type: 'button', class: 'icon-button', title: tr('削除'), onclick: (e: MouseEvent) => { e.stopPropagation(); void remove(icon); } }, svg(uiIcons.trash)),
          ),
        ),
      ),
    );
    status.textContent = empty ? tr('場所：{root}', { root: data.root }) : tr('{shown} / {total} 件 ・ 場所：{root}', { shown: list.length, total: data.icons.length, root: data.root });
  };

  search.addEventListener('input', debounce(render, 120));
  search.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      grid.querySelector<HTMLElement>('.library-item')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      grid.querySelector<HTMLElement>('.library-item')?.click();
    }
  });
  // 格子の中は矢印キーで移る（1行の個数は、上端の位置が同じものを数える）
  grid.addEventListener('keydown', (e) => {
    const items = Array.from(grid.querySelectorAll<HTMLElement>('.library-item'));
    const idx = items.indexOf(e.target as HTMLElement);
    if (idx < 0) return;
    const top = items[0]!.offsetTop;
    const cols = Math.max(1, items.findIndex((x) => x.offsetTop !== top) < 0 ? items.length : items.findIndex((x) => x.offsetTop !== top));
    const delta = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>)[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = idx + delta;
    if (next < 0) search.focus();
    else items[Math.min(next, items.length - 1)]?.focus();
  });
  const modal = openModal(onPick ? tr('ライブラリからアイコンを選ぶ') : tr('アイコンライブラリ'), h('div', { class: 'catalog' }, search, tags, grid, emptyState, status), { wide: true, onClose: () => opts.onClose?.(picked) });
  render();
  // 空のときは検索欄が隠れているので、押せるボタンか、なければ閉じるボタンの側にフォーカスを任せる
  if (!search.hidden) search.focus();
}

/**
 * ライブラリが空のときの案内。アイコンを作る入口をここに置く（作ったあと「ライブラリにも保存」で入る）。
 * 要素を選んでいないとアイコンエディタの対象がないので、無効にして理由を添える。
 * 選ぶ目的で開いた場合（onPick あり）は、作る入口を出さず説明だけにする。
 */
export function buildEmptyState(closeLibrary: () => void, picking: boolean): HTMLElement {
  const sel = app.store?.selection ?? null;
  const reason = tr('先にキャンバスかツリーで、アイコンを付けるボタンなどを選んでください');
  const box = h('div', { class: 'library-empty' },
    h('p', { class: 'library-empty-title' }, tr('ライブラリは空です')),
    h('p', { class: 'muted' }, tr('アイコンエディタで作ったアイコンを「ライブラリにも保存」すると、ここに並び、ほかのブックでも使えます。')));
  if (!picking) {
    box.append(h('button', {
      type: 'button',
      class: 'primary',
      disabled: !sel,
      title: sel ? null : reason,
      onclick: () => {
        closeLibrary();
        // 循環参照を避けるため、アイコンエディタは押されたときに読み込む
        void import('../icon/iconDialog').then((m) => m.openIconDialog(sel));
      },
    }, tr('アイコンを作る…')));
    if (!sel) box.append(h('p', { class: 'muted library-empty-reason' }, reason));
  }
  return box;
}

/** ライブラリのアイコンを、画像として使える形にする。 */
export function detailToBlobs(d: LibraryIconDetail): { png: string; source: Blob | null } {
  const toBlob = (b64: string, type: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });
  return {
    png: `data:image/png;base64,${d.png}`,
    source: d.source ? toBlob(d.source, d.sourceContentType ?? 'application/octet-stream') : null,
  };
}
