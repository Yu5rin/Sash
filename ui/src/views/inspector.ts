// インスペクタ（仕様書 §5.4）。選んだ要素に使える属性だけを「基本」「表示」「画像」「コールバック」「詳細」に分けて出す。
// 静的な値と get 系コールバックの組は「固定 | VBA」の切り替えにまとめ、両方を同時に指定する矛盾を起こさない。
// 入力中に他のビューの変更で描き直しても、入力中の欄（文字・カーソル位置・フォーカス）はそのまま残す（不具合 5 / 6）。

import { app } from '../app';
import { defaultCallbackName, insertStubs, renameCallback, vba } from '../callbacks';
import { copyText, notify, runEdit } from '../clipboard';
import { openCatalog } from '../dialogs/catalogDialog';
import { openLibrary } from '../dialogs/libraryDialog';
import { h, svg } from '../dom';
import { applyLibraryIcon, openFluentIcons, openIconDialog } from '../icon/iconDialog';
import { kindIcon, uiIcons } from '../icons';
import { identifierOf, pathOf, samePath, setAttr, suggestId, suggestIdFromLabel, usedIds, type Path } from '../model';
import type { ImageEntry } from '../store';
import { iconTargetOf, delegatesToInner, innerButtonOf } from '../iconTarget';
import { attributes, attrsOfEl, callbackSignature, defFor, isXmlId, type AttrDef } from '../schema';
import { bareCallbackName, generateStub, type CallbackStatus } from '../vba';
import { attrValueError } from '../attrValidate';
import { lang, t } from '../i18n';
import { imageMsoNames, labels as msoLabels } from '../catalog/catalog';
import { buildSvg, DEFAULT_COLOR, displayName as fluentName, iconSet, loadIconSet, type FluentIcon } from '../fluent/fluent';
import { hasSuggestTerms, suggestFluent, suggestImageMso } from '../iconSuggest';
import { msoIcon, onMsoIconsLoaded } from '../msoIcons';
import { openMenu } from './contextMenu';
import { emptyState } from './emptyState';
import { renderBulkInspector } from './bulkInspector';
import '../styles-w3.css';

export interface InspectorHooks {
  pickIdMso(current: string, apply: (v: string) => void): void;
  pickImageMso(current: string, apply: (v: string) => void): void;
  editImage(existing?: ImageEntry): void;
  pickFromLibrary(): void;
  /** 何も選んでいないときに案内する、よく使う操作（省略可）。 */
  quickStart?(): { label: string; run: () => void }[];
}

export type Section = '基本' | '表示' | '画像' | 'コールバック' | '詳細';
/**
 * 並び順。よく使う「画像」「コールバック」を「基本」の直後に置く（I-1。「表示」「詳細」は、触る機会が少ないので後ろ）。
 * 狭いインスペクタでも、アイコンとクリック時の処理が、下へスクロールしなくても目に入るようにするため。
 */
export const SECTIONS: readonly Section[] = ['基本', '画像', 'コールバック', '表示', '詳細'];

/** 分類名。「表示」はメニューの［表示］と同じ文言なので、英語はここで決める。 */
export function sectionName(s: Section): string {
  return lang === 'en' && s === '表示' ? 'Appearance' : t(s);
}

/** 属性の日本語名。生の属性名は横に小さく出す（XML を書く人が対応を覚えられるように）。 */
const ATTR_LABEL: Readonly<Record<string, string>> = {
  id: 'ID', idMso: '組み込み ID', idQ: '修飾 ID', tag: 'タグ文字列',
  insertAfterMso: 'この後ろに配置', insertBeforeMso: 'この前に配置', insertAfterQ: 'この後ろに配置（idQ）', insertBeforeQ: 'この前に配置（idQ）',
  label: 'ラベル', visible: '表示する', enabled: '有効にする', showLabel: 'ラベルを出す', showImage: 'アイコンを出す',
  screentip: 'ヒントの見出し', supertip: 'ヒントの本文', keytip: 'アクセスキー', size: '大きさ', description: '説明',
  title: '区切りの見出し', onAction: 'クリック時', getPressed: '押下状態', onChange: '入力時', getText: '表示する文字列',
  getContent: 'メニューの中身', getItemCount: '項目の数', getItemLabel: '項目のラベル', getItemImage: '項目のアイコン',
  getItemID: '項目の ID', getItemScreentip: '項目のヒント見出し', getItemSupertip: '項目のヒント本文',
  getSelectedItemID: '選択中の項目 ID', getSelectedItemIndex: '選択中の項目番号', getItemWidth: '項目の幅を返す', getItemHeight: '項目の高さを返す',
  onLoad: '読み込み時', loadImage: '画像の読み込み', startFromScratch: '組み込みタブを隠す', autoScale: '自動で縮める',
  centerVertically: '縦の中央に揃える', itemSize: '項目の大きさ', boxStyle: '並べる向き', sizeString: '幅の基準の文字列',
  maxLength: '最大文字数', showItemLabel: '項目のラベルを出す', showItemImage: '項目のアイコンを出す', columns: '列の数', rows: '行の数',
  itemWidth: '項目の幅', itemHeight: '項目の高さ', invalidateContentOnDrop: '開くたびに作り直す', showInRibbon: 'リボンに並べる',
  alignLabel: 'ラベルの位置', noWrap: '折り返さない', onShow: '開いた時', onHide: '閉じた時', isDefinitive: '押したら閉じる',
  columnWidthPercent: '1列目の幅（%）', firstColumnMinWidth: '1列目の最小幅', firstColumnMaxWidth: '1列目の最大幅',
  secondColumnMinWidth: '2列目の最小幅', secondColumnMaxWidth: '2列目の最大幅', helperText: '補足の文', style: '見た目の種類',
  target: 'リンク先', altText: '代替テキスト', allowedTaskSizes: 'タスクの大きさ', layoutChildren: '中身の向き', align: '配置', expand: '広げる方向',
};

/** 真偽値の属性の既定値（分かっているものだけ）。「既定（はい）」のように出す。 */
export const BOOL_DEFAULT: Readonly<Record<string, boolean>> = {
  visible: true, enabled: true, showLabel: true, showImage: true, showItemLabel: true, showItemImage: true,
  startFromScratch: false, autoScale: false, centerVertically: false, invalidateContentOnDrop: false, noWrap: false,
  isDefinitive: false, showInRibbon: true,
};

/** 列挙値の属性の既定値（分かっているものだけ）。「既定（normal）」のように出す（I-4）。 */
export const ENUM_DEFAULT: Readonly<Record<string, string>> = { size: 'normal', itemSize: 'normal', boxStyle: 'horizontal' };

