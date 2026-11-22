// 下部パネル。問題、コールバック、アイコンの一覧を切り替えて表示する。

import { app } from '../app';
import { h, svg } from '../dom';
import { uiIcons } from '../icons';
import { allElements, displayName, elementAt, pathOf } from '../model';
import { insertStubs, setupRibbonHolder, vba } from '../callbacks';
import type { ImageEntry, PartStore } from '../store';
import { t } from '../i18n';
import { generateStub, type CallbackState, type CallbackStatus } from '../vba';

type Tab = 'problems' | 'callbacks' | 'images';

let current: Tab = 'problems';

let openIcon: (existing?: ImageEntry) => void = () => undefined;

export function mountBottom(tabsHost: HTMLElement, body: HTMLElement, toast: (msg: string, kind?: 'info' | 'error') => void, iconEditor: (existing?: ImageEntry) => void): void {
  openIcon = iconEditor;
  const render = () => renderBottom(tabsHost, body, toast);
  app.on('session', render);
  app.on('problems', render);
  app.on('vba', render);
  app.on('store', (c) => {
    if (c && (c.kinds.has('doc') || c.kinds.has('images'))) render();
  });
}

export function showBottomTab(tab: Tab): void {
  current = tab;
  app.emit('problems');
}


function imageUses(doc: Document): Map<string, Element[]> {
  const map = new Map<string, Element[]>();
  for (const el of allElements(doc)) {
    const id = el.getAttribute('image');
    if (id) map.set(id, [...(map.get(id) ?? []), el]);
  }
  return map;
}

const STATE_LABEL: Record<CallbackState, string> = { implemented: '実装済み', missing: '未実装', mismatch: '引数が不一致', unused: 'VBA側にしかない' };

function renderCallbacks(store: PartStore, toast: (msg: string, kind?: 'info' | 'error') => void): HTMLElement {
  const statuses = vba.statuses();
  const missing = statuses.filter((x) => x.state === 'missing' && x.uses.length > 0);
  const run = (p: Promise<string>) => void p.then((m) => toast(m)).catch((e: Error) => toast(e.message, 'error'));
  const copy = (text: string, msg: string) => void navigator.clipboard.writeText(text).then(() => toast(msg));
  const stubOf = (x: CallbackStatus) => generateStub({ ...x, name: x.name.replace(/^.*[.!]/, '') });

  return h(
    'ul',
    { class: 'panel-list' },
    h(
      'li',
      { class: 'panel-actions' },
      h('span', { class: 'muted' }, vba.loading ? t('VBAを読み込んでいます…') : vba.statusMessage()),
      h(
        'span',
        { class: 'actions' },
        app.info.excelInstalled ? h('button', { type: 'button', class: 'small', onclick: () => void vba.refresh() }, t('再読み込み')) : null,
        missing.length ? h('button', { type: 'button', class: 'small', onclick: () => copy(missing.map(stubOf).join('\r\n'), t('{n} 件の雛形をコピーしました', { n: missing.length })) }, t('未実装をコピー')) : null,
        missing.length && vba.canWrite ? h('button', { type: 'button', class: 'small primary', onclick: () => run(insertStubs(statuses)) }, t('未実装 {n} 件をモジュールに挿入', { n: missing.length })) : null,
        h('button', { type: 'button', class: 'small', title: t('onLoad で IRibbonUI を保持し、Invalidate できるようにする雛形（仕様書 §8.3）'), onclick: () => run(setupRibbonHolder()) }, t('onLoad と Invalidate の雛形')),
      ),
    ),
    statuses.length === 0
      ? h('li', { class: 'panel-empty' }, t('コールバックはありません'))
      : statuses.map((x) =>
          h(
            'li',
            { class: 'callback', onclick: () => x.uses[0] && store.select(x.uses[0].path, 'other') },
            h('span', { class: `cb-state ${vba.status === 'ok' || x.state === 'unused' ? x.state : 'none'}`, title: x.reason ?? '' }, vba.status === 'ok' || x.state === 'unused' ? t(STATE_LABEL[x.state]) : t('照合なし')),
            h('code', null, x.name),
            x.reason ? h('span', { class: 'muted small' }, x.reason) : null,
            h('span', { class: 'where' }, x.uses.length ? x.uses.map((u) => `${u.id}.${u.attr}`).join(', ') : x.procedure ? t('{module} {line}行目', { module: x.procedure.module, line: x.procedure.line }) : ''),
            x.uses.length
              ? h('button', {
                  type: 'button',
                  class: 'small',
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    copy(stubOf(x), t('{name} の雛形をコピーしました', { name: x.name }));
                  },
                }, t('コピー'))
              : null,
            x.state === 'missing' && vba.canWrite
              ? h('button', {
                  type: 'button',
                  class: 'small',
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    run(insertStubs([x]));
                  },
                }, t('挿入'))
              : null,
          ),
        ),
  );
}

