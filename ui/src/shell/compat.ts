// U1（store.ts / model.ts）で並行して作っている API を、シェルから呼ぶための窓口。
// 取り決めた形（PartStore.edit の label と戻り値、insertSmart、pendingImageChanges、saveSnapshot など）を
// 名前空間から引き、まだ入っていない版でも従来の動きで代わりをする。両方そろったら直接呼ぶ形にしてよい。

import * as modelModule from '../model';
import * as storeModule from '../store';
import { childElements, createElement, ensureBackstage, ensureContextMenus, ensureTabs, pathOf, type Path } from '../model';
import { canContainEl, inBackstage, titleOf } from '../schema';
import type { ImageEntry, PartStore, Source } from '../store';
import { t } from '../i18n';

type EditFn = (doc: Document) => Path | null | void | symbol;
type InsertResult = { el: Element } | { error: string };

interface StoreContract {
  edit(source: Source, fn: EditFn, label?: string): boolean | void;
  undoLabel?: string | null;
  redoLabel?: string | null;
  pendingImageChanges?: () => { add: ImageEntry[]; remove: string[] };
  saveSnapshot?: () => unknown;
  markSaved(snapshot?: unknown): void;
}

const storeExports = storeModule as unknown as { ABORT?: symbol; setEditRefusedHandler?: (fn: (message: string) => void) => void };
const modelExports = modelModule as unknown as {
  insertSmart?: (doc: Document, selected: Element | null, tag: string) => InsertResult;
  canDuplicate?: (el: Element) => boolean;
};

/** 編集を中止するときに fn から返す値（U1 の ABORT。まだなければ undefined を返して選択だけ保つ）。 */
export const ABORT: symbol | undefined = storeExports.ABORT;

/** 履歴に名前を付けて編集する。編集されたら true。 */
export function editWithLabel(store: PartStore, source: Source, fn: EditFn, label: string): boolean {
  const r = (store as unknown as StoreContract).edit(source, fn, label);
  return r !== false;
}

export function undoLabel(store: PartStore | null): string | null {
  return (store as unknown as StoreContract | null)?.undoLabel ?? null;
}

export function redoLabel(store: PartStore | null): string | null {
  return (store as unknown as StoreContract | null)?.redoLabel ?? null;
}

/** XML の構文エラー中などで編集が断られたときの知らせ先を登録する。 */
export function setEditRefusedHandler(fn: (message: string) => void): void {
  storeExports.setEditRefusedHandler?.(fn);
}

/** 保存時に追加・削除する画像。 */
export function pendingImageChanges(store: PartStore): { add: ImageEntry[]; remove: string[] } {
  const s = store as unknown as StoreContract;
  if (s.pendingImageChanges) return s.pendingImageChanges();
  return { add: [...store.images.values()].filter((i) => i.isNew), remove: [...store.removedImages] };
}

/** 保存を始める前の状態。保存中に加えた編集を「保存済み」にしないために、ホストを待つ前に取る。 */
export function saveSnapshot(store: PartStore): unknown {
  return (store as unknown as StoreContract).saveSnapshot?.();
}

export function markSaved(store: PartStore, snapshot: unknown): void {
  (store as unknown as StoreContract).markSaved(snapshot);
}

export function canDuplicate(el: Element | null): boolean {
  if (!el) return false;
  if (modelExports.canDuplicate) return modelExports.canDuplicate(el);
  return el !== el.ownerDocument.documentElement && el.parentElement !== null && !['customUI', 'ribbon', 'tabs', 'backstage', 'contextMenus', 'qat', 'commands'].includes(el.localName);
}

/**
 * 選択中の場所に合わせて要素を追加する（足りない親は作る）。store.edit の中で呼ぶ。
 * U1 の insertSmart があればそれを使い、なければ従来のパレットと同じ規則で置く。
 */
export function insertSmart(doc: Document, selected: Element | null, tag: string): InsertResult {
  if (modelExports.insertSmart) return modelExports.insertSmart(doc, selected, tag);
  if (tag === 'backstage') {
    const existing = childElements(doc.documentElement).find((c) => c.localName === 'backstage');
    if (existing) return { error: t('Backstage はすでにあります') };
    const bs = createElement(doc, 'backstage');
    ensureBackstage(doc).replaceWith(bs);
    return { el: bs };
  }
  if (tag === 'tab' && !inBackstage(selected)) {
    const el = createElement(doc, tag);
    ensureTabs(doc).append(el);
    return { el };
  }
  if (tag === 'contextMenu') {
    const el = createElement(doc, tag);
    ensureContextMenus(doc).append(el);
    return { el };
  }
  let cur: Element | null = selected;
  let after: Element | null = null;
  while (cur) {
    if (canContainEl(cur, tag)) {
      const placed = createElement(doc, tag, cur);
      cur.insertBefore(placed, after?.nextElementSibling ?? null);
      return { el: placed };
    }
    after = cur;
    cur = cur.parentElement;
  }
  return { error: selected ? t('選択中の場所には「{name}」を置けません', { name: titleOf(tag) }) : t('「{name}」を置く場所を選択してください', { name: titleOf(tag) }) };
}

/**
 * 追加できるかを、文書の写しで試して確かめる（パレットの項目を無効表示にするため）。
 * 置けないときは理由を返す。
 */
export function probeInsert(doc: Document, selection: Path | null, tag: string): string | null {
  const copy = doc.cloneNode(true) as Document;
  const selected = selection ? modelModule.elementAt(copy, selection) : null;
  const r = insertSmart(copy, selected, tag);
  return 'error' in r ? r.error : null;
}

/** 選択中の場所に追加する。追加できなければ理由を返す。 */
export function insertAtSelection(store: PartStore, tag: string, label: string): { ok: true } | { ok: false; error: string } {
  let error: string | null = null;
  // ABORT がない版では、写しで先に確かめてから本物を編集する（失敗した編集を履歴に残さないため）
  if (ABORT === undefined) {
    const reason = probeInsert(store.doc, store.selection, tag);
    if (reason) return { ok: false, error: reason };
  }
  const done = editWithLabel(store, 'canvas', (doc) => {
    const selected = store.selection ? modelModule.elementAt(doc, store.selection) : null;
    const r = insertSmart(doc, selected, tag);
    if ('error' in r) {
      error = r.error;
      return ABORT ?? undefined;
    }
    return pathOf(r.el);
  }, label);
  if (error !== null) return { ok: false, error };
  // 断られた理由（XML の構文エラーなど）は setEditRefusedHandler の側で知らせるので、ここでは空にする
  if (!done) return { ok: false, error: '' };
  return { ok: true };
}