/** 列挙値の「指定なし」の選択肢の文字。既定値が分かっていれば「既定（normal）」、分からなければ「未指定」。 */
export function enumUnsetText(name: string): string {
  const def = ENUM_DEFAULT[name];
  return def === undefined ? t('未指定') : t('既定（{value}）', { value: def });
}

export function attrLabel(name: string): string {
  const ja = ATTR_LABEL[name];
  return ja ? t(ja) : name;
}

export function sectionOf(d: AttrDef): Section {
  if (d.name === 'image' || d.name === 'imageMso' || d.name === 'getImage') return '画像';
  if (d.kind === 'callback') return 'コールバック';
  if (d.category === '動作') return '基本';
  return d.category;
}

let hooks: InspectorHooks;
let hostEl: HTMLElement | null = null;

const COLLAPSE_KEY = 'sash.inspector.collapsed';
const collapsed = new Set<string>(loadCollapsed());

function loadCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveCollapsed(): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/**
 * 「固定 | VBA」を切り替えたときに、入力していた値を覚えておく（戻したときに元の値に戻すため）。
 * キーは「要素（id、なければパス）|属性名」。このセッションの間だけ。
 */
const remembered = new Map<string, string>();

/** アイコンの種類を選んだが、まだ値が決まっていない状態（値が決まるまで XML は変えない）。 */
let pendingIcon: { key: string; mode: 'imageMso' | 'image' } | null = null;

let renderTimer: number | undefined;

export function mountInspector(host: HTMLElement, h0: InspectorHooks): void {
  hooks = h0;
  hostEl = host;
  const render = () => schedule(host);
  app.on('session', () => {
    pendingIcon = null;
    render();
  });
  app.on('problems', render);
  app.on('vba', render);
  // アイコンの見本は Excel から取るので、届いたら描き直す（I-3）
  onMsoIconsLoaded(render);
  app.on('store', (c) => {
    if (c && (c.kinds.has('selection') || c.kinds.has('doc') || c.kinds.has('images'))) render();
  });
}

/**
 * 描き直しを予約する。インスペクタの中にフォーカスがあるときは、フォーカスの移動（Tab など）が
 * 終わってから描き直す。change の処理中に DOM を差し替えると、移動先の欄が消えてフォーカスを失うため。
 */
function schedule(host: HTMLElement): void {
  // テスト環境の破棄後に遅れて呼ばれると window が無く落ちるため、何もしない
  if (typeof window === 'undefined') return;
  window.clearTimeout(renderTimer);
  if (host.contains(document.activeElement)) renderTimer = window.setTimeout(() => {
      if (typeof window !== 'undefined') renderInspector(host);
    }, 0);
  else renderInspector(host);
}

/** インスペクタにフォーカスを移す（Ctrl+4 / F6）。最初の入力欄に移る。 */
export function focus(): void {
  if (!hostEl) return;
  const first = hostEl.querySelector<HTMLElement>('input, select, .segmented button.active, button');
  (first ?? hostEl).focus();
}

/**
 * 入力中でまだ確定していない欄を確定する（保存・反映・閉じる・終了の前に呼ぶ）。
 * 確定は change（フォーカスを外したとき）か Enter なので、入力したまま Ctrl+S / F5 を押すと、
 * 入力した値が書き込む内容に入らず、保存したつもりの値が失われてしまうため。
 */
export function flushPendingEdits(): void {
  const a = document.activeElement;
  if (!hostEl || !(a instanceof HTMLInputElement) || !hostEl.contains(a)) return;
  if (a.value.trim() === (a.dataset['orig'] ?? a.defaultValue)) return;
  // textInput の change の処理（確かめてから確定）をそのまま使う
  a.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 指定した属性の入力欄にフォーカスを移す（キャンバスで Enter・F2）。なければ最初の欄。 */
export function focusField(attr = 'label'): void {
  if (!hostEl) return;
  renderInspector(hostEl);
  const field = hostEl.querySelector<HTMLElement>(`[data-attr="${attr}"]`) ?? hostEl.querySelector<HTMLElement>('input, select');
  if (!field) return;
  // セクションが畳まれていたら開く
  const section = field.closest<HTMLElement>('.insp-section');
  if (section?.classList.contains('collapsed')) {
    section.classList.remove('collapsed');
    collapsed.delete(section.dataset['section'] ?? '');
    saveCollapsed();
  }
  field.focus();
  if (field instanceof HTMLInputElement) field.select();
}

function elementKey(el: Element, path: Path): string {
  return el.getAttribute('id') ?? `path:${path.join('.')}`;
}

/**
 * いま el に書いてよいか。el が文書の中にあり、選んでいる要素自身か、選んでいる要素の書き込み先（分割ボタンなら中のボタン）であること。
 * 入力中に構造が変わっても（前に要素が差し込まれても）、描画時の path ではなく要素そのもので確かめるので、別の要素には書かない。
 */
function writable(el: Element): boolean {
  const store = app.store;
  const sel = store?.selectedElement;
  return !!store && !!sel && store.doc.contains(el) && (sel === el || iconTargetOf(sel) === el);
}

/** el の「いまの」path。書いてよくなければ null（ダイアログなどを開く直前に作り直す）。 */
function livePath(el: Element): Path | null {
  return writable(el) ? pathOf(el) : null;
}

/**
 * 属性を変更する。値が同じなら何もしない。
 * at を渡すと、選んでいる要素ではなくその要素に書く（分割ボタンを選んで、中のボタンの属性を直すとき）。
 * at が文書から外れた・もう書き込み先でないときは、何も書かない。
 */
function commit(name: string, value: string | null, also: Record<string, string | null> = {}, label?: string, at?: Element): boolean {
  const store = app.store;
  const el = at ?? store?.selectedElement;
  if (!store || !el || !store.selection) return false;
  if (at && !writable(at)) return false;
  const changes: Record<string, string | null> = { [name]: value, ...also };
  const same = Object.entries(changes).every(([k, v]) => (el.getAttribute(k) ?? null) === (v === '' ? null : v));
  if (same) return false;
  const path = store.selection;
  return runEdit('inspector', () => {
    // 選択が変わっていたら（描き直しの前に別の要素へ移ったとき）、別の要素に書かない
    const target = at ? (writable(at) ? at : null) : samePath(store.selection, path) ? store.selectedElement : null;
    if (!target) return undefined;
    for (const [k, v] of Object.entries(changes)) setAttr(target, k, v);
    return undefined;
  }, label ?? (value === null || value === '' ? t('{attr} を削除', { attr: name }) : t('{attr} を「{value}」に変更', { attr: name, value })));
}

/** el が選んでいる要素でなければ（分割ボタンを選んで中のボタンを直すとき）el そのもの。選んでいる要素自身なら undefined。 */
function atOf(el: Element): Element | undefined {
  return app.store?.selectedElement === el ? undefined : el;
}

/** コールバック名を新しく付けたときに、VBA への追加（できなければ雛形のコピー）を案内する。 */
function offerStub(name: string): void {
  const status = vba.statuses().find((x) => x.name === name);
  if (!status || status.state === 'implemented') return;
  const stub = (x: CallbackStatus) => generateStub({ ...x, name: bareCallbackName(x.name) });
  if (vba.canWrite && status.state === 'missing') {
    notify({
      kind: 'info',
      message: t('コールバック {name} を設定しました。VBA にはまだありません', { name }),
      action: {
        label: t('VBA に追加'),
        run: () =>
          void insertStubs([status])
            .then((m) => notify({ kind: 'success', message: m }))
            .catch((e: unknown) => notify({ kind: 'error', message: e instanceof Error ? e.message : String(e) })),
      },
    });
  } else {
    notify({ kind: 'info', message: t('コールバック {name} を設定しました', { name }), action: { label: t('雛形をコピー'), run: () => copyText(stub(status), t('{name} の雛形をコピーしました', { name })) } });
  }
}

/** 入力中の欄を、描き直した後の対応する欄に引き継ぐための目印。 */
interface FocusMemo {
  key: string;
  node: HTMLElement;
  value?: string;
  orig?: string;
  start?: number | null;
  end?: number | null;
}

function captureFocus(host: HTMLElement): FocusMemo | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !host.contains(a)) return null;
  const key = a.dataset['fkey'];
  if (!key) return null;
  if (a instanceof HTMLInputElement) return { key, node: a, value: a.value, orig: a.dataset['orig'], start: a.selectionStart, end: a.selectionEnd };
  return { key, node: a };
}

