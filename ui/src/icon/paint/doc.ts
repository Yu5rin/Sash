// ペイントの絵（PaintDoc）と、保存形式（options.paint の読み書きと検査）。DOM に触らない。
// 第 1〜3 段階は 1 枚の絵だけ（レイヤーは第 4 段階）。

import { blendOver, clonePixels, createPixels, equalPixels, pixelBytes, type Pixels } from './pixels';

export type CanvasSize = 16 | 32 | 64;
export const CANVAS_SIZES: readonly CanvasSize[] = [16, 32, 64];

/** 動かしている途中の選択（持ち上げた画素）。pixels と mask は同じ大きさで、(x, y) が絵の上の左上。 */
export interface Floating {
  pixels: Pixels;
  /** 持ち上げた形（0 / 255）。四角形なら全部 255。 */
  mask: Uint8Array;
  x: number;
  y: number;
}

export interface PaintDoc {
  size: CanvasSize;
  pixels: Pixels;
  /** 絵と同じ大きさのマスク（0 / 255）。null は選択なし（全体が対象）。 */
  selection: Uint8Array | null;
  floating: Floating | null;
}

export function createDoc(size: CanvasSize, pixels?: Pixels): PaintDoc {
  return { size, pixels: pixels ? clonePixels(pixels) : createPixels(size, size), selection: null, floating: null };
}

/** 履歴に積む複製。 */
export interface DocSnapshot {
  /** キャンバスの大きさ（大きさを変える操作も、1 手として戻せるように持つ）。 */
  size: CanvasSize;
  pixels: Pixels;
  selection: Uint8Array | null;
  floating: Floating | null;
}

export function snapshotDoc(doc: PaintDoc): DocSnapshot {
  return {
    size: doc.size,
    pixels: clonePixels(doc.pixels),
    selection: doc.selection ? new Uint8Array(doc.selection) : null,
    floating: doc.floating ? { pixels: clonePixels(doc.floating.pixels), mask: new Uint8Array(doc.floating.mask), x: doc.floating.x, y: doc.floating.y } : null,
  };
}

/** 複製を絵に戻す（履歴の中の複製を壊さないよう、もう一度複製して入れる）。 */
export function restoreDoc(doc: PaintDoc, snap: DocSnapshot): void {
  const copy = snapshotDoc({ ...snap });
  doc.size = copy.size;
  doc.pixels = copy.pixels;
  doc.selection = copy.selection;
  doc.floating = copy.floating;
}

export function snapshotBytes(s: DocSnapshot): number {
  return pixelBytes(s.pixels) + (s.selection?.byteLength ?? 0) + (s.floating ? pixelBytes(s.floating.pixels) + s.floating.mask.byteLength : 0);
}

function sameMask(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sameSnapshot(a: DocSnapshot, b: DocSnapshot): boolean {
  if (a.size !== b.size || !equalPixels(a.pixels, b.pixels) || !sameMask(a.selection, b.selection)) return false;
  if (a.floating === null || b.floating === null) return a.floating === b.floating;
  return a.floating.x === b.floating.x && a.floating.y === b.floating.y && equalPixels(a.floating.pixels, b.floating.pixels) && sameMask(a.floating.mask, b.floating.mask);
}

/** 浮いた選択を重ねた、見たままの絵（doc は変えない）。出力・プレビュー・画面の表示に使う。 */
export function flatten(doc: PaintDoc): Pixels {
  const out = clonePixels(doc.pixels);
  if (doc.floating) blendOver(out, doc.floating.pixels, doc.floating.x, doc.floating.y);
  return out;
}

// ---- 保存形式（options.paint） ----

export interface PaintMeta {
  v: 1;
  canvas: CanvasSize;
}

function optionsPaint(options: unknown): Record<string, unknown> | null {
  if (typeof options !== 'object' || options === null) return null;
  const p = (options as Record<string, unknown>)['paint'];
  return typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
}

/**
 * options.paint を読む。共有フォルダの値は信用しないので、形（v・canvas の値）と、元画像の大きさ（正方形で、
 * キャンバスの 1・2・4 倍）が合うときだけ返す。通らなければ null（普通の画像として扱う）。
 * 元画像のブロックがそろっているかは、画素を見る recoverFromSource が確かめる。
 */
export function readPaintMeta(options: unknown, sourceWidth: number, sourceHeight: number): PaintMeta | null {
  const p = optionsPaint(options);
  if (!p || p['v'] !== 1) return null;
  const canvas = p['canvas'];
  if (canvas !== 16 && canvas !== 32 && canvas !== 64) return null;
  if (sourceWidth !== sourceHeight || sourceWidth % canvas !== 0) return null;
  const k = sourceWidth / canvas;
  if (k !== 1 && k !== 2 && k !== 4) return null;
  return { v: 1, canvas };
}

/** もっと新しい版の形式（v が 2 以上）か。描き直しはできないと知らせて、普通の画像として扱う。 */
export function isNewerPaintMeta(options: unknown): boolean {
  const v = optionsPaint(options)?.['v'];
  return typeof v === 'number' && v > 1;
}

/** options に paint を足した新しいオブジェクト。 */
export function withPaintMeta<T extends object>(options: T, canvas: CanvasSize): T & { paint: PaintMeta } {
  return { ...options, paint: { v: 1, canvas } };
}

/** options から paint を外した新しいオブジェクト（一括取り込みと、新しい画像を読み込んだときに使う）。 */
export function withoutPaintMeta<T extends object>(options: T): Omit<T, 'paint'> {
  const copy = { ...options } as T & { paint?: unknown };
  delete copy.paint;
  return copy;
}
