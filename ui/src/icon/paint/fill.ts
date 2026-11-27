// 塗りつぶし（4 近傍・許容差・隣接のみ／全体）。範囲を求める関数は、自動選択（第 2 段階）と共通にする。

import { colorDistance, toleranceToDistance, type Rgba } from './color';
import { getPixel, inBounds, setPixel, type Pixels } from './pixels';

/**
 * (x, y) の色に近い画素の範囲を、0 / 255 のマスク（絵と同じ大きさ）で返す。
 * contiguous なら (x, y) から 4 近傍でつながる範囲だけ（斜めには漏れない）、そうでなければ絵の全体から探す。
 * mask があれば、その中だけを対象にする（つながりも mask の外へは広がらない）。
 * 起点が範囲の外・mask の外なら、空のマスク。
 */
export function regionMask(px: Pixels, x: number, y: number, tolerance: number, contiguous: boolean, mask?: Uint8Array | null): Uint8Array {
  const { width, height } = px;
  const out = new Uint8Array(width * height);
  if (!inBounds(px, x, y)) return out;
  if (mask && mask[y * width + x] === 0) return out;
  const seed = getPixel(px, x, y);
  const limit = toleranceToDistance(tolerance);
  const matches = (xx: number, yy: number): boolean => {
    if (mask && mask[yy * width + xx] === 0) return false;
    return colorDistance(getPixel(px, xx, yy), seed) <= limit;
  };
  if (!contiguous) {
    for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) if (matches(xx, yy)) out[yy * width + xx] = 255;
    return out;
  }
  const stack: number[] = [x, y];
  while (stack.length) {
    const cy = stack.pop()!;
    const cx = stack.pop()!;
    if (out[cy * width + cx] !== 0 || !matches(cx, cy)) continue;
    out[cy * width + cx] = 255;
    if (cx > 0) stack.push(cx - 1, cy);
    if (cx < width - 1) stack.push(cx + 1, cy);
    if (cy > 0) stack.push(cx, cy - 1);
    if (cy < height - 1) stack.push(cx, cy + 1);
  }
  return out;
}

/** 塗りつぶす。塗った画素の数を返す（同じ色で塗っても止まる）。色は合成せず、そのまま書く。 */
export function floodFill(px: Pixels, x: number, y: number, color: Rgba, tolerance: number, contiguous: boolean, mask?: Uint8Array | null): number {
  const region = regionMask(px, x, y, tolerance, contiguous, mask);
  let n = 0;
  for (let i = 0; i < region.length; i++) {
    if (region[i] === 0) continue;
    setPixel(px, i % px.width, Math.floor(i / px.width), color);
    n++;
  }
  return n;
}