function restoreFocus(host: HTMLElement, memo: FocusMemo | null): void {
  if (!memo) return;
  // CSS.escape を使わずに探す（キーに引用符などが入っても壊れないように）
  const next = Array.from(host.querySelectorAll<HTMLElement>('[data-fkey]')).find((n) => n.dataset['fkey'] === memo.key);
  if (!next) return;
  if (memo.node instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    const dirty = memo.value !== memo.orig;
    if (dirty) {
      // 確定していない入力は残す（描き直しで半端な値が消えたり確定したりしないように）
      next.replaceWith(memo.node);
      memo.node.focus({ preventScroll: true });
      return;
    }
    next.focus({ preventScroll: true });
    try {
      next.setSelectionRange(memo.start ?? next.value.length, memo.end ?? next.value.length);
    } catch {
      // setSelectionRange を受け付けない種類の入力欄では何もしない
    }
    return;
  }
  next.focus({ preventScroll: true });
}

/**
 * 何も選んでいないときの画面。案内の 1 行だけだと、広いインスペクタの大半が空くので、
 * 空の状態の部品（emptyState）で案内し、よく使う操作を縦に並べる（総点検 I-4）。
 */
function renderNothingSelected(): HTMLElement {
  const actions = hooks.quickStart?.() ?? [];
  const list = actions.length
    ? h('div', { class: 'insp-quick' }, actions.map((a) => h('button', { type: 'button', class: 'small', onclick: a.run }, a.label)))
    : undefined;
  return emptyState({ icon: uiIcons.info, title: t('要素を選んでください'), text: t('キャンバスかツリーで要素を選択してください'), action: list, className: 'insp-empty-card' });
}

function renderInspector(host: HTMLElement): void {
  window.clearTimeout(renderTimer);
  const store = app.store;
  const el = store?.selectedElement ?? null;
  const memo = captureFocus(host);
  const scroll = host.scrollTop;

  if (!store || !el || !store.selection) {
    pendingIcon = null;
    host.replaceChildren(store ? renderNothingSelected() : h('div', { class: 'insp-empty' }));
    return;
  }
  // 複数を選んでいるときは、共通の属性をまとめて変える画面にする（仕様書 §19）
  if (store.isMulti) {
    pendingIcon = null;
    host.replaceChildren(...renderBulkInspector(store.selectedElements, { pickImageMso: hooks.pickImageMso }));
    host.scrollTop = scroll;
    restoreFocus(host, memo);
    return;
  }
  const path = store.selection;
  const key = elementKey(el, path);
  // アイコンの書き込み先（分割ボタンなら中のボタン）。種類を選んだだけの状態は、この要素の鍵で覚える
  const iconEl = iconTargetOf(el);
  const iconKey = iconEl ? elementKey(iconEl, pathOf(iconEl)) : key;
  if (pendingIcon && pendingIcon.key !== iconKey) pendingIcon = null;
  const def = defFor(el);
  const problems = app.problems.filter((p) => samePath(p.path, path));
  const ident = identifierOf(el);

  const header = h(
    'div',
    { class: 'insp-header' },
    h('span', { class: 'kind-icon' }, svg(kindIcon(el.localName))),
    h('div', { class: 'insp-heading' }, h('div', { class: 'insp-title' }, def ? t(def.title) : el.localName), h('div', { class: 'insp-sub', title: ident ?? '' }, `<${el.localName}>${ident ? ` ${ident}` : ''}`)),
  );

  const problemList = problems.length
    ? h('ul', { class: 'insp-problems' }, problems.map((p) => h('li', { class: p.severity }, svg(uiIcons[p.severity]), h('span', null, p.message))))
    : null;

  if (!def || def.opaque) {
    host.replaceChildren(header, h('div', { class: 'insp-empty' }, t('この要素の属性は XML エディタで編集してください')));
    return;
  }

  const defs = attrsOfEl(el);
  const innerBox = delegatesToInner(el) ? innerSection(el, iconKey) : null;
  const sections = SECTIONS.map((sec) => {
    const rows: HTMLElement[] = [];
    if (sec === '画像') {
      if (defs.some((d) => d.name === 'image' || d.name === 'imageMso')) rows.push(iconRow(el, key));
    } else {
      for (const d of defs) {
        if (d.staticOf || d.name === 'image' || d.name === 'imageMso' || d.name === 'getImage' || sectionOf(d) !== sec) continue;
        rows.push(row(el, d, key));
      }
    }
    if (rows.length === 0) return null;
    return sectionBox(sec, sectionName(sec), rows);
  });

  // 分割ボタンのラベルとアイコンは、中のボタンに書く（先頭に置いて、最初に目に入るようにする）
  host.replaceChildren(header, ...[problemList, innerBox, ...sections].filter((x): x is HTMLElement => x !== null));
  host.scrollTop = scroll;
  restoreFocus(host, memo);
}

