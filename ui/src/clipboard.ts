// 要素の切り取り・コピー・貼り付け・複製・削除と、その周辺の編集操作（キャンバスとツリーで共有する）。
// コピーした要素は XML の文字列として内部に持つ。DOM の参照を持つと、Undo で文書が作り直されたときに
// 古い文書の要素を指したままになるため。OS のクリップボードにも、他のツールに貼れるよう XML を書く（失敗しても無視）。

import { app } from './app';
import { allowedInsertIndex, canDuplicate, childElements, createElement, duplicateElement, elementAt, importElement, parseXml, pathOf, renameDuplicateIds, serialize, usedIds, type Path } from './model';
import { canContainEl, defFor, titleOf } from './schema';
import type { Change, Source } from './store';
import { t } from './i18n';
import { toast, type ToastKind as ShellToastKind } from './shell/toast';

// ---- 通知 ----

export type ToastKind = ShellToastKind;
export interface ToastOptions {
  kind: ToastKind;
  message: string;
  action?: { label: string; run: () => void };
  timeout?: number;
}

/** 通知を出す（シェルの通知に渡す）。ビューからはこれを通して、通知の出し方を一か所にまとめる。 */
export function notify(o: ToastOptions): void {
  toast(o);
}

/** OS のクリップボードに書く。失敗したら通知する（WebView2 ではフォーカスがないと失敗することがある）。 */
export function copyText(text: string, message: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => notify({ kind: 'success', message }))
    .catch((e: unknown) => notify({ kind: 'error', message: t('クリップボードにコピーできませんでした：{message}', { message: e instanceof Error ? e.message : String(e) }) }));
}

// ---- ストアへの編集 ----

/** store.edit を呼ぶ（履歴の名前を必ず付けるため、ビューからはこれを通す）。変更しなかった・断られたら false。 */
export function runEdit(source: Source, fn: (doc: Document) => Path | null | void, label: string): boolean {
  return app.store?.edit(source, fn, label) ?? false;
}

// ---- 置ける位置 ----

/**
 * parent の desired 番目（今の子要素の並びでの位置）に tag を置けるなら、実際に置く位置を返す。置けなければ null。
 * 並び順と個数は model の allowedInsertIndex に任せ、置ける親かどうかと、グループのダイアログ起動ツール
 * （最後に1つだけ）をここで足して確かめる。moving には移動中の要素を渡す（自分を数えないため）。
 */
export function allowedIndex(parent: Element, tag: string, desired: number, moving: Element | null = null): number | null {
  if (!canContainEl(parent, tag)) return null;
  let idx = allowedInsertIndex(parent, tag, desired, moving ?? undefined);
  if (idx === null) return null;
  if (parent.localName === 'group') {
    const kids = childElements(parent);
    const launcher = kids.findIndex((c) => c.localName === 'dialogBoxLauncher' && c !== moving);
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
  return canDuplicate(el);
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

// 重なる id の振り直しは、複製（model.duplicateElement）と同じ決まりにするため model に置いている
export { renameDuplicateIds };

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
    const el = importElement(doc, parsed.doc.documentElement.firstElementChild!);
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
    if (!target?.parentElement || !canDuplicate(target)) return undefined;
    return pathOf(duplicateElement(target));
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
  if (ok && offerUndo) offerUndoToast(t('{label}しました', { label }));
  return ok;
}

/**
 * 「元に戻す」付きの通知を出す。そのあとに別の編集・元に戻す・やり直しがあったら通知を閉じる。
 * 残しておくと、押したときに取り消されるのが削除ではなく、その後の別の操作になってしまうため。
 */
function offerUndoToast(message: string): void {
  const handle = toast({ kind: 'info', message, action: { label: t('元に戻す'), run: () => app.store?.undo() } });
  const watch = (c?: Change) => {
    // 選択が変わっただけなら残す（削除のあとに別の要素を選ぶのはよくあるため）
    if (c && !c.kinds.has('doc') && !c.kinds.has('images')) return;
    app.off('store', watch);
    app.off('session', watch);
    handle.close();
  };
  app.on('store', watch);
  app.on('session', watch);
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
  if (allowed !== insertBefore) return refuse(t('<{tag}> はこれ以上動かせません（並び順の決まりがあります）', { tag: el.localName }));
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
  const insertBefore = delta < 0 ? to : to + 1;
  return allowedIndex(parent, el.localName, insertBefore, el) === insertBefore;
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
  // 並び順の決まりで別の位置にずれるもの（グループのダイアログ起動ツールなど）は「前に挿入」には出さない
  return (defFor(parent)?.children ?? []).filter((tg) => allowedIndex(parent, tg, idx) === idx);
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