function renderBottom(tabsHost: HTMLElement, body: HTMLElement, toast: (msg: string, kind?: 'info' | 'error') => void): void {
  const store = app.store;
  const errors = app.problems.filter((p) => p.severity === 'error').length;
  const callbacks = store ? vba.statuses() : [];
  const cbIssues = callbacks.filter((x) => x.state === 'missing' || x.state === 'mismatch').length;
  const uses = store ? imageUses(store.doc) : new Map<string, Element[]>();
  const images = store ? [...store.images.values()] : [];
  const unused = images.filter((i) => !uses.has(i.id));

  const tab = (id: Tab, label: string) =>
    h('button', { type: 'button', role: 'tab', class: current === id ? 'active' : '', 'aria-selected': String(current === id), onclick: () => showBottomTab(id) }, label);
  tabsHost.replaceChildren(
    tab('problems', t('問題 {n}', { n: app.problems.length }) + (errors ? t('（エラー {n}）', { n: errors }) : '')),
    tab('callbacks', t('コールバック {n}', { n: callbacks.length }) + (vba.status === 'ok' && cbIssues ? t('（要対応 {n}）', { n: cbIssues }) : '')),
    tab('images', t('アイコン {n}', { n: images.length }) + (unused.length ? t('（未使用 {n}）', { n: unused.length }) : '')),
  );

  if (!store) {
    body.replaceChildren();
    return;
  }

  if (current === 'problems') {
    body.replaceChildren(
      app.problems.length === 0
        ? h('div', { class: 'panel-empty' }, t('問題はありません'))
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
    body.replaceChildren(renderCallbacks(store, toast));
  } else {
    body.replaceChildren(
      images.length === 0
        ? h('div', { class: 'panel-empty' }, t('ファイルに画像はありません。インスペクタの「アイコン」から作れます'), ' ', h('button', { type: 'button', class: 'small', onclick: () => openIcon() }, t('画像を取り込む')))
        : h(
            'ul',
            { class: 'panel-list images' },
            h('li', { class: 'panel-actions' }, h('span', { class: 'muted' }, t('コントロールに設定せずに画像だけを作るときや、フォルダから一括で取り込むときはこちら')), h('button', { type: 'button', class: 'small', onclick: () => openIcon() }, t('画像を取り込む'))),
            unused.length
              ? h('li', { class: 'panel-actions' }, h('span', { class: 'muted' }, t('どのコントロールからも使われていない画像が {n} 個あります', { n: unused.length })), h('button', { type: 'button', class: 'small', onclick: () => store.removeImages(unused.map((u) => u.id)) }, t('未使用をすべて削除')))
              : null,
            images.map((img) => {
              const users = uses.get(img.id) ?? [];
              return h(
                'li',
                { class: 'image-row', onclick: () => users[0] && store.select(pathOf(users[0]), 'other') },
                h('img', { src: img.dataUrl, width: 32, height: 32, alt: '' }),
                h('code', null, img.id),
                h('span', { class: 'where' }, users.length ? users.map((u) => u.getAttribute('id') ?? u.localName).join(', ') : t('未使用')),
                img.isNew ? h('span', { class: 'tag' }, t('未保存')) : null,
                img.edit
                  ? h('button', {
                      type: 'button',
                      class: 'small',
                      onclick: (e: MouseEvent) => {
                        e.stopPropagation();
                        openIcon(img);
                      },
                    }, t('加工し直す'))
                  : null,
                h('button', {
                  type: 'button',
                  class: 'icon-button',
                  title: t('削除'),
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