/** 折りたためる区画。key は畳み状態の記憶と data-section に使う。 */
function sectionBox(key: string, title: string, rows: HTMLElement[], intro: HTMLElement | null = null): HTMLElement {
  const isCollapsed = collapsed.has(key);
  const toggle = h('button', {
    type: 'button',
    class: 'insp-section-head',
    'aria-expanded': String(!isCollapsed),
    onclick: (e: MouseEvent) => {
      const s = (e.currentTarget as HTMLElement).closest<HTMLElement>('.insp-section')!;
      const now = s.classList.toggle('collapsed');
      (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!now));
      if (now) collapsed.add(key);
      else collapsed.delete(key);
      saveCollapsed();
    },
  }, svg(uiIcons.chevron), h('span', null, title), h('span', { class: 'insp-count' }, String(rows.length)));
  return h('section', { class: `insp-section${isCollapsed ? ' collapsed' : ''}`, dataset: { section: key } }, toggle, h('div', { class: 'insp-rows' }, intro, rows));
}

/**
 * 分割ボタンのラベルとアイコンの区画。スキーマ上、分割ボタン自身には label / image などを付けられず、
 * 中の先頭の button / toggleButton が持つ。そこで、中のボタンの属性を、分割ボタンのインスペクタから直接直せるようにする。
 * 書き込み先が中のボタンだと分かるよう、見出しの下に id を示し、中のボタンへ移るリンクを置く。
 */
function innerSection(split: Element, iconKey: string): HTMLElement {
  const inner = innerButtonOf(split);
  if (!inner) {
    return sectionBox(INNER_SECTION, t('ラベル・アイコン・ヒント'), [], h('div', { class: 'insp-inner-note error', role: 'alert', dataset: { innerMissing: '1' } },
      t('分割ボタンの中に button か toggleButton がありません。ラベルとアイコンは中のボタンに設定するので、XML を直してください')));
  }
  const ident = inner.getAttribute('id') ?? inner.getAttribute('idQ') ?? inner.getAttribute('idMso') ?? inner.localName;
  const intro = h('div', { class: 'insp-inner-note', dataset: { innerNote: '1' } },
    h('span', null, t('中のボタン（{id}）に設定されます', { id: ident })),
    h('button', {
      type: 'button',
      class: 'link',
      dataset: { fkey: 'inner:goto' },
      onclick: () => app.store?.select(pathOf(inner), 'inspector'),
    }, t('中のボタンを選ぶ')));
  // ラベル・アイコン・ヒント（Lint の案内「ラベル・ヒント・アイコンは中のボタンに付けます」と同じ範囲）
  const rows = [
    row(inner, attributes.get('label')!, iconKey),
    iconRow(inner, iconKey),
    row(inner, attributes.get('screentip')!, iconKey),
    row(inner, attributes.get('supertip')!, iconKey),
  ];
  // 中のボタンについての Lint の指摘も、ここで見えるようにする（分割ボタンを選んだままでも、書き込み先の問題に気づけるように）
  const innerPath = pathOf(inner);
  const problems = app.problems.filter((p) => samePath(p.path, innerPath));
  const list = problems.length
    ? h('ul', { class: 'insp-problems', dataset: { innerProblems: '1' } }, problems.map((p) => h('li', { class: p.severity }, svg(uiIcons[p.severity]), h('span', null, p.message))))
    : null;
  return sectionBox(INNER_SECTION, t('ラベル・アイコン・ヒント'), rows, h('div', null, intro, list));
}

const INNER_SECTION = 'inner';

function labelCell(d: AttrDef, tag: string, forId: string): HTMLElement {
  const tips = [t(d.desc)];
  if (d.example) tips.push(`${t('例：')}${d.name}="${t(d.example)}"`);
  if (d.kind === 'callback') tips.push(t('Sub 名前({signature})', { signature: callbackSignature(d.name, tag) }));
  const base = d.staticOf ?? d.name;
  return h('label', { class: 'insp-label', title: tips.join('\n'), for: forId }, h('span', { class: 'insp-label-ja' }, attrLabel(base)), h('span', { class: 'insp-label-raw' }, d.name));
}

let fieldSeq = 0;

interface TextOpts {
  placeholder?: string;
  /** 入力を確かめる。問題があればその理由を返す（空なら確定してよい）。 */
  validate?: (v: string) => string | null;
  inputMode?: string;
  /** 読み上げ用の名前。見えるラベルと結びつかない欄（アイコン欄など）に付ける。 */
  ariaLabel?: string;
  /**
   * 確定する。値が変わらなければ何もしない。false（または false になる Promise）を返したら、
   * 断られた・取りやめたとみなして、欄を確定前の値に戻す。
   */
  apply?: (v: string) => boolean | Promise<boolean>;
  /** 確定の書き込み先（選んでいる要素以外に書くとき）。 */
  at?: Element;
}

/** 1行の入力欄。確定は change（フォーカスを外したとき）と Enter、Esc で元の値に戻す。 */
function textInput(attr: string, value: string, opts: TextOpts = {}): { input: HTMLInputElement; wrap: HTMLElement } {
  const id = `insp-f${++fieldSeq}`;
  const input = h('input', {
    type: 'text',
    id,
    value,
    placeholder: opts.placeholder ?? '',
    spellcheck: false,
    autocomplete: 'off',
    inputmode: opts.inputMode,
    'aria-label': opts.ariaLabel,
    dataset: { attr, fkey: `${attr}:text`, orig: value },
  });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const check = (): string | null => {
    const v = input.value.trim();
    const err = v && opts.validate ? opts.validate(v) : null;
    input.classList.toggle('invalid', err !== null);
    input.setAttribute('aria-invalid', String(err !== null));
    error.hidden = err === null;
    error.textContent = err ?? '';
    return err;
  };
  const apply = () => {
    if (check() !== null) return;
    const v = input.value.trim();
    const prev = input.dataset['orig'] ?? '';
    if (v === prev) return;
    // 先に orig を進めておく（確定の処理の中で change がもう一度来ても、二重に確定しないように）
    input.dataset['orig'] = v;
    // 断られた（構文エラー中など）・取りやめた（名前の変更の確認でキャンセル）ときは、XML は元のままなので欄も元に戻す。
    // 戻さないと、欄だけが新しい値のまま残り、XML と食い違って見える
    const revert = (ok: boolean) => {
      if (ok || input.dataset['orig'] !== v) return;
      input.dataset['orig'] = prev;
      input.value = prev;
      check();
    };
    const result = opts.apply ? opts.apply(v) : commit(attr, v || null, {}, undefined, opts.at);
    if (typeof result === 'boolean') revert(result);
    else void result.then(revert, () => revert(false));
  };
  input.addEventListener('input', () => {
    // 入力中は確定せず、問題だけを先に知らせる
    if (input.classList.contains('invalid')) check();
  });
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => {
    // 日本語入力の変換中の Enter・Esc は変換のためのものなので無視する（不具合 39）
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      input.value = input.dataset['orig'] ?? '';
      check();
    }
  });
  return { input, wrap: h('div', { class: 'insp-field' }, input, error) };
}

