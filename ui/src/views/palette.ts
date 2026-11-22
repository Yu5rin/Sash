// パレット。部品をキャンバスかツリーへドラッグして置く。ダブルクリックで選択中の場所に追加する。

import { app } from '../app';
import { endDrag, startDrag } from '../dnd';
import { h, svg } from '../dom';
import { kindIcon } from '../icons';
import { createElement, elementAt, ensureTabs, pathOf } from '../model';
import { canContain, elements } from '../schema';

const ITEMS: readonly string[] = [
  'tab', 'group', 'button', 'toggleButton', 'checkBox', 'splitButton', 'menu', 'dynamicMenu', 'gallery',
  'dropDown', 'comboBox', 'editBox', 'labelControl', 'separator', 'box', 'buttonGroup', 'dialogBoxLauncher',
  'menuSeparator', 'item',
];

export function mountPalette(host: HTMLElement): void {
  host.replaceChildren(
    ...ITEMS.map((tag) =>
      h(
        'li',
        {
          draggable: true,
          title: `${tag}（ダブルクリックで選択中の場所に追加）`,
          ondragstart: (e: DragEvent) => startDrag(e, { kind: 'new', tag }),
          ondragend: () => endDrag(),
          ondblclick: () => insertNearSelection(tag),
        },
        h('span', { class: 'kind-icon' }, svg(kindIcon(tag))),
        h('span', null, elements.get(tag)?.title ?? tag),
        h('span', { class: 'palette-tag' }, tag),
      ),
    ),
  );
}

/** 選択中の要素の中（置けなければ後ろ）に追加する。 */
export function insertNearSelection(tag: string): void {
  const store = app.store;
  if (!store) return;
  store.edit('canvas', (doc) => {
    const el = createElement(doc, tag);
    if (tag === 'tab') {
      const tabs = ensureTabs(doc);
      tabs.append(el);
      return pathOf(el);
    }
    let cur: Element | null = store.selection ? elementAt(doc, store.selection) : null;
    let after: Element | null = null;
    while (cur) {
      if (canContain(cur.localName, tag)) {
        cur.insertBefore(el, after?.nextElementSibling ?? null);
        return pathOf(el);
      }
      after = cur;
      cur = cur.parentElement;
    }
    // 置ける場所がなければ何もしない（履歴だけ戻す）
    return undefined;
  });
}
