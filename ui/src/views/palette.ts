// パレット。部品をキャンバスかツリーへドラッグして置く。ダブルクリックで選択中の場所に追加する。

import { app } from '../app';
import { endDrag, startDrag } from '../dnd';
import { h, svg } from '../dom';
import { kindIcon } from '../icons';
import { createElement, elementAt, ensureBackstage, ensureContextMenus, ensureTabs, pathOf } from '../model';
import { canContainEl, inBackstage, titleOf } from '../schema';
import { t } from '../i18n';

export const PALETTE_ITEMS: readonly string[] = [
  'tab', 'group', 'button', 'toggleButton', 'checkBox', 'splitButton', 'menu', 'dynamicMenu', 'gallery',
  'dropDown', 'comboBox', 'editBox', 'labelControl', 'separator', 'box', 'buttonGroup', 'dialogBoxLauncher',
  'menuSeparator', 'item', 'contextMenu',
  'backstage', 'taskGroup', 'taskFormGroup', 'hyperlink', 'imageControl', 'groupBox', 'layoutContainer', 'radioGroup',
];

export function mountPalette(host: HTMLElement): void {
  host.replaceChildren(
    ...PALETTE_ITEMS.map((tag) =>
      h(
        'li',
        {
          draggable: true,
          title: t('{tag}（ダブルクリックで選択中の場所に追加）', { tag }),
          ondragstart: (e: DragEvent) => startDrag(e, { kind: 'new', tag }),
          ondragend: () => endDrag(),
          ondblclick: () => insertNearSelection(tag),
        },
        h('span', { class: 'kind-icon' }, svg(kindIcon(tag))),
        h('span', null, titleOf(tag)),
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
    const selected = store.selection ? elementAt(doc, store.selection) : null;
    if (tag === 'backstage') {
      const existing = doc.documentElement.querySelector(':scope > backstage');
      if (existing) return pathOf(existing);
      const bs = createElement(doc, 'backstage');
      const placeholder = ensureBackstage(doc);
      placeholder.replaceWith(bs);
      return pathOf(bs);
    }
    const el = createElement(doc, tag, inBackstage(selected) ? selected : null);
    if (tag === 'tab' && !inBackstage(selected)) {
      const tabs = ensureTabs(doc);
      tabs.append(el);
      return pathOf(el);
    }
    if (tag === 'contextMenu') {
      ensureContextMenus(doc).append(el);
      return pathOf(el);
    }
    let cur: Element | null = selected;
    let after: Element | null = null;
    while (cur) {
      if (canContainEl(cur, tag)) {
        // 置く場所に合った定義で作り直す（Backstage の中かどうかで中身が変わるため）
        const placed = createElement(doc, tag, cur);
        cur.insertBefore(placed, after?.nextElementSibling ?? null);
        return pathOf(placed);
      }
      after = cur;
      cur = cur.parentElement;
    }
    // 置ける場所がなければ何もしない（履歴だけ戻す）
    return undefined;
  });
}