export interface IdSuggestion {
  id: string;
  /** label はラベルから、seq は種類の接頭辞と連番から。 */
  kind: 'label' | 'seq';
}

/**
 * id の提案の選択肢（I-2）。ラベルから作ったもの（英字なら単語をつなげ、日本語などはそのまま使う。id には Unicode の文字を使える。
 * 仕様書 §17.2）と、種類と連番のもの。両方が同じ（ラベルが空など）なら 1 つだけ返す。
 */
export function idSuggestions(tag: string, label: string | null, used: ReadonlySet<string>): IdSuggestion[] {
  const seq = suggestId(tag, null, used);
  const ascii = label !== null && /^[\x20-\x7e]+$/.test(label);
  const fromLabel = label === null || label.trim() === '' ? null : ascii ? suggestId(tag, label, used) : suggestIdFromLabel(tag, label, used);
  const out: IdSuggestion[] = [];
  if (fromLabel && fromLabel !== seq) out.push({ id: fromLabel, kind: 'label' });
  out.push({ id: seq, kind: 'seq' });
  return out;
}

/** 「提案」を押したとき。選択肢が 2 つ以上なら小メニューで選ばせ、1 つならそのまま入れる。 */
function suggestIdMenu(el: Element, current: string, input: HTMLInputElement, opener: HTMLElement): void {
  const used = usedIds(el.ownerDocument);
  used.delete(current);
  // 分割ボタンは label を持てないので、中のボタンのラベルから提案する
  const label = el.getAttribute('label') ?? (labelForSuggest(el) || null);
  const options = idSuggestions(el.localName, label, used);
  const apply = (next: string) => {
    const before = input.value;
    if (next === current) {
      // 何も起きないと、押したのに反応がないように見える。変わらないことだけを知らせる。
      // 「日本語のラベルからは英字の ID を作れない」とは言わない：ラベルから作った案が別にあった（これは連番を選んだだけ）か、
      // 記号だけのラベルで作れなかっただけで、理由が違うため
      notify({ kind: 'info', message: t('ID は {id} のままです', { id: next }) });
      return;
    }
    input.value = next;
    // 断られたら、提案した値を欄に残さない
    if (!commit('id', next, { idMso: null, idQ: null })) input.value = before;
  };
  if (options.length === 1) {
    apply(options[0]!.id);
    return;
  }
  const r = opener.getBoundingClientRect();
  openMenu(r.left, r.bottom + 2, options.map((o) => ({
    label: o.kind === 'label' ? t('{id}（ラベルから）', { id: o.id }) : t('{id}（連番）', { id: o.id }),
    run: () => apply(o.id),
  })), { restoreFocus: opener });
}

/** 既定 / はい / いいえ の3択。 */
function boolEditor(el: Element, d: AttrDef): HTMLElement {
  const raw = el.getAttribute(d.name);
  const value = raw === '1' ? 'true' : raw === '0' ? 'false' : raw ?? '';
  const def = BOOL_DEFAULT[d.name];
  const defaultText = def === undefined ? t('既定') : t('既定（{value}）', { value: def ? t('はい') : t('いいえ') });
  const seg = h('div', { class: 'segmented insp-bool', role: 'radiogroup', 'aria-label': attrLabel(d.name), dataset: { attr: d.name } });
  const options = [['', defaultText], ['true', t('はい')], ['false', t('いいえ')]] as const;
  for (const [v, text] of options) {
    const active = value === v;
    seg.append(
      h('button', {
        type: 'button',
        class: active ? 'active' : '',
        role: 'radio',
        'aria-checked': String(active),
        tabIndex: active ? 0 : -1,
        dataset: { fkey: `${d.name}:bool:${v}` },
        onclick: () => commit(d.name, v || null, {}, undefined, atOf(el)),
      }, text),
    );
  }
  // ラジオボタンと同じく、左右の矢印で選び直せるようにする
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = options.findIndex(([v]) => v === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]!;
    if (!commit(d.name, next[0] || null, {}, undefined, atOf(el))) return;
    // 確定すると描き直されるので、描き直した後の「選んだ項目」にフォーカスを移す（ラジオボタンと同じく、選んだものに乗る）。
    // 描き直しは、フォーカスがインスペクタにある間は次のタスクに回るので、その後で探す
    const fkey = `${d.name}:bool:${next[0]}`;
    window.setTimeout(() => {
      const target = Array.from(hostEl?.querySelectorAll<HTMLElement>('[data-fkey]') ?? []).find((n) => n.dataset['fkey'] === fkey);
      target?.focus({ preventScroll: true });
    }, 0);
  });
  return seg;
}

function valueEditor(el: Element, d: AttrDef): HTMLElement {
  const value = el.getAttribute(d.name) ?? '';
  switch (d.kind) {
    case 'bool':
      return boolEditor(el, d);
    case 'enum':
      return h(
        'select',
        { dataset: { attr: d.name, fkey: `${d.name}:enum` }, onchange: (e: Event) => commit(d.name, (e.target as HTMLSelectElement).value || null, {}, undefined, atOf(el)) },
        h('option', { value: '' }, enumUnsetText(d.name)),
        (d.values ?? []).map((v) => h('option', { value: v, selected: v === value }, v)),
        value && !(d.values ?? []).includes(value) ? h('option', { value, selected: true }, value) : null,
      );
    case 'int':
      // type="number" は「1e」や空のときに value が '' になり、属性が消えてしまう（不具合 28）。文字として受けて確かめる
      return textInput(d.name, value, { inputMode: 'numeric', validate: (v) => attrValueError(d, v), at: atOf(el) }).wrap;
    case 'id': {
      const { input, wrap } = textInput(d.name, value, {
        validate: (v) => {
          if (!isXmlId(v)) return t('文字か _ で始め、文字・数字と _ . - だけを使ってください');
          const used = usedIds(el.ownerDocument);
          used.delete(value);
          return used.has(v) ? t('この id はすでに使われています') : null;
        },
      });
      return h(
        'div',
        { class: 'insp-inline' },
        wrap,
        h('button', {
          type: 'button',
          class: 'small',
          title: t('ラベルや連番から id を提案する'),
          'aria-haspopup': 'menu',
          // 選んで描き直された後も、この「提案」ボタンにフォーカスが戻るように
          dataset: { fkey: 'id:suggest' },
          onclick: (e: MouseEvent) => suggestIdMenu(el, value, input, e.currentTarget as HTMLElement),
        }, t('提案')),
      );
    }
    case 'idMso':
      return h(
        'div',
        { class: 'insp-inline' },
        textInput(d.name, value).wrap,
        h('button', { type: 'button', class: 'small', onclick: () => hooks.pickIdMso(value, (v) => commit(d.name, v, d.name === 'idMso' ? { id: null, idQ: null } : {})) }, t('選ぶ')),
      );
    case 'callback':
      return callbackEditor(el, d.name);
    default:
      // keytip の長さなど、値だけで決まる決まりは、まとめて変更と同じもので確かめる（attrValidate.ts）
      return textInput(d.name, value, { validate: (v) => attrValueError(d, v), at: atOf(el) }).wrap;
  }
}

