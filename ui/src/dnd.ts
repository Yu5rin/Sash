// キャンバスとツリーで共有するドラッグ＆ドロップの状態。
// dragover の間は dataTransfer の中身を読めないため、運んでいるものをここに持つ。

import { app } from './app';
import { createElement, elementAt, ensureTabs, moveElement, pathOf, type Path } from './model';
import { canContain } from './schema';

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
  if (!tag || !canContain(parent.localName, tag)) return false;
  if (current?.kind === 'move') {
    const moving = elementAt(doc, current.path);
    if (!moving || moving === parent || moving.contains(parent)) return false;
  }
  return true;
}

/** ドロップを確定する。parentPath が null ならタブ一覧（customUI > ribbon > tabs）を指す。 */
export function drop(parentPath: Path | null, index: number, source: 'canvas' | 'tree'): void {
  const store = app.store;
  const payload = current;
  current = null;
  if (!store || !payload) return;
  store.edit(source, (doc) => {
    const parent = parentPath === null ? ensureTabs(doc) : elementAt(doc, parentPath);
    if (!parent) return undefined;
    if (payload.kind === 'new') {
      const el = createElement(doc, payload.tag);
      if (!canContain(parent.localName, el.localName)) return undefined;
      parent.insertBefore(el, parent.children[index] ?? null);
      return pathOf(el);
    }
    const el = elementAt(doc, payload.path);
    if (!el || !moveElement(el, parent, index)) return undefined;
    return pathOf(el);
  });
}
