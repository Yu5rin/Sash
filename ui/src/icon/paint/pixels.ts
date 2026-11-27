// 画素の基本操作（作成・複製・読み書き・ストレートアルファの合成・切り出し）。
// canvas の合成は乗算済みアルファを通って半透明の色が丸めでずれるため、合成は自前で計算する（設計書 §3.2）。

import type { Pixels } from '../process';
import { normalizeRgba, type Rgba } from './color';

export type { Pixels };

export function createPixels(width: number, height: number): Pixels {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function clonePixels(px: Pixels): Pixels {
  return { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
}

export function inBounds(px: { width: number; height: number }, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < px.width && y < px.height;
}

/** 範囲の外は透明を返す。 */
export function getPixel(px: Pixels, x: number, y: number): Rgba {
  if (!inBounds(px, x, y)) return { r: 0, g: 0, b: 0, a: 0 };
  const i = (y * px.width + x) * 4;
  return { r: px.data[i]!, g: px.data[i + 1]!, b: px.data[i + 2]!, a: px.data[i + 3]! };
}

/** 色をそのまま書く（合成しない）。範囲の外は捨てる。透明は RGB も 0 にそろえる。 */
export function setPixel(px: Pixels, x: number, y: number, c: Rgba): void {
  if (!inBounds(px, x, y)) return;
  const n = normalizeRgba(c);
  const i = (y * px.width + x) * 4;
  px.data[i] = n.r;
  px.data[i + 1] = n.g;
  px.data[i + 2] = n.b;
  px.data[i + 3] = n.a;
}

/**
 * ストレートアルファの source-over（src を dst の上に重ねる）。丸めは固定：
 *   outA = sa + da·(255−sa)/255、out = round((src·sa + dst·da·(255−sa)/255) / outA)、alpha も round。
 * 不透明（sa=255）はそのまま写し、完全に透明（sa=0）は dst を変えない。
 */
export function blendColor(dst: Rgba, src: Rgba): Rgba {
  if (src.a === 0) return dst;
  if (src.a === 255 || dst.a === 0) return normalizeRgba(src);
  const sa = src.a;
  const dw = (dst.a * (255 - sa)) / 255;
  const outA = sa + dw;
  return {
    r: Math.round((src.r * sa + dst.r * dw) / outA),
    g: Math.round((src.g * sa + dst.g * dw) / outA),
    b: Math.round((src.b * sa + dst.b * dw) / outA),
    a: Math.round(outA),
  };
}

/**
 * src を dst の (ox, oy) に重ねる。dst の範囲の外は捨てる。
 * mask（dst と同じ大きさ。0 なら書かない）があれば、その中だけに重ねる。
 */
export function blendOver(dst: Pixels, src: Pixels, ox: number, oy: number, mask?: Uint8Array | null): void {
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.width) continue;
      if (mask && mask[dy * dst.width + dx] === 0) continue;
      const si = (y * src.width + x) * 4;
      const sa = src.data[si + 3]!;
      if (sa === 0) continue;
      const di = (dy * dst.width + dx) * 4;
      const out = blendColor(
        { r: dst.data[di]!, g: dst.data[di + 1]!, b: dst.data[di + 2]!, a: dst.data[di + 3]! },
        { r: src.data[si]!, g: src.data[si + 1]!, b: src.data[si + 2]!, a: sa },
      );
      dst.data[di] = out.r;
      dst.data[di + 1] = out.g;
      dst.data[di + 2] = out.b;
      dst.data[di + 3] = out.a;
    }
  }
}

/** 矩形を切り出す（範囲の外は透明）。 */
export function cropPixels(px: Pixels, x: number, y: number, width: number, height: number): Pixels {
  const out = createPixels(width, height);
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const sx = x + xx;
      const sy = y + yy;
      if (!inBounds(px, sx, sy)) continue;
      const si = (sy * px.width + sx) * 4;
      out.data.set(px.data.subarray(si, si + 4), (yy * width + xx) * 4);
    }
  }
  return out;
}

/** 同じ絵か。完全に透明な画素は、色の成分が違っても同じとみなす。 */
export function equalPixels(a: Pixels, b: Pixels): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i += 4) {
    const aa = a.data[i + 3]!;
    if (aa !== b.data[i + 3]) return false;
    if (aa === 0) continue;
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) return false;
  }
  return true;
}

/** 画素のバイト数（履歴の上限の計算用）。 */
export function pixelBytes(px: Pixels): number {
  return px.data.byteLength;
}