/** コールバック名として使えるか（まとめて変更と同じ決まり。「モジュール名.Sub名」「ブック!Sub名」の形も認める）。 */
function callbackError(v: string): string | null {
  return attrValueError({ name: '', kind: 'callback' }, v);
}

function callbackEditor(el: Element, attr: string): HTMLElement {
  const value = el.getAttribute(attr) ?? '';
  const at = atOf(el);
  const path = pathOf(el);
  const { wrap } = textInput(attr, value, {
    at,
    placeholder: defaultCallbackName(el, attr),
    validate: callbackError,
    apply: (v) => {
      // 名前を変えたときは、VBA 側の Sub 名も変えるかを確認する（キャンセルしたら false が返り、欄は元に戻る）
      if (value && v) {
        // path は押した時点で作り直す（入力中に構造が変わっていたら別の要素の名前を変えないよう、書いてよいか確かめる）
        const now = livePath(el);
        return now ? renameCallback(now, attr, value, v) : false;
      }
      const ok = commit(attr, v || null, {}, undefined, at);
      if (ok && v) offerStub(v);
      return ok;
    },
  });
  const status = value ? vba.statuses().find((x) => x.name === value) : undefined;
  const stateText = status && vba.status === 'ok' ? t({ implemented: '実装済み', missing: '未実装', mismatch: '引数が不一致', unused: '' }[status.state]) : '';
  return h(
    'div',
    { class: 'insp-callback' },
    h(
      'div',
      { class: 'insp-inline' },
      wrap,
      value
        ? null
        : h('button', {
            type: 'button',
            class: 'small',
            onclick: () => {
              const name = defaultCallbackName(el, attr);
              if (commit(attr, name, {}, undefined, at)) offerStub(name);
            },
          }, lang === 'en' ? 'Add' : '追加'),
    ),
    value ? h('code', { class: 'insp-signature' }, `Sub ${value}(${callbackSignature(attr, el.localName)})`) : null,
    value && (attr === 'getVisible' || attr === 'getEnabled') ? dynamicNote(path, attr) : null,
    stateText ? h('span', { class: `cb-state ${status!.state}`, title: status!.reason ?? '' }, stateText) : null,
  );
}

/**
 * getVisible / getEnabled の「動的」の印。表示・押せるかは VBA が決めるので、キャンバスの見た目は既定（表示・押せる）のまま。
 * そのことを示し、キャンバスで状態を切り替えて見られる機能（キャンバス側が受け持つ）へ案内する。
 * キャンバスとはイベントでつなぐ（インスペクタがキャンバスの作りに依存しないように）。
 */
function dynamicNote(path: Path, attr: string): HTMLElement {
  return h('div', { class: 'insp-dynamic' },
    h('span', { class: 'insp-dynamic-badge' }, t('動的')),
    h('span', { class: 'muted' }, attr === 'getVisible' ? t('表示するかは VBA が決めます') : t('押せるかは VBA が決めます')),
    h('button', {
      type: 'button',
      class: 'link',
      onclick: () => window.dispatchEvent(new CustomEvent('sash:dynamicSim', { detail: { path: [...path] } })),
    }, t('キャンバスで試す')));
}

/** 静的な値とコールバックを切り替えられる行。 */
function row(el: Element, d: AttrDef, key: string): HTMLElement {
  const dyn = d.dynamic ? attributes.get(d.dynamic) : undefined;
  const available = dyn !== undefined && defFor(el)?.attrs.includes(dyn.name) === true;
  const useDynamic = available && el.hasAttribute(dyn.name);
  const shown = useDynamic ? dyn : d;
  const editor = useDynamic ? callbackEditor(el, dyn.name) : valueEditor(el, d);
  const fieldId = editor.querySelector('input')?.id ?? '';

  let modeSwitch: HTMLElement | null = null;
  if (available) {
    const toStatic = () => {
      // VBA から固定に戻すときは、切り替える前に入力していた値を戻す
      remembered.set(`${key}|${dyn.name}`, el.getAttribute(dyn.name) ?? '');
      const back = remembered.get(`${key}|${d.name}`) ?? null;
      commit(d.name, back, { [dyn.name]: null }, t('{attr} を固定の値にする', { attr: d.name }), atOf(el));
    };
    const toDynamic = () => {
      remembered.set(`${key}|${d.name}`, el.getAttribute(d.name) ?? '');
      const name = remembered.get(`${key}|${dyn.name}`) || defaultCallbackName(el, dyn.name);
      if (commit(dyn.name, name, { [d.name]: null }, t('{attr} を VBA で返す', { attr: d.name }), atOf(el))) offerStub(name);
    };
    // 「固定 | VBA」は、入力欄の右端の小さな切り替えボタン 1 個にする（I-1）。以前はラベルの下に 1 段使っていて、
    // 1 属性が約 62px になり、高さ 768px では 6 属性しか見えなかった。固定は輪郭だけ、VBA で返しているときは色付き。
    // 押すたびに描き直されるので、描き直した後も同じボタンにフォーカスが戻るよう、状態によらず同じ data-fkey にする
    modeSwitch = h('button', {
      type: 'button',
      class: `insp-modebtn${useDynamic ? ' on' : ''}`,
      'aria-pressed': String(useDynamic),
      'aria-label': t('VBA で動的に返す（{name}）', { name: dyn.name }),
      title: useDynamic ? t('VBA で返しています。押すと固定の値（{name}）に戻します', { name: d.name }) : t('VBA で動的に返す（{name}）', { name: dyn.name }),
      dataset: { fkey: `${d.name}:mode` },
      onclick: () => (useDynamic ? toStatic() : toDynamic()),
    }, 'VBA');
  }
  const label = labelCell(shown, el.localName, fieldId);
  return h('div', { class: `insp-row${modeSwitch ? ' has-mode' : ''}` }, label, h('div', { class: 'insp-value' }, editor, modeSwitch));
}

