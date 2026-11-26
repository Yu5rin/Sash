// キャンバスとツリーで共有するドラッグ＆ドロップの状態。
// dragover の間は dataTransfer の中身を読めないため、運んでいるものをここに持つ。

import { app } from './app';
import { allowedInsertIndex, createElement, elementAt, ensureBackstage, ensureContextMenus, ensureTabs, insertAt, moveElement, pathOf, samePath, type Path } from './model';
import { canContainEl, titleOf } from './schema';
import { ABORT, reportRefusal, selectMany } from './store';
import { elementsAt, moveManyReason, moveManyTo } from './multiEdit';
import { t } from './i18n';

/**
 * 運んでいるもの。move の paths は、複数選択をまとめて運ぶときの全部（文書の順、path を含む。仕様書 §19）。
 * paths がなければ path の1つだけを運ぶ。
 */
export type DragPayload = { kind: 'new'; tag: string } | { kind: 'move'; path: Path; paths?: Path[] };

let current: DragPayload | null = null;

/**
 * ドラッグを始める。複数選択の中の要素をつかんだら、選んでいる要素をまとめて運ぶ。
 * 選んでいない要素をつかんだら、その1つだけを運ぶ（エクスプローラーと同じ）。
 */
export function startDrag(e: DragEvent, payload: DragPayload): void {
  const store = app.store;
  if (payload.kind === 'move' && !payload.paths && store?.isMulti && store.isSelected(payload.path)) {
    payload = { ...payload, paths: [...store.selections] };
  }
  current = payload;
  e.dataTransfer?.setData('text/plain', payload.kind === 'new' ? payload.tag : 'sash-move');
  if (e.dataTransfer) e.dataTransfer.effectAllowed = payload.kind === 'new' ? 'copy' : 'move';
}

export function endDrag(): void {
  current = null;
}

export function dragPayload(): DragPayload | null {
  return current;
}

/** 運んでいるものの要素名。 */
export function draggedTag(doc: Document): string | null {
  if (!current) return null;
  if (current.kind === 'new') return current.tag;
  return elementAt(doc, current.path)?.localName ?? null;
}

/** まとめて運んでいる要素（1つだけなら null）。 */
function movingMany(doc: Document): Element[] | null {
  return current?.kind === 'move' && current.paths && current.paths.length > 1 ? elementsAt(doc, current.paths) : null;
}

/** 運んでいる数（ドロップ先の表示に使う）。 */
export function draggedCount(): number {
  return current?.kind === 'move' ? current.paths?.length ?? 1 : current ? 1 : 0;
}

/**
 * parentPath の index 番目に、まとめて運んでいる要素を置けるか（並び順と個数まで確かめる）。
 * 1つだけ運んでいるときは常に true（並び順は呼び出し側がこれまでどおり確かめる）。
 */
export function canDropManyAt(doc: Document, parentPath: Path, index: number): boolean {
  if (current?.kind !== 'move' || !current.paths || current.paths.length < 2) return true;
  return moveManyReason(doc, current.paths, parentPath, index) === null;
}

/** parent の index 番目に置けるか。 */
export function canDropInto(doc: Document, parent: Element): boolean {
  const many = movingMany(doc);
  if (many) {
    // まとめて運ぶときは、全部が入れられる親で、運ぶ要素の中（子孫）ではないときだけ
    return many.every((m) => m !== parent && !m.contains(parent) && canContainEl(parent, m.localName));
  }
  const tag = draggedTag(doc);
  if (!tag || !canContainEl(parent, tag)) return false;
  let moving: Element | null = null;
  if (current?.kind === 'move') {
    moving = elementAt(doc, current.path);
    if (!moving || moving === parent || moving.contains(parent)) return false;
  }
  // 個数の上限（dialogBoxLauncher は1つまで など）に達していれば、ドロップ先の表示を出さない
  return allowedInsertIndex(parent, tag, parent.children.length, moving ?? undefined) !== null;
}

/**
 * ドロップを確定する。parentPath が null ならタブ一覧（customUI > ribbon > tabs）、
 * 'contextMenus' なら右クリックメニューの一覧を指す（なければ作る）。
 */
export function drop(parentPath: Path | null | 'contextMenus' | 'backstage', index: number, source: 'canvas' | 'tree'): void {
  const store = app.store;
  const payload = current;
  current = null;
  if (!store || !payload) return;
  if (payload.kind === 'move' && payload.paths && payload.paths.length > 1) {
    dropMany(payload.paths, payload.path, parentPath, index, source);
    return;
  }
  const tag = payload.kind === 'new' ? payload.tag : elementAt(store.doc, payload.path)?.localName ?? '';
  const label = payload.kind === 'new' ? t('{name}を追加', { name: titleOf(tag) }) : t('{name}を移動', { name: titleOf(tag) });
  store.edit(source, (doc) => {
    const parent =
      parentPath === null ? ensureTabs(doc)
      : parentPath === 'contextMenus' ? ensureContextMenus(doc)
      : parentPath === 'backstage' ? (payload.kind === 'new' && payload.tag === 'backstage' ? doc.documentElement : ensureBackstage(doc))
      : elementAt(doc, parentPath);
    // 置けないときは ABORT で取り消す（ensureTabs などで作りかけた親も残さない）
    if (!parent) return ABORT;
    if (payload.kind === 'new') {
      if (!canContainEl(parent, payload.tag)) return ABORT;
      // 子要素の順序（customUI の中の ribbon → backstage → contextMenus、グループの dialogBoxLauncher は末尾など）に収める
      const at = allowedInsertIndex(parent, payload.tag, index);
      if (at === null) return ABORT;
      const el = createElement(doc, payload.tag, parent);
      insertAt(parent, el, at);
      return pathOf(el);
    }
    const el = elementAt(doc, payload.path);
    if (!el || !moveElement(el, parent, index)) return ABORT;
    return pathOf(el);
  }, label);
}

/**
 * まとめて運んだ要素を落とす。1つでも置けないものがあれば何も動かさず、理由を知らせる。
 * 運んだ要素は選んだままにし、つかんでいた要素を主な選択にする。
 */
function dropMany(paths: Path[], grabbed: Path, parentPath: Path | null | 'contextMenus' | 'backstage', index: number, source: 'canvas' | 'tree'): void {
  const store = app.store;
  if (!store) return;
  let failure: string | null = null;
  const grabbedIndex = paths.findIndex((p) => samePath(p, grabbed));
  store.edit(source, (doc) => {
    const parent =
      parentPath === null ? ensureTabs(doc)
      : parentPath === 'contextMenus' ? ensureContextMenus(doc)
      : parentPath === 'backstage' ? ensureBackstage(doc)
      : elementAt(doc, parentPath);
    if (!parent) return ABORT;
    const r = moveManyTo(doc, paths, parent, index);
    if ('error' in r) {
      failure = r.error;
      return ABORT;
    }
    return selectMany(r.paths, r.paths[grabbedIndex] ?? r.paths.at(-1));
  }, t('{n} 個の要素を移動', { n: paths.length }));
  if (failure) reportRefusal(failure);
}
