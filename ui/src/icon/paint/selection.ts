// 選択（マスク）と、浮いた選択（持ち上げ・移動・確定）、コピー・貼り付け。DOM に触らない。
// 浮いた選択を確定するとき、透明な部分は下の絵を消さない（blendOver）。はみ出した部分は捨てる。

import type { ColorOp } from './adjust';
import { TRANSPARENT, type Rgba } from './color';
import { flatten, snapshotDoc, type Floating, type PaintDoc } from './doc';
import { blendOver, clonePixels, createPixels, getPixel, inBounds, setPixel, type Pixels } from './pixels';
import { line } from './raster';
import { fitWithin, flipMask, flipPixels, rotateMask, rotatePixels } from './transform';

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
  // 位置が変わったときだけ、回転の中心を捨てる（動かさずに押して離しただけでは、捨てない）
  if (doc.floating.x !== x || doc.floating.y !== y) delete doc.floating.center;
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

// ---- 楕円・なげなわ・合成・反転・回転（第 2 段階） ----

/** 2 つの角（両端を含む）に内接する楕円のマスク。画素の中心が楕円の中にあれば選ぶ。 */
export function maskEllipse(size: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(size * size);
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1) + 1;
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1) + 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const a = (maxX - minX) / 2;
  const b = (maxY - minY) / 2;
  for (let y = Math.max(0, minY); y < Math.min(size, maxY); y++) {
    for (let x = Math.max(0, minX); x < Math.min(size, maxX); x++) {
      if (((x + 0.5 - cx) / a) ** 2 + ((y + 0.5 - cy) / b) ** 2 <= 1) m[y * size + x] = 255;
    }
  }
  return m;
}

/** 多角形（なげなわ）の中のマスク。画素の中心が、閉じた多角形の中（偶奇の規則）にあれば選ぶ。3 点未満は空。 */
export function maskPolygon(size: number, points: readonly (readonly [number, number])[]): Uint8Array {
  const m = new Uint8Array(size * size);
  if (points.length < 3) return m;
  for (let y = 0; y < size; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      // 点は画素の中心の座標（x + 0.5）で扱う
      const [ax, ay] = points[i]!;
      const [bx, by] = points[(i + 1) % points.length]!;
      const y0 = ay + 0.5;
      const y1 = by + 0.5;
      if ((y0 <= cy && y1 > cy) || (y1 <= cy && y0 > cy)) xs.push(ax + 0.5 + ((cy - y0) / (y1 - y0)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k]! - 0.5)); x < Math.min(size, Math.ceil(xs[k + 1]! - 0.5)); x++) m[y * size + x] = 255;
    }
  }
  // 囲みの線そのものの画素も選ぶ（そうしないと、右と下の縁の画素が選ばれず、なぞったとおりにならない）
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    line(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by), (x, y) => {
      if (x >= 0 && y >= 0 && x < size && y < size) m[y * size + x] = 255;
    });
  }
  return m;
}

export type SelectMode = 'replace' | 'add' | 'subtract';

/**
 * 今の選択（null は選択なし）に、新しい形を合成する。add は和、subtract は差。
 * 選択がないときの add は新しい形そのもの、subtract は何もしない。結果が空なら null。
 */
export function combineMask(base: Uint8Array | null, shape: Uint8Array, mode: SelectMode, size: number): Uint8Array | null {
  let out: Uint8Array | null;
  if (mode === 'replace' || (mode === 'add' && !base)) out = new Uint8Array(shape);
  else if (!base) out = null;
  else {
    out = new Uint8Array(base.length);
    for (let i = 0; i < out.length; i++) out[i] = mode === 'add' ? (base[i] !== 0 || shape[i] !== 0 ? 255 : 0) : base[i] !== 0 && shape[i] === 0 ? 255 : 0;
  }
  return out && maskBounds(out, size) ? out : null;
}

/** 選択範囲を反転する（浮いた選択は先に確定する）。選択がなければ何もしない。反転して空になるなら選択なしにする。 */
export function invertSelection(doc: PaintDoc): boolean {
  dropFloating(doc);
  if (!doc.selection) return false;
  const m = new Uint8Array(doc.selection.length);
  for (let i = 0; i < m.length; i++) m[i] = doc.selection[i] === 0 ? 255 : 0;
  doc.selection = maskBounds(m, doc.size) ? m : null;
  return true;
}

export type TransformKind = 'flipH' | 'flipV' | 'rotateCw' | 'rotateCcw';

/**
 * 反転・回転する。選択（浮いた選択）があればその中身だけ（持ち上げて、中心を保ったまま変形し、浮いたままにする）、なければ絵の全体。
 * 変形した（または変形できる対象があった）ら true。
 */
export function transformContent(doc: PaintDoc, kind: TransformKind): boolean {
  if (doc.selection || doc.floating) {
    if (!doc.floating && !liftSelection(doc, false)) return false;
    const f = doc.floating!;
    const w = f.pixels.width;
    const h = f.pixels.height;
    if (kind === 'flipH' || kind === 'flipV') {
      const axis = kind === 'flipH' ? 'h' : 'v';
      f.pixels = flipPixels(f.pixels, axis);
      f.mask = flipMask(f.mask, w, h, axis);
    } else {
      const dir = kind === 'rotateCw' ? 'cw' : 'ccw';
      f.pixels = rotatePixels(f.pixels, dir);
      f.mask = rotateMask(f.mask, w, h, dir);
      // 中心が動かないように、左上の位置を直す。中心は小数で持ち続ける（回すたびに丸めると、往復でずれる）
      const c = f.center ?? { x: f.x + w / 2, y: f.y + h / 2 };
      let nx = Math.round(c.x - h / 2);
      let ny = Math.round(c.y - w / 2);
      // 回した結果が絵からはみ出すなら、絵の中に収まる位置へ寄せる（収まらないときは、そのまま。呼び出し側が知らせる）
      if (h <= doc.size) nx = Math.min(Math.max(nx, 0), doc.size - h);
      if (w <= doc.size) ny = Math.min(Math.max(ny, 0), doc.size - w);
      f.x = nx;
      f.y = ny;
      // 寄せたときも、寄せる前の本来の中心を持ち続ける（位置だけを寄せる）。捨てるのは、選択を動かしたときだけ。
      // そうしないと、端の近くで回すと、元に戻らない
      f.center = c;
    }
    syncSelection(doc);
    return true;
  }
  if (kind === 'flipH' || kind === 'flipV') doc.pixels = flipPixels(doc.pixels, kind === 'flipH' ? 'h' : 'v');
  else doc.pixels = rotatePixels(doc.pixels, kind === 'rotateCw' ? 'cw' : 'ccw');
  return true;
}

/** 色の変更を、浮いた選択があればその中身に、なければ選択範囲の中（選択がなければ全体）に適用する。 */
export function applyColorOp(doc: PaintDoc, op: ColorOp): void {
  if (doc.floating) op(doc.floating.pixels, doc.floating.mask);
  else op(doc.pixels, doc.selection);
}

/** 色の変更を適用したあとの、見たままの絵（doc は変えない）。プレビューに使う。 */
export function previewColorOp(doc: PaintDoc, op: ColorOp): Pixels {
  const copy: PaintDoc = { ...snapshotDoc(doc) };
  applyColorOp(copy, op);
  return flatten(copy);
}