let msoNames: string[] | null = null;
let fluentIcons: FluentIcon[] | null = null;

/** アイコンの候補に使うラベル。splitButton はラベルを中のボタンに持つ。 */
function labelForSuggest(el: Element): string {
  const own = el.getAttribute('label');
  if (own) return own;
  if (el.localName === 'splitButton') return el.querySelector(':scope > button, :scope > toggleButton')?.getAttribute('label') ?? '';
  return '';
}

/**
 * アイコンがまだないときに、ラベルから候補を出す（組み込みアイコンとアイコン集から、それぞれ最大 5 個）。
 * アイコン集のデータは大きいので、候補を出すときに初めて読み込み、読み込めたら同じ欄に足す（インスペクタ全体は描き直さない。
 * 入力中の欄のフォーカスを動かさないため）。読み込めなければ組み込みアイコンの候補だけにする。
 */
function iconSuggestions(el: Element, nowPath: () => Path | null, setMso: (v: string) => boolean): HTMLElement | null {
  const label = labelForSuggest(el);
  if (!label) return null;
  msoNames ??= imageMsoNames();
  const mso = suggestImageMso(label, msoNames, msoLabels);
  const msoRow = mso.length
    ? h('div', { class: 'icon-suggest-row' },
        h('span', { class: 'icon-suggest-kind' }, t('組み込み')),
        mso.map((name) => {
          const src = msoIcon(name);
          const ja = msoLabels.get(name);
          return h('button', {
            type: 'button',
            tabIndex: -1,
            class: 'icon-suggest',
            title: ja ? `${ja}（${name}）` : name,
            onclick: () => setMso(name),
          }, src ? h('img', { src, alt: '' }) : null, h('span', null, name));
        }))
    : null;
  const fluentRow = h('div', { class: 'icon-suggest-row', hidden: true }, h('span', { class: 'icon-suggest-kind' }, t('アイコン集')));
  // 組み込みの候補がなく、アイコン集の候補も出せなかったときは、見出しだけの箱を出さないよう、箱ごと隠しておく
  const box = h('div', { class: 'icon-suggest-box', 'aria-label': t('ラベルから選んだアイコンの候補'), hidden: !msoRow },
    h('div', { class: 'icon-suggest-head muted' }, t('候補（ラベル「{label}」から）', { label })),
    msoRow,
    fluentRow);
  // 候補は 1 つの Tab 停止にして、中は ←→ で移る（9 個続くボタンを Tab で通り抜けるのに 9 回かかるため。総点検 I-3）
  const stops = () => Array.from(box.querySelectorAll<HTMLButtonElement>('button.icon-suggest')).filter((b) => !b.closest('[hidden]'));
  const roving = (current?: HTMLElement) => {
    const list = stops();
    const cur = current && list.includes(current as HTMLButtonElement) ? current : list.find((b) => b.tabIndex === 0) ?? list[0];
    for (const b of list) b.tabIndex = b === cur ? 0 : -1;
  };
  box.addEventListener('focusin', (e) => roving(e.target as HTMLElement));
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const list = stops();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? 1 : -1)));
    roving(list[j]);
    list[j]!.focus();
  });
  queueMicrotask(() => roving());
  const fillFluent = async (icons: FluentIcon[]) => {
    const picks = await suggestFluent(icons, label);
    // 待っている間に欄が描き直されて外れていたら、何もしない
    if (picks.length === 0 || !fluentRow.isConnected) return;
    fluentRow.hidden = false;
    box.hidden = false;
    fluentRow.append(...picks.map((icon) => {
      const markup = buildSvg(icon, 'regular', 'currentColor', 20);
      return h('button', {
        type: 'button',
        tabIndex: -1,
        class: 'icon-suggest fluent',
        title: t('{name}（アイコン集）を加工して設定する', { name: fluentName(icon.name) }),
        'aria-label': fluentName(icon.name),
        onclick: () => {
          const path = nowPath();
          if (path) openFluentCandidate(path, icon);
        },
      }, markup ? svg(markup) : null);
    }));
    roving();
  };
  // 概念の辞書（小さい）で言葉が見つかったときだけ、大きなアイコン集のデータを読み込む。
  // 旧来の小さな辞書だけで足切りすると、「出荷」「精算する」「猫」のような言葉で候補が出なくなる
  void hasSuggestTerms(label)
    .then(async (ok) => {
      if (!ok || !fluentRow.isConnected) return;
      if (!fluentIcons) fluentIcons = (await loadIconSet()).icons;
      await fillFluent(fluentIcons);
    })
    .catch(() => undefined);
  return box;
}

/**
 * アイコン集の候補を選んだとき。アイコン集のダイアログで選んだときと同じく、アイコンエディタに読み込んで PNG にしてから設定する
 * （色や余白をそこで調えられるように）。色は既定（Excel の明るいリボンになじむ灰色）にする。
 */
function openFluentCandidate(path: Path, icon: FluentIcon): void {
  const markup = buildSvg(icon, 'regular', DEFAULT_COLOR);
  if (!markup) return;
  openIconDialog(path, undefined, undefined, {
    fluent: { blob: new Blob([markup], { type: 'image/svg+xml' }), fileName: `${iconSet(icon) === 'tabler' ? 'tabler-' : ''}${icon.name}_regular.svg`, name: icon.name, set: iconSet(icon), variant: 'regular', color: DEFAULT_COLOR },
  });
}

/**
 * 組み込みアイコン（imageMso）の見本（24px）。キャンバスと同じ取得（msoIcon）で、取れなければ「？」を出す（I-3）。
 * まだ取得中（undefined）のときは空の枠だけにして、届いたら onMsoIconsLoaded で描き直す。
 */
function iconPreview(name: string): HTMLElement {
  const src = name ? msoIcon(name) : null;
  if (src) return h('img', { class: 'insp-icon-preview', src, width: 24, height: 24, alt: '', title: name, draggable: false });
  return h('span', { class: 'insp-icon-preview placeholder', 'aria-hidden': 'true', title: name ? t('{name} の見本を出せません', { name }) : '' }, !name || src === undefined ? '' : '？');
}

