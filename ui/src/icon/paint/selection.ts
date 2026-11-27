// 選択（マスク）と、浮いた選択（持ち上げ・移動・確定）、コピー・貼り付け。DOM に触らない。
// 浮いた選択を確定するとき、透明な部分は下の絵を消さない（blendOver）。はみ出した部分は捨てる。

import { TRANSPARENT, type Rgba } from './color';
import type { Floating, PaintDoc } from './doc';
import { blendOver, clonePixels, createPixels, getPixel, inBounds, setPixel, type Pixels } from './pixels';
import { fitWithin } from './transform';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 2 つの角（両端を含む。順序は問わない）の四角形のマスク。範囲の外は切る。 */
export function maskRect(size: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(size * size);
  const minX = Math.max(0, Math.min(x0, x1));
  const maxX = Math.min(size - 1, Math.max(x0, x1));
  const minY = Math.max(0, Math.min(y0, y1));
  const maxY = Math.min(size - 1, Math.max(y0, y1));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) m[y * size + x] = 255;
  return m;
}

export function maskAll(size: number): Uint8Array {
  return new Uint8Array(size * size).fill(255);
}

/** マスクの囲み（正方形 size × size）。空なら null。 */
export function maskBounds(mask: Uint8Array, size: number): Rect | null {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) continue;
    const x = i % size;
    const y = Math.floor(i / size);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 小さなマスク（fw × fh）を、絵の (x, y) に置いた、絵と同じ大きさのマスク。 */
export function placeMask(small: Uint8Array, fw: number, fh: number, x: number, y: number, size: number): Uint8Array {
  const m = new Uint8Array(size * size);
  for (let yy = 0; yy < fh; yy++) {
    for (let xx = 0; xx < fw; xx++) {
      if (small[yy * fw + xx] === 0) continue;
      const dx = x + xx;
      const dy = y + yy;
      if (dx >= 0 && dy >= 0 && dx < size && dy < size) m[dy * size + dx] = 255;
    }
  }
  return m;
}

/** 点が選択の中か。選択がなければ全体が対象なので、範囲の中ならいつも true。 */
export function inSelection(doc: PaintDoc, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= doc.size || y >= doc.size) return false;
  return doc.selection === null || doc.selection[y * doc.size + x] !== 0;
}

export function selectRect(doc: PaintDoc, x0: number, y0: number, x1: number, y1: number): void {
  doc.selection = maskRect(doc.size, x0, y0, x1, y1);
}

export function selectAll(doc: PaintDoc): void {
  doc.selection = maskAll(doc.size);
}

/** 選択を外す（浮いた選択は、先に dropFloating で確定しておく）。 */
export function deselect(doc: PaintDoc): void {
  doc.selection = null;
}

function syncSelection(doc: PaintDoc): void {
  const f = doc.floating;
  if (f) doc.selection = placeMask(f.mask, f.pixels.width, f.pixels.height, f.x, f.y, doc.size);
}


/**
 * 選択の中身を持ち上げて、浮いた選択にする。duplicate なら元の場所は残し、そうでなければ透明にする。
 * 選択がない・空のとき、すでに浮いているときは何もしない。持ち上げたら true。
 */
export function liftSelection(doc: PaintDoc, duplicate: boolean): boolean {
  if (doc.floating || !doc.selection) return false;
  const b = maskBounds(doc.selection, doc.size);
  if (!b) return false;
  const pixels = createPixels(b.width, b.height);
  const mask = new Uint8Array(b.width * b.height);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (doc.selection[(b.y + y) * doc.size + b.x + x] === 0) continue;
      mask[y * b.width + x] = 255;
      const c = getPixel(doc.pixels, b.x + x, b.y + y);
      setPixel(pixels, x, y, c);
      if (!duplicate) setPixel(doc.pixels, b.x + x, b.y + y, TRANSPARENT);
    }
  }
  doc.floating = { pixels, mask, x: b.x, y: b.y };
  return true;
}

