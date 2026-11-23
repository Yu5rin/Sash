// 要素の切り取り・コピー・貼り付け・複製・削除と、その周辺の編集操作（キャンバスとツリーで共有する）。
// コピーした要素は XML の文字列として内部に持つ。DOM の参照を持つと、Undo で文書が作り直されたときに
// 古い文書の要素を指したままになるため。OS のクリップボードにも、他のツールに貼れるよう XML を書く（失敗しても無視）。

import { app } from './app';
import * as model from './model';
import { childElements, createElement, elementAt, parseXml, pathOf, serialize, usedIds, type Path } from './model';
import * as schema from './schema';
import { canContainEl, defFor, titleOf } from './schema';
import type { Source } from './store';
import { t } from './i18n';

// ---- 通知 ----

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface ToastOptions {
  kind: ToastKind;
  message: string;
  action?: { label: string; run: () => void };
  timeout?: number;
}

// シェルの通知（shell/toast.ts）は別の担当が並行して作っている。まだない環境でもビルドが通るよう、
// import.meta.glob で「あれば使う」形にする（ファイルがなければ空のオブジェクトになる）。
const shellToast = Object.values(import.meta.glob<{ toast?: (o: ToastOptions) => void }>('./shell/toast.ts', { eager: true }))[0]?.toast;

let fallbackTimer: number | undefined;

/** 通知を出す。シェルの通知があればそれを使い、なければ #toast に出す。 */
export function notify(o: ToastOptions): void {
  if (shellToast) {
    shellToast(o);
    return;
  }
  const el = document.getElementById('toast');
  if (!el) return;
  el.replaceChildren(document.createTextNode(o.message));
  if (o.action) {
    const action = o.action;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'small toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.hidden = true;
      action.run();
    });
    el.append(' ', b);
  }
  el.className = `toast ${o.kind === 'error' ? 'error' : 'info'}`;
  el.hidden = false;
  window.clearTimeout(fallbackTimer);
  fallbackTimer = window.setTimeout(() => (el.hidden = true), o.timeout ?? (o.kind === 'error' ? 8000 : 5000));
}

/** OS のクリップボードに書く。失敗したら通知する（WebView2 ではフォーカスがないと失敗することがある）。 */
export function copyText(text: string, message: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => notify({ kind: 'success', message }))
    .catch((e: unknown) => notify({ kind: 'error', message: t('クリップボードにコピーできませんでした：{message}', { message: e instanceof Error ? e.message : String(e) }) }));
}

// ---- ストアへの編集 ----

/**
 * store.edit を呼ぶ。edit は（並行して変更中の）新しい版では boolean を返し、label を受け取る。
 * 古い版では void を返すので、false 以外は「変更した」とみなす。
 */
export function runEdit(source: Source, fn: (doc: Document) => Path | null | void, label: string): boolean {
  const store = app.store;
  if (!store) return false;
  const edit = store.edit as unknown as (s: Source, f: (doc: Document) => Path | null | void, l?: string) => unknown;
  return edit.call(store, source, fn, label) !== false;
}

// ---- 置ける位置 ----

type AllowedInsertIndex = (parent: Element, tag: string, desired: number) => number | null;
type CanDuplicate = (el: Element) => boolean;

// model.ts の allowedInsertIndex / canDuplicate は並行して作られている。あればそちらを使い、なければここで判定する。
const modelApi = model as unknown as Partial<Record<'allowedInsertIndex', AllowedInsertIndex> & Record<'canDuplicate', CanDuplicate>>;

/** 子要素の並び順の枠（schema の childOrder）。古い schema にはないので、なければ空とする。 */
function slotsOf(parent: Element): readonly { tags: readonly string[]; max?: number }[] {
  const def = defFor(parent) as (schema.ElementDef & { childOrder?: readonly { tags: readonly string[]; max?: number }[] }) | undefined;
  return def?.childOrder ?? [];
}

/**
 * parent の desired 番目に tag を置けるなら、実際に置く位置を返す（並び順の決まりに合わせて前後にずらす）。
 * 置けなければ null。
 */
