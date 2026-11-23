// シェル（メニュー・パレット・保存）から store.ts / model.ts の編集 API を呼ぶための薄い窓口。
// 「選択中の場所に追加する」「置けるかを写しで試す」のように、シェルの複数の場所で同じ手順を使うものをまとめる。

import { elementAt, insertSmart, pathOf, type Path } from '../model';
import { ABORT, type ImageEntry, type PartStore } from '../store';

export { canDuplicate, insertSmart } from '../model';
export { ABORT, setEditRefusedHandler } from '../store';

/** 保存時に送る画像の差分を、ホストに渡す形（id と base64）にする。 */
export function imagesToSend(add: readonly ImageEntry[]): { id: string; base64: string }[] {
  return add.map((i) => ({ id: i.id, base64: i.dataUrl.slice(i.dataUrl.indexOf(',') + 1) }));
}

/**
 * 追加できるかを、文書の写しで試して確かめる（パレットの項目を無効表示にするため）。
 * 置けないときは理由を返す。
 */
export function probeInsert(doc: Document, selection: Path | null, tag: string): string | null {
  const copy = doc.cloneNode(true) as Document;
  const selected = selection ? elementAt(copy, selection) : null;
  const r = insertSmart(copy, selected, tag);
  return 'error' in r ? r.error : null;
}

/** 選択中の場所に追加する。追加できなければ理由を返す（断られた理由は setEditRefusedHandler で知らせるので空）。 */
export function insertAtSelection(store: PartStore, tag: string, label: string): { ok: true } | { ok: false; error: string } {
  let error: string | null = null;
  const done = store.edit('canvas', (doc) => {
    const selected = store.selection ? elementAt(doc, store.selection) : null;
    const r = insertSmart(doc, selected, tag);
    if ('error' in r) {
      error = r.error;
      return ABORT;
    }
    return pathOf(r.el);
  }, label);
  if (error !== null) return { ok: false, error };
  if (!done) return { ok: false, error: '' };
  return { ok: true };
}