/** アイコンの行。組み込み（imageMso）、埋め込み画像（image）、VBA（getImage）を切り替える。 */
function iconRow(el: Element, key: string): HTMLElement {
  const store = app.store!;
  // el は書き込み先の要素（分割ボタンを選んでいるときは中のボタン）。選んでいる要素と違うときだけ at を渡す
  const at = atOf(el);
  // ダイアログなどを開く直前に path を作り直す（描画時の path は、構造が変わると別の要素を指す）
  const nowPath = (): Path | null => livePath(el);
  const actual = el.hasAttribute('getImage') ? 'getImage' : el.hasAttribute('image') ? 'image' : el.hasAttribute('imageMso') ? 'imageMso' : '';
  // 種類だけ選んで値がまだないときは、その種類の入力欄を出す（値が決まるまで XML は変えない。不具合 29）
  const mode = pendingIcon && pendingIcon.key === key ? pendingIcon.mode : actual;
  const canDynamic = defFor(el)?.attrs.includes('getImage');
  const clear = { image: null, imageMso: null, getImage: null } as Record<string, string | null>;
  const rerender = () => hostEl && renderInspector(hostEl);
  const cancelPending = () => {
    if (pendingIcon?.key === key) {
      pendingIcon = null;
      rerender();
    }
  };
  const setMso = (v: string): boolean => {
    pendingIcon = null;
    return commit('imageMso', v, { ...clear, imageMso: v }, t('アイコンを {name} に変更', { name: v }), at);
  };
  const openEditor = (existing?: ImageEntry) => {
    const path = nowPath();
    if (!path) return;
    openIconDialog(path, undefined, existing, {
      onClose: (applied) => {
        // 取り消したら、種類の選択も元に戻す
        if (!applied) cancelPending();
      },
    });
  };

  const sel = h(
    'select',
    {
      dataset: { attr: 'icon-mode', fkey: 'icon-mode' },
      'aria-label': t('アイコンの種類'),
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        if (v === actual) {
          cancelPending();
          return;
        }
        if (v === 'imageMso' || v === 'image') {
          // 別の種類の値はまだ消さない。新しい値を決めた時点でまとめて入れ替える
          pendingIcon = { key, mode: v };
          rerender();
          return;
        }
        pendingIcon = null;
        if (v === 'getImage') {
          const name = defaultCallbackName(el, 'getImage');
          if (commit('getImage', name, { ...clear, getImage: name }, t('アイコンを VBA で返す'), at)) offerStub(name);
        } else {
          commit('image', null, clear, t('アイコンをなしにする'), at);
        }
      },
    },
    h('option', { value: '', selected: mode === '' }, t('なし')),
    h('option', { value: 'imageMso', selected: mode === 'imageMso' }, t('組み込みアイコン')),
    h('option', { value: 'image', selected: mode === 'image' }, t('画像ファイル')),
    canDynamic ? h('option', { value: 'getImage', selected: mode === 'getImage' }, t('VBA で返す')) : null,
  );

  let detail: HTMLElement | null = null;
  if (mode === 'imageMso') {
    const v = el.getAttribute('imageMso') ?? '';
    detail = h(
      'div',
      { class: 'insp-inline' },
      iconPreview(v),
      textInput('imageMso', v, { placeholder: t('例：AutoSum'), ariaLabel: t('imageMso の名前'), apply: (x) => (x ? setMso(x) : commit('imageMso', null, {}, undefined, at)), at }).wrap,
      h('button', { type: 'button', class: 'small', onclick: () => openCatalog('imageMso', v, setMso, '', { onCancel: cancelPending }) }, t('選ぶ')),
    );
  } else if (mode === 'image') {
    const id = el.getAttribute('image') ?? '';
    const img = store.images.get(id);
    detail = h(
      'div',
      { class: 'insp-image' },
      h(
        'div',
        { class: 'insp-inline' },
        img ? h('img', { class: 'insp-thumb', src: img.dataUrl, alt: '' }) : null,
        h(
          'select',
          {
            dataset: { attr: 'image', fkey: 'image:select' },
            'aria-label': t('画像'),
            onchange: (e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              if (!v) return;
              pendingIcon = null;
              commit('image', v, { ...clear, image: v }, t('アイコンを {name} に変更', { name: v }), at);
            },
          },
          id && img ? null : h('option', { value: '', selected: true }, id ? t('{id}（見つかりません）', { id }) : t('選択してください')),
          [...store.images.keys()].map((k) => h('option', { value: k, selected: k === id }, k)),
        ),
      ),
      h(
        'div',
        { class: 'insp-inline wrap' },
        img?.edit ? h('button', { type: 'button', class: 'small', title: t('元画像と設定から加工し直す'), onclick: () => openEditor(img) }, t('加工し直す')) : null,
        h('button', { type: 'button', class: 'small', onclick: () => openEditor() }, t('新しく作る')),
        // 同梱のアイコン集から選び、アイコンエディタで PNG にして設定する（Excel がなくても見栄えのよいアイコンを付けられるように）
        h('button', {
          type: 'button',
          class: 'small',
          title: t('同梱のアイコン集（Fluent・Tabler、約 8,000 個）から選ぶ。ビジネス・動物・乗り物・食べ物・文字などを、あいまいな言葉で探せます。Excel がなくても使えます'),
          onclick: () =>
            openFluentIcons(
              (pick) => {
                const path = nowPath();
                if (!path) return;
                openIconDialog(path, undefined, undefined, {
                  fluent: pick,
                  onClose: (applied) => {
                    if (!applied) cancelPending();
                  },
                });
              },
              (picked) => !picked && cancelPending(),
            ),
        }, t('アイコン集')),
        h('button', {
          type: 'button',
          class: 'small',
          title: t('アイコンライブラリから選ぶ'),
          onclick: () =>
            void openLibrary((d) => {
              pendingIcon = null;
              const path = nowPath();
              if (path) applyLibraryIcon(path, d);
            }, (m, k) => notify({ kind: k ?? 'info', message: m }), { onClose: (picked) => !picked && cancelPending() }),
        }, t('ライブラリ')),
      ),
    );
  } else if (mode === 'getImage') {
    detail = callbackEditor(el, 'getImage');
  } else if (actual === '') {
    detail = iconSuggestions(el, nowPath, setMso);
  }
  const d = attributes.get('image')!;
  const rawName = mode === 'getImage' ? 'getImage' : mode === 'image' ? 'image' : 'imageMso';
  return h(
    'div',
    { class: 'insp-row wide' },
    h('label', { class: 'insp-label', title: t(d.desc) }, h('span', { class: 'insp-label-ja' }, t('アイコン')), h('span', { class: 'insp-label-raw' }, rawName)),
    h('div', { class: 'insp-value' }, sel, detail),
  );
}