export function allowedIndex(parent: Element, tag: string, desired: number, moving: Element | null = null): number | null {
  if (modelApi.allowedInsertIndex && !moving) return modelApi.allowedInsertIndex(parent, tag, desired);
  if (!canContainEl(parent, tag)) return null;
  const kids = childElements(parent).filter((c) => c !== moving);
  // moving を除いた並びでの位置に直す
  let idx = desired;
  if (moving) {
    const old = childElements(parent).indexOf(moving);
    if (old >= 0 && old < desired) idx--;
  }
  idx = Math.max(0, Math.min(idx, kids.length));
  const slots = slotsOf(parent);
  const slotOf = (tg: string) => slots.findIndex((s) => s.tags.includes(tg));
  const mine = slotOf(tag);
  if (mine >= 0) {
    const slot = slots[mine]!;
    const count = kids.filter((c) => slot.tags.includes(c.localName)).length;
    if (slot.max !== undefined && count >= slot.max) return null;
    // 自分より前の枠の要素の後ろ、後ろの枠の要素の前に収める
    let lo = 0;
    let hi = kids.length;
    kids.forEach((c, i) => {
      const s = slotOf(c.localName);
      if (s >= 0 && s < mine) lo = Math.max(lo, i + 1);
      if (s >= 0 && s > mine) hi = Math.min(hi, i);
    });
    if (lo > hi) return null;
    idx = Math.max(lo, Math.min(idx, hi));
  } else if (parent.localName === 'group') {
    // ダイアログ起動ツールはグループの最後に1つだけ
    const launcher = kids.findIndex((c) => c.localName === 'dialogBoxLauncher');
    if (tag === 'dialogBoxLauncher') {
      if (launcher >= 0) return null;
      idx = kids.length;
    } else if (launcher >= 0) {
      idx = Math.min(idx, launcher);
    }
  }
  return idx;
}

/** 同じ親の中に、もう1つ置けるか（複製できるか）。 */
export function canDuplicateEl(el: Element): boolean {
  if (modelApi.canDuplicate) return modelApi.canDuplicate(el);
  const parent = el.parentElement;
  if (!parent) return false;
  return allowedIndex(parent, el.localName, childElements(parent).indexOf(el) + 1) !== null;
}

// ---- 内部クリップボード ----

interface Clip {
  tag: string;
  /** 名前空間の宣言を外した XML。貼り付け先の名前空間で読み直す。 */
  xml: string;
}

let clip: Clip | null = null;

/** 貼り付けられるものがあるか（メニューの有効・無効に使う）。 */
export function hasClip(): boolean {
  return clip !== null;
}

function fragmentXml(el: Element): string {
  // XMLSerializer は断片の根に xmlns を付けるので、貼り付け先の名前空間で読み直せるよう外す
  return new XMLSerializer().serializeToString(el).replace(/^(<[^\s>/]+)\s+xmlns="[^"]*"/, '$1');
}

/** 整形した XML（OS のクリップボード用）。 */
function prettyXml(el: Element): string {
  const ns = el.ownerDocument.documentElement.namespaceURI;
  const tmp = document.implementation.createDocument(ns, null, null);
  tmp.appendChild(tmp.importNode(el, true));
  return serialize(tmp).replace(/^(<[^\s>/]+)\s+xmlns="[^"]*"/, '$1').trimEnd();
}

function selectedTarget(): Element | null {
  const store = app.store;
  const el = store?.selectedElement ?? null;
  if (!store || !el) return null;
  return el;
}

function refuse(message: string): false {
  notify({ kind: 'warning', message });
  return false;
}

function nameOf(el: Element): string {
  return el.getAttribute('label') ?? el.getAttribute('id') ?? el.getAttribute('idMso') ?? titleOf(el.localName);
}

export function copy(): boolean {
  const el = selectedTarget();
  if (!el) return refuse(t('コピーする要素を選択してください'));
  if (el === el.ownerDocument.documentElement) return refuse(t('customUI 全体はコピーできません'));
  clip = { tag: el.localName, xml: fragmentXml(el) };
  // OS のクリップボードへは失敗しても内部には残っているので、通知は出さない
  void navigator.clipboard?.writeText(prettyXml(el)).catch(() => undefined);
  return true;
}

export function cut(): boolean {
  const el = selectedTarget();
  if (!el) return refuse(t('切り取る要素を選択してください'));
  if (!copy()) return false;
  return removeElement(el, t('「{name}」を切り取り', { name: nameOf(el) }), false);
}

/** 重なる id に数字を付けて振り直す（btnRun → btnRun2）。 */
export function renameDuplicateIds(root: Element, used: Set<string>): Map<string, string> {
  const renamed = new Map<string, string>();
  const walk = (x: Element) => {
    const id = x.getAttribute('id');
    if (id) {
      if (used.has(id)) {
        const base = id.replace(/\d+$/, '') || id;
        let n = 2;
        while (used.has(`${base}${n}`)) n++;
        const next = `${base}${n}`;
        x.setAttribute('id', next);
        renamed.set(id, next);
        used.add(next);
      } else {
        used.add(id);
      }
    }
    for (const c of childElements(x)) walk(c);
  };
  walk(root);
  return renamed;
}

/**
 * 置く場所を探す。選択中の要素の中に置けるならその末尾、置けなければ選択中の要素の後ろ、
 * それもだめなら祖先をさかのぼる。
 */
