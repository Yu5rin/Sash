// 下部パネル。問題、コールバック、アイコンの一覧を切り替えて表示する。

import '../styles-views.css';
import { app } from '../app';
import { copyText } from '../clipboard';
import type { Severity } from '../lint';
import { revealLine } from './xmlEditor';
import type { ToastKind } from '../shell/toast';
import { h, svg } from '../dom';
import { uiIcons } from '../icons';
import { allElements, displayName, elementAt, pathOf, suggestId, type Path } from '../model';
import { titleOf } from '../schema';
import { focusField } from './inspector';
import { insertStubs, setupRibbonHolder, vba } from '../callbacks';
import type { ImageEntry, PartStore } from '../store';
import { t } from '../i18n';
import { generateStub, type CallbackState, type CallbackStatus } from '../vba';
import { fitProblems, type FitProblem } from './ribbonFit';
import { revealInVbe, canRevealInVbe } from '../vbaReveal';
import { describeXmlError } from '../xmlError';

type Tab = 'problems' | 'callbacks' | 'images';

/** タブの並び（← → で移る順）。 */
const TABS: readonly Tab[] = ['problems', 'callbacks', 'images'];
/** 次の描き直しのあと、選んだタブにフォーカスを戻す。描き直しでボタンが作り直され、フォーカスが BODY に落ちるため。 */
let focusTabNext = false;

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
  tabsHost.setAttribute('aria-label', t('下部パネル'));
  // タブは ← → ・Home・End で移る（WAI-ARIA の tabs と同じ。選ぶと同時に表示も切り替える）
  tabsHost.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const i = TABS.indexOf(current);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    e.preventDefault();
    focusTabNext = true;
    showBottomTab(TABS[j]!);
  });
  app.on('session', render);
  app.on('problems', render);
  app.on('vba', render);
  app.on('store', (c) => {
    if (c && (c.kinds.has('doc') || c.kinds.has('images'))) render();
  });
  // キャンバスが測ったリボンの幅の見積もり（畳まれる・収まらないグループ）も問題の一覧に出す
  window.addEventListener('sash:fitreport', render);
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

