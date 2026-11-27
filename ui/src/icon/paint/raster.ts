// 線と筆先のラスタライズ（アンチエイリアスなし。16px ではドットが大事なため）。DOM に触らない。

import type { Rgba } from './color';
import { inBounds, setPixel, type Pixels } from './pixels';

/** Bresenham の直線。始点と終点を含み、各点を plot に渡す。始点と終点を入れ替えても同じ点の集まりになる。 */
export function line(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  // 向きによって点がずれないよう、いつも左上から右下（x が小さい方・同じなら y が小さい方）へ引く
  if (x1 < x0 || (x1 === x0 && y1 < y0)) [x0, y0, x1, y1] = [x1, y1, x0, y0];
  const dx = x1 - x0;
  const dy = Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += 1;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export interface Brush {
  /** 太さ（1〜8）。 */
  size: number;
  /** 丸い筆先か（false は四角）。太さ 1・2 は同じ形。 */
  round: boolean;
}

/** 筆先の画素の位置（中心の画素からのずれ）。太さ n は、x を −⌊(n−1)/2⌋〜+⌊n/2⌋ に置く。 */
export function brushOffsets(brush: Brush): [number, number][] {
  const n = Math.max(1, Math.round(brush.size));
  const lo = Math.floor((n - 1) / 2);
  const hi = Math.floor(n / 2);
  const centre = (hi - lo) / 2;
  const r = (n - 1) / 2 + 0.35;
  const out: [number, number][] = [];
  for (let dy = 0 - lo; dy <= hi; dy++) {
    for (let dx = 0 - lo; dx <= hi; dx++) {
      if (brush.round && n > 2 && (dx - centre) ** 2 + (dy - centre) ** 2 > r * r) continue;
      out.push([dx, dy]);
    }
  }
  return out;
}

/** mask（絵と同じ大きさ。0 なら書かない）。null なら全体に書く。 */
export type Mask = Uint8Array | null | undefined;

/** 筆先を 1 か所に押す。色をそのまま書く（透明を書けば消える）。 */
export function stamp(px: Pixels, x: number, y: number, brush: Brush, color: Rgba, mask?: Mask): void {
  for (const [dx, dy] of brushOffsets(brush)) {
    const xx = x + dx;
    const yy = y + dy;
    if (!inBounds(px, xx, yy)) continue;
    if (mask && mask[yy * px.width + xx] === 0) continue;
    setPixel(px, xx, yy, color);
  }
}

/** 2 点の間を筆先で引く。外の点から入ってくる線も、範囲の内側の部分は引ける。 */
export function stampLine(px: Pixels, x0: number, y0: number, x1: number, y1: number, brush: Brush, color: Rgba, mask?: Mask): void {
  line(x0, y0, x1, y1, (x, y) => stamp(px, x, y, brush, color, mask));
}
