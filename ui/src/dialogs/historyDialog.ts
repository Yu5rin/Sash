// 操作の履歴（編集メニューの「操作の履歴…」。仕様書 §18.6）。元に戻す・やり直しの一覧を並べ、押した時点へまとめて移る。
// 移った後も一覧は残し（どこまで戻したかを見ながら行き来できるように）、ストアが変わるたびに描き直す。

import { app } from '../app';
import { h } from '../dom';
import { t } from '../i18n';
import { openModal } from './modal';

/** 一覧の行。position はその行を押したときに移る位置（store.goTo に渡す値）。 */
export interface HistoryRow {
  position: number;
  label: string;
  /** いまの状態か。 */
  current: boolean;
  /** やり直しで戻れる（まだ適用していない）操作か。 */
  undone: boolean;
}

/** 履歴を、上から古い順の行にする。最初の行は記録の始まり（その時点へ戻ると、すべての操作を取り消す）。 */
export function historyRows(history: { labels: readonly string[]; index: number }): HistoryRow[] {
  return [
    { position: 0, label: t('記録の始まり'), current: history.index === 0, undone: false },
    ...history.labels.map((label, i): HistoryRow => ({ position: i + 1, label, current: history.index === i + 1, undone: i + 1 > history.index })),
  ];
}

export function openHistoryDialog(): void {
  if (!app.store) return;
  const list = h('ol', { class: 'history-list', role: 'listbox', 'aria-label': t('操作の履歴') });
  const render = () => {
    const store = app.store;
    if (!store) {
      handle.close();
      return;
    }
    const rows = historyRows(store.history());
    // 押したボタンは作り直しで消えるので、一覧にフォーカスがあったら、いまの行へ移し直す
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren(...rows.map((r) =>
      h('li', null, h('button', {
        type: 'button',
        role: 'option',
        'aria-selected': String(r.current),
        class: `history-row${r.current ? ' current' : ''}${r.undone ? ' undone' : ''}`,
        title: r.current ? t('いまの状態') : r.undone ? t('この操作までやり直す') : t('この操作の後の状態に戻す'),
        onclick: () => store.goTo(r.position),
      }, h('span', { class: 'history-num' }, String(r.position)), h('span', { class: 'history-label' }, r.label), r.current ? h('span', { class: 'badge-soft' }, t('いま')) : null))));
    const current = list.querySelector<HTMLElement>('.history-row.current');
    current?.scrollIntoView?.({ block: 'nearest' });
    if (hadFocus) current?.focus();
  };
  const body = h('div', { class: 'history-dialog' },
    h('p', { class: 'modal-message muted' }, t('押した操作の直後の状態に移ります。移った後も、元に戻す・やり直しで行き来できます。')),
    list);
  const onStore = () => {
    if (list.isConnected) render();
  };
  const handle = openModal(t('操作の履歴'), body, {
    size: 'md',
    key: 'history',
    footer: [h('button', { type: 'button', 'data-initial-focus': '', onclick: () => handle.close() }, t('閉じる'))],
    onClose: () => {
      app.off('store', onStore);
      app.off('session', onStore);
    },
  });
  render();
  // いまの行にフォーカスを置く（↑↓で選んで Enter で移れるように）
  list.querySelector<HTMLElement>('.history-row.current')?.focus();
  app.on('store', onStore);
  app.on('session', onStore);
  // ダイアログの中でも Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z）で位置を動かす。モーダルの間はアプリのショートカットが届かないため、
  // ここで受けないと説明の「元に戻す・やり直しで行き来できます」のとおりに動かない
  body.addEventListener('keydown', (e) => {
    const store = app.store;
    if (!store || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const undo = key === 'z' && !e.shiftKey;
    const redo = key === 'y' || (key === 'z' && e.shiftKey);
    if (!undo && !redo) return;
    e.preventDefault();
    e.stopPropagation();
    const { index } = store.history();
    store.goTo(index + (undo ? -1 : 1));
    list.querySelector<HTMLElement>('.history-row.current')?.focus();
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(list.querySelectorAll<HTMLElement>('.history-row'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
}
