// 下部パネル。問題、コールバック、アイコンの一覧を切り替えて表示する。

import { app } from '../app';
import { h, svg } from '../dom';
import { uiIcons } from '../icons';
import { allElements, displayName, elementAt, pathOf } from '../model';
import { attributes, callbackSignature } from '../schema';

type Tab = 'problems' | 'callbacks' | 'images';

let current: Tab = 'problems';

export function mountBottom(tabsHost: HTMLElement, body: HTMLElement, toast: (msg: string) => void): void {
  const render = () => renderBottom(tabsHost, body, toast);
  app.on('session', render);
  app.on('problems', render);
  app.on('store', (c) => {
    if (c && (c.kinds.has('doc') || c.kinds.has('images'))) render();
  });
}

export function showBottomTab(tab: Tab): void {
  current = tab;
  app.emit('problems');
}

interface CallbackUse {
  name: string;
  uses: { attr: string; el: Element }[];
}

function collectCallbacks(doc: Document): CallbackUse[] {
  const map = new Map<string, CallbackUse>();
  for (const el of allElements(doc)) {
    for (const at of Array.from(el.attributes)) {
      if (attributes.get(at.name)?.kind !== 'callback') continue;
      const entry = map.get(at.value) ?? { name: at.value, uses: [] };
      entry.uses.push({ attr: at.name, el });
      map.set(at.value, entry);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function imageUses(doc: Document): Map<string, Element[]> {
  const map = new Map<string, Element[]>();
  for (const el of allElements(doc)) {
    const id = el.getAttribute('image');
    if (id) map.set(id, [...(map.get(id) ?? []), el]);
  }
  return map;
}

/** VBA の雛形（仕様書 §8.1 のシグネチャ）。 */
function stub(cb: CallbackUse): string {
  const first = cb.uses[0]!;
  return `Public Sub ${cb.name}(${callbackSignature(first.attr, first.el.localName)})\n    ' TODO: ${cb.uses.map((u) => `${u.el.getAttribute('id') ?? u.el.localName}.${u.attr}`).join(', ')}\nEnd Sub\n`;
}

function renderBottom(tabsHost: HTMLElement, body: HTMLElement, toast: (msg: string) => void): void {
  const store = app.store;
  const errors = app.problems.filter((p) => p.severity === 'error').length;
  const callbacks = store ? collectCallbacks(store.doc) : [];
  const uses = store ? imageUses(store.doc) : new Map<string, Element[]>();
  const images = store ? [...store.images.values()] : [];
  const unused = images.filter((i) => !uses.has(i.id));

  const tab = (id: Tab, label: string) =>
    h('button', { type: 'button', role: 'tab', class: current === id ? 'active' : '', 'aria-selected': String(current === id), onclick: () => showBottomTab(id) }, label);
  tabsHost.replaceChildren(
    tab('problems', `問題 ${app.problems.length}${errors ? `（エラー ${errors}）` : ''}`),
    tab('callbacks', `コールバック ${callbacks.length}`),
    tab('images', `アイコン ${images.length}${unused.length ? `（未使用 ${unused.length}）` : ''}`),
  );

  if (!store) {
    body.replaceChildren();
    return;
  }

  if (current === 'problems') {
    body.replaceChildren(
      app.problems.length === 0
        ? h('div', { class: 'panel-empty' }, '問題はありません')
        : h(
            'ul',
            { class: 'panel-list' },
            app.problems.map((p) => {
              const el = elementAt(store.doc, p.path);
              return h(
                'li',
                { class: `problem ${p.severity}`, onclick: () => store.select(p.path, 'other') },
                svg(uiIcons[p.severity]),
                h('span', { class: 'msg' }, p.message),
                h('span', { class: 'where' }, el ? `<${el.localName}> ${displayName(el)}` : ''),
              );
            }),
          ),
    );
  } else if (current === 'callbacks') {
    body.replaceChildren(
      callbacks.length === 0
        ? h('div', { class: 'panel-empty' }, 'コールバックはありません')
        : h(
            'ul',
            { class: 'panel-list' },
            h(
              'li',
              { class: 'panel-actions' },
              h('span', { class: 'muted' }, 'VBAとの照合と挿入は第2弾で対応します。雛形はコピーして使えます'),
              h('button', {
                type: 'button',
                class: 'small',
                onclick: () => {
                  void navigator.clipboard.writeText(callbacks.map(stub).join('\n')).then(() => toast('すべての雛形をコピーしました'));
                },
              }, 'すべての雛形をコピー'),
            ),
            callbacks.map((cb) =>
              h(
                'li',
                { class: 'callback', onclick: () => store.select(pathOf(cb.uses[0]!.el), 'other') },
                h('code', null, cb.name),
                h('span', { class: 'where' }, cb.uses.map((u) => `${u.el.getAttribute('id') ?? u.el.localName}.${u.attr}`).join(', ')),
                h('button', {
                  type: 'button',
                  class: 'small',
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(stub(cb)).then(() => toast(`${cb.name} の雛形をコピーしました`));
                  },
                }, 'コピー'),
              ),
            ),
          ),
    );
  } else {
    body.replaceChildren(
      images.length === 0
        ? h('div', { class: 'panel-empty' }, 'ファイルに画像はありません。インスペクタの「アイコン」から作れます')
        : h(
            'ul',
            { class: 'panel-list images' },
            unused.length
              ? h('li', { class: 'panel-actions' }, h('span', { class: 'muted' }, `どのコントロールからも使われていない画像が ${unused.length} 個あります`), h('button', { type: 'button', class: 'small', onclick: () => store.removeImages(unused.map((u) => u.id)) }, '未使用をすべて削除'))
              : null,
            images.map((img) => {
              const users = uses.get(img.id) ?? [];
              return h(
                'li',
                { class: 'image-row', onclick: () => users[0] && store.select(pathOf(users[0]), 'other') },
                h('img', { src: img.dataUrl, width: 32, height: 32, alt: '' }),
                h('code', null, img.id),
                h('span', { class: 'where' }, users.length ? users.map((u) => u.getAttribute('id') ?? u.localName).join(', ') : '未使用'),
                img.isNew ? h('span', { class: 'tag' }, '未保存') : null,
                h('button', {
                  type: 'button',
                  class: 'icon-button',
                  title: '削除',
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    store.removeImages([img.id]);
                  },
                }, svg(uiIcons.trash)),
              );
            }),
          ),
    );
  }
}
