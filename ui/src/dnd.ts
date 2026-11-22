// キャンバスとツリーで共有するドラッグ＆ドロップの状態。
// dragover の間は dataTransfer の中身を読めないため、運んでいるものをここに持つ。

import { app } from './app';
import { createElement, elementAt, ensureBackstage, ensureContextMenus, ensureTabs, moveElement, pathOf, type Path } from './model';
import { canContainEl } from './schema';

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
  if (current?.kind === 'move') {
    const moving = elementAt(doc, current.path);
    if (!moving || moving === parent || moving.contains(parent)) return false;
  }
  return true;
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
  store.edit(source, (doc) => {
    const parent =
      parentPath === null ? ensureTabs(doc)
      : parentPath === 'contextMenus' ? ensureContextMenus(doc)
      : parentPath === 'backstage' ? (payload.kind === 'new' && payload.tag === 'backstage' ? doc.documentElement : ensureBackstage(doc))
      : elementAt(doc, parentPath);
    if (!parent) return undefined;
    if (payload.kind === 'new') {
      if (!canContainEl(parent, payload.tag)) return undefined;
      const el = createElement(doc, payload.tag, parent);
      if (payload.tag === 'backstage') {
        // customUI の中の順序（ribbon の後ろ、contextMenus の前）に合わせる
        if (Array.from(parent.children).some((c) => c.localName === 'backstage')) return undefined;
        parent.insertBefore(el, Array.from(parent.children).find((c) => c.localName === 'contextMenus') ?? null);
        return pathOf(el);
      }
      parent.insertBefore(el, parent.children[index] ?? null);
      return pathOf(el);
    }
    const el = elementAt(doc, payload.path);
    if (!el || !moveElement(el, parent, index)) return undefined;
    return pathOf(el);
  });
}
