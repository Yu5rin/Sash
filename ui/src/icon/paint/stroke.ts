// ブラシ・直線・四角形・楕円の「どこにどれだけ塗るか」（カバレッジ：画素ごとの 0〜255）と、それを色にして重ねる処理。DOM に触らない。
// 1 回のストロークの中では、カバレッジの最大値を取るので、重ね塗りで濃くならない。重ねるのは、ストロークを始める前の絵（base）に対して毎回やり直す。

import { blendColor } from './pixels';
import { brushOffsets, line } from './raster';
import type { Rgba } from './color';
import type { Pixels } from './pixels';

export type Coverage = Uint8Array;

export function newCoverage(size: number): Coverage {
  return new Uint8Array(size * size);
}

export interface BrushShape {
  /** 太さ（1〜16）。 */
  size: number;
  /** 硬さ（0〜100）。100 は縁までくっきり、小さいほど縁がやわらかい。 */
  hardness: number;
  /** なめらか（アンチエイリアス）にするか。false なら 0 か 255 だけ。 */
  antialias: boolean;
}

/** 筆先を (cx, cy)（画素の座標。中心は画素の真ん中）に 1 回押す。cov には最大値で足す。 */
export function stampBrush(cov: Coverage, size: number, cx: number, cy: number, b: BrushShape): void {
  const r = Math.max(0.5, b.size / 2);
  const h = Math.min(1, Math.max(0, b.hardness / 100));
  const reach = Math.ceil(r) + 1;
  for (let y = cy - reach; y <= cy + reach; y++) {
    if (y < 0 || y >= size) continue;
    for (let x = cx - reach; x <= cx + reach; x++) {
      if (x < 0 || x >= size) continue;
      const d = Math.hypot(x - cx, y - cy);
      // 縁：なめらかなら 1 画素分の幅で下がり、そうでなければ半径の内か外か
      const edge = b.antialias ? Math.min(1, Math.max(0, r + 0.5 - d)) : d <= r ? 1 : 0;
      if (edge === 0) continue;
      // 硬さ：半径の h 倍の内側は 1、そこから縁まで直線的に 0 へ
      const g = h >= 1 ? 1 : d <= r * h ? 1 : Math.max(0, (r - d) / (r * (1 - h)));
      const v = b.antialias ? edge * g : g >= 0.5 ? 1 : 0;
      const c = Math.round(v * 255);
      if (c > cov[y * size + x]!) cov[y * size + x] = c;
    }
  }
}

/** 2 点の間を筆先で引く。 */
export function strokeBrushLine(cov: Coverage, size: number, x0: number, y0: number, x1: number, y1: number, b: BrushShape): void {
  line(x0, y0, x1, y1, (x, y) => stampBrush(cov, size, x, y, b));
}

/** ドット絵の鉛筆・消しゴム（太さ 1〜8 の四角か丸。ぼかしなし）を 1 回押す。 */
export function stampPencil(cov: Coverage, size: number, x: number, y: number, pencil: { size: number; round: boolean }): void {
  for (const [dx, dy] of brushOffsets(pencil)) {
    const xx = x + dx;
    const yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < size && yy < size) cov[yy * size + xx] = 255;
  }
}

export function strokePencilLine(cov: Coverage, size: number, x0: number, y0: number, x1: number, y1: number, pencil: { size: number; round: boolean }): void {
  line(x0, y0, x1, y1, (x, y) => stampPencil(cov, size, x, y, pencil));
}

/** 1 画素を n×n に分けて調べる（n=1 は画素の中心だけ）。inside が真の割合を 0〜255 にする。 */
function sample(n: number, x: number, y: number, inside: (px: number, py: number) => boolean): number {
  let hit = 0;
  for (let sy = 0; sy < n; sy++) {
    for (let sx = 0; sx < n; sx++) if (inside(x + (sx + 0.5) / n, y + (sy + 0.5) / n)) hit++;
  }
  return Math.round((hit / (n * n)) * 255);
}

/** 点 (px, py) から線分 (ax, ay)-(bx, by) までの距離。 */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 直線。ぼかしなしは Bresenham の線を太さの筆先でなぞる（ドットの見た目）。なめらかは、線分から width/2 までの帯を 4×4 で調べる。
 */
export function lineCoverage(size: number, x0: number, y0: number, x1: number, y1: number, width: number, antialias: boolean): Coverage {
  const cov = newCoverage(size);
  if (!antialias) {
    strokePencilLine(cov, size, x0, y0, x1, y1, { size: width, round: true });
    return cov;
  }
  const ax = x0 + 0.5;
  const ay = y0 + 0.5;
  const bx = x1 + 0.5;
  const by = y1 + 0.5;
  const reach = Math.ceil(width / 2) + 1;
  for (let y = Math.max(0, Math.min(y0, y1) - reach); y <= Math.min(size - 1, Math.max(y0, y1) + reach); y++) {
    for (let x = Math.max(0, Math.min(x0, x1) - reach); x <= Math.min(size - 1, Math.max(x0, x1) + reach); x++) {
      cov[y * size + x] = sample(4, x, y, (px, py) => distToSegment(px, py, ax, ay, bx, by) <= width / 2);
    }
  }
  return cov;
}

