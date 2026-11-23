// キャンバスとツリーで共有するドラッグ＆ドロップの状態。
// dragover の間は dataTransfer の中身を読めないため、運んでいるものをここに持つ。

import { app } from './app';
import { allowedInsertIndex, createElement, elementAt, ensureBackstage, ensureContextMenus, ensureTabs, insertAt, moveElement, pathOf, type Path } from './model';
import { canContainEl, titleOf } from './schema';
import { ABORT } from './store';
import { t } from './i18n';

export type DragPayload = { kind: 'new'; tag: string } | { kind: 'move'; path: Path };

let current: DragPayload | null = null;

export function startDrag(e: DragEvent, payload: DragPayload): void {
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

/** parent の index 番目に置けるか。 */
export function canDropInto(doc: Document, parent: Element): boolean {
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
 * 'contextMenus' ならコンテキストメニューの一覧を指す（なければ作る）。
 */
export function drop(parentPath: Path | null | 'contextMenus' | 'backstage', index: number, source: 'canvas' | 'tree'): void {
  const store = app.store;
  const payload = current;
  current = null;
  if (!store || !payload) return;
  const tag = payload.kind === 'new' ? payload.tag : elementAt(store.doc, payload.path)?.localName ?? '';
  const label = payload.kind === 'new' ? t('{name}の追加', { name: titleOf(tag) }) : t('{name}の移動', { name: titleOf(tag) });
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