const STATE_LABEL: Record<CallbackState, string> = { implemented: '実装済み', missing: '未実装', mismatch: '引数が不一致', unused: 'VBA 側にしかない' };

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
      h('span', { class: 'muted' }, vba.loading ? t('VBA を読み込んでいます…') : vba.statusMessage()),
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
                  // 何がクリップボードに入るかが分かるよう、写す雛形の 1 行目を見せる
                  title: t('コピーする内容：{line}', { line: stubOf(x).split(/\r?\n/)[0] ?? '' }),
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    copy(stubOf(x), t('{name} の雛形をコピーしました', { name: x.name }));
                  },
                }, t('雛形をコピー'))
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
            x.procedure && canRevealInVbe(x.name) ? h('button', { type: 'button', class: 'small', onclick: (e: MouseEvent) => { e.stopPropagation(); void revealInVbe(x.name); } }, t('VBE で開く')) : null,
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
    h('button', {
      type: 'button',
      role: 'tab',
      id: `bottom-tab-${id}`,
      class: current === id ? 'active' : '',
      'aria-selected': String(current === id),
      'aria-controls': 'bottom-body',
      // 選んでいるタブだけが Tab で止まる（残りは ← → で移る）
      tabIndex: current === id ? 0 : -1,
      onclick: () => {
        focusTabNext = true;
        showBottomTab(id);
      },
    }, label);
  const syncError = store?.syncError ?? null;
  // キャンバスで測った幅の問題。今の文書にない要素を指すもの（測る前の古い結果）は出さない
  const fit: FitProblem[] = store ? fitProblems().filter((p) => elementAt(store.doc, p.path)?.localName === 'group') : [];
  const count = (sev: Severity) => app.problems.filter((p) => p.severity === sev).length + fit.filter((p) => p.severity === sev).length + (sev === 'error' && syncError ? 1 : 0);
  const errorCount = count('error');
  const warnCount = count('warning');
  const infoCount = count('info');
  const badge = (sev: Severity, n: number) => (n ? h('span', { class: `count-badge ${sev}`, title: t({ error: 'エラー {n}', warning: '警告 {n}', info: '情報 {n}' }[sev], { n }) }, String(n)) : null);
  const hadTabFocus = focusTabNext || tabsHost.contains(document.activeElement);
  focusTabNext = false;
  tabsHost.replaceChildren(
    tab('problems', [h('span', null, t('問題')), badge('error', errorCount), badge('warning', warnCount), badge('info', infoCount)].filter((x): x is HTMLElement => x !== null)),
    tab('callbacks', t('コールバック {n}', { n: callbacks.length }) + (vba.status === 'ok' && cbIssues ? t('（要対応 {n}）', { n: cbIssues }) : '')),
    tab('images', t('アイコン {n}', { n: images.length }) + (unused.length ? t('（未使用 {n}）', { n: unused.length }) : '')),
  );

  body.setAttribute('aria-labelledby', `bottom-tab-${current}`);
  if (hadTabFocus) tabsHost.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();

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
        // 0 件の種類は隠すものがないので押せない
        disabled: n === 0,
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
        }, svg(uiIcons.error), h('span', { class: 'msg' }, t('XML の構文エラー：{message}', { message: describeXmlError(syncError.message) })), h('span', { class: 'where' }, syncError.line ? t('{line}行目', { line: syncError.line }) : '')),
      );
    }
    const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    const list = [...app.problems, ...fit].filter((p) => shown.has(p.severity)).sort((a, b) => order[a.severity] - order[b.severity]);
    for (const p of list) {
      const el = elementAt(store.doc, p.path);
      const go = () => store.select(p.path, 'other');
      const isFit = fit.includes(p as FitProblem);
      // 「対象のラベル（種類）：文」の順で左に寄せる。どの要素の話かを先に読めるように
      const name = el ? displayName(el) : '';
      const kind = el ? titleOf(el.localName) : '';
      const text = !el ? p.message : name ? t('{name}（{kind}）：{message}', { name, kind, message: p.message }) : t('{kind}：{message}', { kind, message: p.message });
      items.push(
        h('li', {
          class: `problem ${p.severity}${isFit ? ' fit' : ''}`,
          title: isFit ? t('キャンバスで測った幅からの見積もりです（実機の Excel と異なる場合があります）') : text,
          tabIndex: 0,
          role: 'button',
          onclick: go,
          onkeydown: (e: KeyboardEvent) => e.target === e.currentTarget && e.key === 'Enter' && go(),
        }, svg(uiIcons[p.severity]), h('span', { class: 'msg' }, text), isFit || !('attr' in p) ? null : fixAction(store, p.path, p.attr)),
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

/**
 * 問題の行の右端に出す操作。直し方が決まるものだけ（長いラベル → ラベルを編集、id の重複 → 振り直す）。
 * 規則の名前は Problem にないので、問題のある属性と文書の中身から判断する（文言には頼らない）。
 */
function fixAction(store: PartStore, path: Path, attr: string | undefined): HTMLElement | null {
  const el = elementAt(store.doc, path);
  if (!el) return null;
  if (attr === 'label') {
    return h('button', {
      type: 'button',
      class: 'small problem-fix',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        store.select(path, 'other');
        focusField('label');
      },
    }, t('ラベルを編集'));
  }
  const id = attr === 'id' ? el.getAttribute('id') : null;
  if (id && allElements(store.doc).filter((x) => x.getAttribute('id') === id).length > 1) {
    return h('button', {
      type: 'button',
      class: 'small problem-fix',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        // 新しい id は編集の前に決める（履歴の名前に入れるため）。ほかで使っている id は避ける
        const used = new Set(allElements(store.doc).map((x) => x.getAttribute('id')).filter((v): v is string => !!v));
        const next = suggestId(el.localName, el.getAttribute('label'), used);
        store.edit('other', (doc) => {
          const target = elementAt(doc, path);
          if (!target) return undefined;
          target.setAttribute('id', next);
          return undefined;
        }, t('{attr} を「{value}」に変更', { attr: 'id', value: next }));
      },
    }, t('ID を振り直す'));
  }
  return null;
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