export type ShapeFill = 'outline' | 'fill' | 'both';

export interface ShapeCoverage {
  /** 線（太さ width の輪郭）。 */
  outline: Coverage;
  /** 内側を含む全体（塗り）。 */
  fill: Coverage;
}

function bounds(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1) + 1, Math.max(y0, y1) + 1];
}

/** 四角形（2 つの角を含む）。輪郭は、外側から width 画素の帯。 */
export function rectCoverage(size: number, x0: number, y0: number, x1: number, y1: number, width: number): ShapeCoverage {
  const [minX, minY, maxX, maxY] = bounds(x0, y0, x1, y1);
  const outline = newCoverage(size);
  const fill = newCoverage(size);
  for (let y = Math.max(0, minY); y < Math.min(size, maxY); y++) {
    for (let x = Math.max(0, minX); x < Math.min(size, maxX); x++) {
      fill[y * size + x] = 255;
      if (x < minX + width || x >= maxX - width || y < minY + width || y >= maxY - width) outline[y * size + x] = 255;
    }
  }
  return { outline, fill };
}

/** 楕円（2 つの角に内接）。輪郭は、外側から width 画素の帯（内側の楕円との差）。ぼかしなしは画素の中心で判定、なめらかは 4×4。 */
export function ellipseCoverage(size: number, x0: number, y0: number, x1: number, y1: number, width: number, antialias: boolean): ShapeCoverage {
  const [minX, minY, maxX, maxY] = bounds(x0, y0, x1, y1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const a = (maxX - minX) / 2;
  const b = (maxY - minY) / 2;
  const ia = a - width;
  const ib = b - width;
  const outer = (px: number, py: number) => ((px - cx) / a) ** 2 + ((py - cy) / b) ** 2 <= 1;
  const inner = (px: number, py: number) => ia > 0 && ib > 0 && ((px - cx) / ia) ** 2 + ((py - cy) / ib) ** 2 < 1;
  const n = antialias ? 4 : 1;
  const outline = newCoverage(size);
  const fill = newCoverage(size);
  for (let y = Math.max(0, minY); y < Math.min(size, maxY); y++) {
    for (let x = Math.max(0, minX); x < Math.min(size, maxX); x++) {
      fill[y * size + x] = sample(n, x, y, outer);
      outline[y * size + x] = sample(n, x, y, (px, py) => outer(px, py) && !inner(px, py));
    }
  }
  return { outline, fill };
}

/** Shift の直線：水平・垂直・45° のどれかに揃える。 */
export function constrainLine(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > 2 * ay) return [x1, y0];
  if (ay > 2 * ax) return [x0, y1];
  const m = Math.max(ax, ay);
  return [x0 + Math.sign(dx) * m, y0 + Math.sign(dy) * m];
}

/** Shift の四角形・楕円：正方形・正円にする（長い辺に揃える。向きは動かした向き）。 */
export function constrainSquare(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return [x0 + (dx < 0 ? -m : m), y0 + (dy < 0 ? -m : m)];
}

/**
 * dst に、カバレッジ cov の形で色を重ねる（dst は、ストロークを始める前の絵のコピーにしておく）。
 * 実効のアルファ＝カバレッジ × 色のアルファ × 不透明度。色が完全に透明なら、消す（下のアルファを同じ割合だけ下げる）。
 * mask（絵と同じ大きさ。0 なら書かない）があれば、その中だけ。
 */
export function renderCoverage(dst: Pixels, cov: Coverage, color: Rgba, opacity: number, mask?: Uint8Array | null): void {
  const k = Math.min(100, Math.max(0, opacity)) / 100;
  for (let p = 0; p < cov.length; p++) {
    const c = cov[p]!;
    if (c === 0) continue;
    if (mask && mask[p] === 0) continue;
    const i = p * 4;
    const ca = (c / 255) * k;
    if (color.a === 0) {
      const a = Math.round(dst.data[i + 3]! * (1 - ca));
      dst.data[i + 3] = a;
      if (a === 0) {
        dst.data[i] = 0;
        dst.data[i + 1] = 0;
        dst.data[i + 2] = 0;
      }
      continue;
    }
    const out = blendColor({ r: dst.data[i]!, g: dst.data[i + 1]!, b: dst.data[i + 2]!, a: dst.data[i + 3]! }, { r: color.r, g: color.g, b: color.b, a: Math.round(color.a * ca) });
    dst.data[i] = out.r;
    dst.data[i + 1] = out.g;
    dst.data[i + 2] = out.b;
    dst.data[i + 3] = out.a;
  }
}