export function findInsertSpot(selected: Element | null, tag: string, doc: Document): { parent: Element; index: number } | null {
  if (!selected) {
    const root = doc.documentElement;
    const i = allowedIndex(root, tag, root.children.length);
    return i === null ? null : { parent: root, index: i };
  }
  const inside = allowedIndex(selected, tag, selected.children.length);
  if (inside !== null) return { parent: selected, index: inside };
  let cur: Element = selected;
  while (cur.parentElement) {
    const parent = cur.parentElement;
    const i = allowedIndex(parent, tag, childElements(parent).indexOf(cur) + 1);
    if (i !== null) return { parent, index: i };
    cur = parent;
  }
  return null;
}

function insertClip(c: Clip, source: Source): boolean {
  const store = app.store;
  if (!store) return false;
  const ns = store.doc.documentElement.namespaceURI ?? '';
  const parsed = parseXml(`<customUI xmlns="${ns}">${c.xml}</customUI>`);
  if (!parsed.ok || !parsed.doc.documentElement.firstElementChild) return refuse(t('貼り付ける内容を読めませんでした'));
  const spot = findInsertSpot(store.selectedElement, c.tag, store.doc);
  if (!spot) {
    const sel = store.selectedElement;
    return refuse(sel ? t('<{tag}> は <{parent}> の中にも後ろにも置けません', { tag: c.tag, parent: sel.localName }) : t('<{tag}> を置ける場所がありません。置き先の要素を選択してください', { tag: c.tag }));
  }
  const parentPath = pathOf(spot.parent);
  return runEdit(source, (doc) => {
    const parent = elementAt(doc, parentPath);
    if (!parent) return undefined;
    const el = doc.importNode(parsed.doc.documentElement.firstElementChild!, true);
    renameDuplicateIds(el, usedIds(doc));
    parent.insertBefore(el, parent.children[spot.index] ?? null);
    return pathOf(el);
  }, t('<{tag}> を貼り付け', { tag: c.tag }));
}

export function paste(source: Source = 'other'): boolean {
  if (!app.store) return false;
  if (!clip) return refuse(t('貼り付ける要素がありません。先にコピーしてください'));
  return insertClip(clip, source);
}

export function duplicate(source: Source = 'other'): boolean {
  const store = app.store;
  const el = selectedTarget();
  if (!store || !el) return refuse(t('複製する要素を選択してください'));
  if (el === el.ownerDocument.documentElement) return refuse(t('customUI 全体は複製できません'));
  if (!canDuplicateEl(el)) return refuse(t('<{tag}> はこの場所に1つしか置けません', { tag: el.localName }));
  const path = pathOf(el);
  return runEdit(source, (doc) => {
    const target = elementAt(doc, path);
    if (!target?.parentElement) return undefined;
    const copyEl = target.cloneNode(true) as Element;
    renameDuplicateIds(copyEl, usedIds(doc));
    target.parentElement.insertBefore(copyEl, target.nextElementSibling);
    return pathOf(copyEl);
  }, t('「{name}」を複製', { name: nameOf(el) }));
}

function removeElement(el: Element, label: string, offerUndo: boolean, source: Source = 'other'): boolean {
  const store = app.store;
  if (!store) return false;
  if (el === el.ownerDocument.documentElement) return refuse(t('customUI は削除できません'));
  const path = pathOf(el);
  const ok = runEdit(source, (doc) => {
    const target = elementAt(doc, path);
    if (!target?.parentElement) return undefined;
    const parent = target.parentElement;
    const next = target.nextElementSibling ?? target.previousElementSibling;
    target.remove();
    // 削除後の選択：次の兄弟、なければ前の兄弟、なければ親
    return next ? pathOf(next) : pathOf(parent);
  }, label);
  if (ok && offerUndo) {
    notify({ kind: 'info', message: t('{label}しました', { label }), action: { label: t('元に戻す'), run: () => app.store?.undo() } });
  }
  return ok;
}

export function removeSelected(source: Source = 'other'): boolean {
  const el = selectedTarget();
  if (!el) return refuse(t('削除する要素を選択してください'));
  return removeElement(el, t('「{name}」を削除', { name: nameOf(el) }), true, source);
}

