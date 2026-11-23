// 下部パネル。問題、コールバック、アイコンの一覧を切り替えて表示する。

import '../styles-views.css';
import { app } from '../app';
import { copyText } from '../clipboard';
import type { Severity } from '../lint';
import { revealLine } from './xmlEditor';
import type { ToastKind } from '../shell/toast';
import { h, svg } from '../dom';
import { uiIcons } from '../icons';
import { allElements, displayName, elementAt, pathOf } from '../model';
import { insertStubs, setupRibbonHolder, vba } from '../callbacks';
import type { ImageEntry, PartStore } from '../store';
import { t } from '../i18n';
import { generateStub, type CallbackState, type CallbackStatus } from '../vba';

type Tab = 'problems' | 'callbacks' | 'images';

let current: Tab = 'problems';
/** 問題の一覧に出す重大度。 */
const shown = new Set<Severity>(['error', 'warning', 'info']);
let bodyEl: HTMLElement | null = null;

/** 下部パネルにフォーカスを移す（F6）。一覧の最初の項目、なければタブ。 */
export function focus(): void {
  const first = bodyEl?.querySelector<HTMLElement>('[tabindex="0"], button');
  if (first) first.focus();
  else (document.querySelector<HTMLElement>('#bottom-tabs [aria-selected="true"]') ?? bodyEl)?.focus();
}

let openIcon: (existing?: ImageEntry) => void = () => undefined;

export function mountBottom(tabsHost: HTMLElement, body: HTMLElement, toast: (msg: string, kind?: ToastKind) => void, iconEditor: (existing?: ImageEntry) => void): void {
  openIcon = iconEditor;
  bodyEl = body;
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

function renderCallbacks(store: PartStore, toast: (msg: string, kind?: ToastKind) => void): HTMLElement {
  const statuses = vba.statuses();
  const missing = statuses.filter((x) => x.state === 'missing' && x.uses.length > 0);
  const run = (p: Promise<string>) => void p.then((m) => toast(m)).catch((e: Error) => toast(e.message, 'error'));
  // 失敗したとき（WebView2 でフォーカスがないときなど）も黙らずに知らせる（不具合 27）
  const copy = (text: string, msg: string) => copyText(text, msg);
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

function renderBottom(tabsHost: HTMLElement, body: HTMLElement, toast: (msg: string, kind?: ToastKind) => void): void {
  const store = app.store;
  const callbacks = store ? vba.statuses() : [];
  const cbIssues = callbacks.filter((x) => x.state === 'missing' || x.state === 'mismatch').length;
  const uses = store ? imageUses(store.doc) : new Map<string, Element[]>();
  const images = store ? [...store.images.values()] : [];
  const unused = images.filter((i) => !uses.has(i.id));

  const tab = (id: Tab, label: string | HTMLElement[]) =>
    h('button', { type: 'button', role: 'tab', class: current === id ? 'active' : '', 'aria-selected': String(current === id), onclick: () => showBottomTab(id) }, label);
  const syncError = store?.syncError ?? null;
  const count = (sev: Severity) => app.problems.filter((p) => p.severity === sev).length + (sev === 'error' && syncError ? 1 : 0);
  const errorCount = count('error');
  const warnCount = count('warning');
  const infoCount = count('info');
  const badge = (sev: Severity, n: number) => (n ? h('span', { class: `count-badge ${sev}`, title: t({ error: 'エラー {n}', warning: '警告 {n}', info: '情報 {n}' }[sev], { n }) }, String(n)) : null);
  tabsHost.replaceChildren(
    tab('problems', [h('span', null, t('問題')), badge('error', errorCount), badge('warning', warnCount), badge('info', infoCount)].filter((x): x is HTMLElement => x !== null)),
    tab('callbacks', t('コールバック {n}', { n: callbacks.length }) + (vba.status === 'ok' && cbIssues ? t('（要対応 {n}）', { n: cbIssues }) : '')),
    tab('images', t('アイコン {n}', { n: images.length }) + (unused.length ? t('（未使用 {n}）', { n: unused.length }) : '')),
  );

  if (!store) {
    body.replaceChildren();
    return;
  }

  if (current === 'problems') {
    const filter = (sev: Severity, n: number) =>
      h('button', {
        type: 'button',
        class: `small filter ${sev}${shown.has(sev) ? ' active' : ''}`,
        'aria-pressed': String(shown.has(sev)),
        onclick: () => {
          if (shown.has(sev)) shown.delete(sev);
          else shown.add(sev);
          renderBottom(tabsHost, body, toast);
        },
      }, svg(uiIcons[sev]), t({ error: 'エラー {n}', warning: '警告 {n}', info: '情報 {n}' }[sev], { n }));
    const items: HTMLElement[] = [];
    // XML の構文エラーは、ほかの問題より先に出す（直すまで他のビューが止まっているため）
    if (syncError && shown.has('error')) {
      items.push(
        h('li', {
          class: 'problem error sync',
          tabIndex: 0,
          role: 'button',
          onclick: () => syncError.line && revealLine(syncError.line),
          onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && syncError.line && revealLine(syncError.line),
        }, svg(uiIcons.error), h('span', { class: 'msg' }, t('XMLの構文エラー：{message}', { message: syncError.message })), h('span', { class: 'where' }, syncError.line ? t('{line}行目', { line: syncError.line }) : '')),
      );
    }
    const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    const list = app.problems.filter((p) => shown.has(p.severity)).sort((a, b) => order[a.severity] - order[b.severity]);
    for (const p of list) {
      const el = elementAt(store.doc, p.path);
      const go = () => store.select(p.path, 'other');
      items.push(
        h('li', {
          class: `problem ${p.severity}`,
          tabIndex: 0,
          role: 'button',
          onclick: go,
          onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && go(),
        }, svg(uiIcons[p.severity]), h('span', { class: 'msg' }, p.message), h('span', { class: 'where' }, el ? `<${el.localName}> ${displayName(el)}` : '')),
      );
    }
    const total = errorCount + warnCount + infoCount;
    body.replaceChildren(
      total === 0
        ? h('div', { class: 'panel-empty ok' }, t('問題はありません'))
        : h(
            'ul',
            { class: 'panel-list problems', onkeydown: (e: KeyboardEvent) => onListKey(e) },
            h('li', { class: 'panel-actions' }, h('span', { class: 'filters', role: 'group', 'aria-label': t('重大度で絞り込む') }, filter('error', errorCount), filter('warning', warnCount), filter('info', infoCount))),
            items.length ? items : h('li', { class: 'panel-empty' }, t('絞り込みに合う問題はありません')),
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

/** 一覧の中は上下の矢印で移る。 */
function onListKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('li[tabindex]'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}