/** 浮いた選択の位置を変える（選択の枠も一緒に動く）。 */
export function setFloatingPos(doc: PaintDoc, x: number, y: number): void {
  if (!doc.floating) return;
  doc.floating.x = x;
  doc.floating.y = y;
  syncSelection(doc);
}

/** 浮いた選択を絵に重ねて確定する。選択の枠は今の位置に残る。確定したら true。 */
export function dropFloating(doc: PaintDoc): boolean {
  const f = doc.floating;
  if (!f) return false;
  blendOver(doc.pixels, f.pixels, f.x, f.y);
  doc.floating = null;
  const m = placeMask(f.mask, f.pixels.width, f.pixels.height, f.x, f.y, doc.size);
  // 全部が絵の外へ出たときは、空の選択を残さない（空の選択が残ると、どこにも描けなくなる）
  doc.selection = maskBounds(m, doc.size) ? m : null;
  return true;
}

/** 選択の中身を透明にする。浮いていれば、浮いたものを捨てる。何かしたら true。 */
export function deleteSelection(doc: PaintDoc): boolean {
  if (doc.floating) {
    doc.floating = null;
    // 全部が絵の外へ出ていたら、空の選択を残さない（残すと、どこにも描けなくなる）
    if (doc.selection && !maskBounds(doc.selection, doc.size)) doc.selection = null;
    return true;
  }
  if (!doc.selection) return false;
  let changed = false;
  for (let i = 0; i < doc.selection.length; i++) {
    if (doc.selection[i] === 0) continue;
    const x = i % doc.size;
    const y = Math.floor(i / doc.size);
    if (getPixel(doc.pixels, x, y).a !== 0) changed = true;
    setPixel(doc.pixels, x, y, TRANSPARENT);
  }
  return changed;
}

/** 選択の中身の複製（選択の外は透明）。選択がなければ null。浮いていれば、浮いたものを返す。 */
export function copySelection(doc: PaintDoc): Pixels | null {
  if (doc.floating) return clonePixels(doc.floating.pixels);
  if (!doc.selection) return null;
  const b = maskBounds(doc.selection, doc.size);
  if (!b) return null;
  const out = createPixels(b.width, b.height);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (doc.selection[(b.y + y) * doc.size + b.x + x] !== 0) setPixel(out, x, y, getPixel(doc.pixels, b.x + x, b.y + y));
    }
  }
  return out;
}

/** 画像を、絵の中央に浮いた選択として置く。大きければ収まる大きさに縮める。先に浮いているものは確定する。 */
export function pasteAsFloating(doc: PaintDoc, px: Pixels): void {
  dropFloating(doc);
  const fitted = fitWithin(px, doc.size);
  const x = Math.floor((doc.size - fitted.width) / 2);
  const y = Math.floor((doc.size - fitted.height) / 2);
  doc.floating = { pixels: clonePixels(fitted), mask: new Uint8Array(fitted.width * fitted.height).fill(255), x, y };
  syncSelection(doc);
}

/** 見たままの色（浮いた選択を含む）。範囲の外は透明。スポイトが使う。 */
export function sampleDoc(doc: PaintDoc, x: number, y: number): Rgba {
  const f = doc.floating;
  if (f && inBounds(f.pixels, x - f.x, y - f.y)) {
    const c = getPixel(f.pixels, x - f.x, y - f.y);
    if (c.a === 255) return c;
    if (c.a > 0) {
      // 半透明なら、下の絵に重ねた色を返す
      const tmp = createPixels(1, 1);
      setPixel(tmp, 0, 0, getPixel(doc.pixels, x, y));
      blendOver(tmp, { data: new Uint8ClampedArray([c.r, c.g, c.b, c.a]), width: 1, height: 1 }, 0, 0);
      return getPixel(tmp, 0, 0);
    }
  }
  return getPixel(doc.pixels, x, y);
}

export type { Floating };