/** 兄弟の中で1つ前・後ろへ動かす。並び順の決まりで動かせなければ通知する。 */
export function moveSelected(delta: -1 | 1, source: Source = 'other'): boolean {
  const el = selectedTarget();
  const parent = el?.parentElement;
  if (!el || !parent) return false;
  const idx = childElements(parent).indexOf(el);
  const to = idx + delta;
  if (to < 0 || to >= parent.children.length) return false;
  // moveElement の index は「移動前の並びで、その要素の前に差し込む位置」
  const insertBefore = delta < 0 ? to : to + 1;
  const allowed = allowedIndex(parent, el.localName, insertBefore, el);
  const expected = delta < 0 ? to : idx + 1;
  if (allowed !== expected) return refuse(t('<{tag}> はこれ以上動かせません（並び順の決まりがあります）', { tag: el.localName }));
  const path = pathOf(el);
  return runEdit(source, (doc) => {
    const target = elementAt(doc, path);
    const p = target?.parentElement;
    if (!target || !p) return undefined;
    const ref = delta < 0 ? target.previousElementSibling : target.nextElementSibling?.nextElementSibling ?? null;
    p.insertBefore(target, ref);
    return pathOf(target);
  }, delta < 0 ? t('「{name}」を上へ移動', { name: nameOf(el) }) : t('「{name}」を下へ移動', { name: nameOf(el) }));
}

/** 動かせるか（メニューの有効・無効用）。 */
export function canMove(el: Element, delta: -1 | 1): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  const idx = childElements(parent).indexOf(el);
  const to = idx + delta;
  if (to < 0 || to >= parent.children.length) return false;
  return allowedIndex(parent, el.localName, delta < 0 ? to : to + 1, el) === (delta < 0 ? to : idx + 1);
}

/** 新しい要素を parent の index 番目（並び順に合わせて調整）に作って選択する。 */
export function insertNew(parentPath: Path, tag: string, index: number | null, source: Source = 'other'): boolean {
  const store = app.store;
  const parent = store ? elementAt(store.doc, parentPath) : null;
  if (!store || !parent) return false;
  const at = allowedIndex(parent, tag, index ?? parent.children.length);
  if (at === null) return refuse(t('<{tag}> は <{parent}> の中に置けません', { tag, parent: parent.localName }));
  return runEdit(source, (doc) => {
    const p = elementAt(doc, parentPath);
    if (!p) return undefined;
    const el = createElement(doc, tag, p);
    p.insertBefore(el, p.children[at] ?? null);
    return pathOf(el);
  }, t('{name}を追加', { name: titleOf(tag) }));
}

/** 要素の直前に置ける新しい要素の種類（親の定義から）。 */
export function siblingTags(el: Element): string[] {
  const parent = el.parentElement;
  if (!parent) return [];
  const idx = childElements(parent).indexOf(el);
  return (defFor(parent)?.children ?? []).filter((tg) => allowedIndex(parent, tg, idx) !== null);
}

/** 要素の中に追加できる新しい要素の種類。 */
export function childTags(el: Element): string[] {
  return (defFor(el)?.children ?? []).filter((tg) => allowedIndex(el, tg, el.children.length) !== null);
}

/** id（なければ idMso / idQ）をコピーする。 */
export function copyId(): boolean {
  const el = selectedTarget();
  const id = el ? el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ') : null;
  if (!id) return refuse(t('この要素には id がありません'));
  copyText(id, t('{value} をコピーしました', { value: id }));
  return true;
}

// ---- キーボードとコマンド ----

export type EditCommand = 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete';

export function runCommand(command: EditCommand, source: Source = 'other'): boolean {
  switch (command) {
    case 'cut':
      return cut();
    case 'copy':
      return copy();
    case 'paste':
      return paste(source);
    case 'duplicate':
      return duplicate(source);
    case 'delete':
      return removeSelected(source);
  }
}

/** 入力欄や Monaco の中のキーか（そこでは編集コマンドを横取りしない）。 */
export function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.closest('.monaco-editor') !== null || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * キャンバス・ツリーで Ctrl+X / C / V / D と Delete を処理する。処理したら true（呼び出し側で既定の動作を止める）。
 * アプリ全体のショートカット（main.ts）と二重に動かないよう、処理したキーは伝播も止める。
 */
export function handleEditKey(e: KeyboardEvent, source: Source): boolean {
  if (e.isComposing || isTextTarget(e.target) || !app.store) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let command: EditCommand | null = null;
  if (ctrl && !e.shiftKey && !e.altKey) {
    if (k === 'x') command = 'cut';
    else if (k === 'c') command = 'copy';
    else if (k === 'v') command = 'paste';
    else if (k === 'd') command = 'duplicate';
  } else if (!ctrl && !e.altKey && e.key === 'Delete') {
    command = 'delete';
  }
  if (!command) return false;
  e.preventDefault();
  e.stopPropagation();
  runCommand(command, source);
  return true;
}

// メニューバーやコマンドパレットからは、この CustomEvent で呼べるようにする（モジュールの依存を増やさないため）
if (typeof window !== 'undefined') {
  window.addEventListener('sash:command', (e) => {
    const command = (e as CustomEvent<{ command?: string }>).detail?.command;
    if (command === 'cut' || command === 'copy' || command === 'paste' || command === 'duplicate' || command === 'delete') runCommand(command);
  });
}
