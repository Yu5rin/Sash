// 色の変更（選択範囲だけ・なければ全体）。Pixels と mask（0 なら変えない。null は全体）を受け取り、その場で書き換える純粋な関数。
// どれも完全に透明な画素（a=0）には触れず、アルファは保つ（不透明度の変更と「透明にする色」だけが、アルファを変える）。
// 半透明の縁（アンチエイリアス）は、ストレートアルファでは色（RGB）が元の色のまま、アルファだけが低いので、色の変更が縁にも自然に効く。

import type { Pixels } from './pixels';

export type Mask = Uint8Array | null | undefined;

/** 絵（または浮いた選択）に対する、色の変更の 1 つ。プレビューと適用が同じ関数を使う。 */
export type ColorOp = (px: Pixels, mask: Mask) => void;

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** RGB（0〜255）→ HSL（h は 0〜360、s・l は 0〜1）。 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rf) h = ((gf - bf) / d) % 6;
  else if (max === gf) h = (bf - rf) / d + 2;
  else h = (rf - gf) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/** HSL → RGB（0〜255 に丸める）。 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** 画素を 1 つずつ見て fn に渡す（a=0 と mask の外は飛ばす）。 */
function each(px: Pixels, mask: Mask, fn: (i: number) => void): void {
  const d = px.data;
  for (let p = 0; p < px.width * px.height; p++) {
    if (mask && mask[p] === 0) continue;
    const i = p * 4;
    if (d[i + 3] === 0) continue;
    fn(i);
  }
}

export interface HslAdjust {
  /** 色相を回す角度（−180〜180）。 */
  hue: number;
  /** 彩度（−100〜100。今の彩度に掛ける：−100 で灰色、+100 で 2 倍（最大 1）。灰色は上げても灰色のまま）。 */
  saturation: number;
  /** 明るさ（−100〜100。−100 で黒、100 で白）。 */
  lightness: number;
}

/** 色相・彩度・明るさを変える。 */
export function adjustHsl(px: Pixels, mask: Mask, a: HslAdjust): void {
  if (a.hue === 0 && a.saturation === 0 && a.lightness === 0) return;
  const ds = a.saturation / 100;
  const dl = a.lightness / 100;
  const d = px.data;
  each(px, mask, (i) => {
    let [h, s, l] = rgbToHsl(d[i]!, d[i + 1]!, d[i + 2]!);
    h = (h + a.hue + 360) % 360;
    // 彩度は掛け算で変える（+100 で 2 倍、−100 で 0）。無彩色（s=0）は色相がないので、上げても灰色のまま
    s = Math.min(1, s * (1 + ds));
    l = dl >= 0 ? l + (1 - l) * dl : l * (1 + dl);
    const [r, g, b] = hslToRgb(h, s, l);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  });
}

/** RGB の最大の距離（黒と白）。許容差 100% に当たる。 */
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);

/**
 * 色の近さの重み（1＝完全に一致、0＝遠い）。距離が許容差の半分までは 1、そこから許容差まで直線的に 0 へ下がる。
 * 許容差 0 は完全一致だけ。境目をなだらかにして、縁の混ざった色（アンチエイリアス）にも効かせる。
 */
export function closeness(dist: number, tolerance: number): number {
  const t = (Math.min(100, Math.max(0, tolerance)) / 100) * MAX_RGB_DISTANCE;
  if (dist <= 0) return 1;
  if (dist >= t) return 0;
  const core = t / 2;
  return dist <= core ? 1 : (t - dist) / (t - core);
}

/** from に近い色を to に置き換える（RGB。アルファは保つ）。近さに応じて混ぜるので、縁の混ざった色も自然に置き換わる。 */
export function replaceColorMasked(px: Pixels, mask: Mask, from: RgbColor, to: RgbColor, tolerance: number): void {
  const d = px.data;
  each(px, mask, (i) => {
    const dist = Math.sqrt((d[i]! - from.r) ** 2 + (d[i + 1]! - from.g) ** 2 + (d[i + 2]! - from.b) ** 2);
    const w = closeness(dist, tolerance);
    if (w === 0) return;
    d[i] = Math.round(d[i]! + (to.r - d[i]!) * w);
    d[i + 1] = Math.round(d[i + 1]! + (to.g - d[i + 1]!) * w);
    d[i + 2] = Math.round(d[i + 2]! + (to.b - d[i + 2]!) * w);
  });
}

/** 単色化（シルエットを 1 色にする。アルファは保つ）。 */
export function monochromeMasked(px: Pixels, mask: Mask, color: RgbColor): void {
  const d = px.data;
  each(px, mask, (i) => {
    d[i] = color.r;
    d[i + 1] = color.g;
    d[i + 2] = color.b;
  });
}

/** 色の反転（RGB だけ。アルファは保つ）。 */
export function invertColorsMasked(px: Pixels, mask: Mask): void {
  const d = px.data;
  each(px, mask, (i) => {
    d[i] = 255 - d[i]!;
    d[i + 1] = 255 - d[i + 1]!;
    d[i + 2] = 255 - d[i + 2]!;
  });
}

/** グレースケール（明るさは Rec.709 の係数）。 */
export function grayscaleMasked(px: Pixels, mask: Mask): void {
  const d = px.data;
  each(px, mask, (i) => {
    const y = Math.round(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
    d[i] = y;
    d[i + 1] = y;
    d[i + 2] = y;
  });
}

/** 不透明度（今のアルファの何 % にするか。0〜100）。0 にした画素は透明にそろえる。 */
export function opacityMasked(px: Pixels, mask: Mask, percent: number): void {
  const k = Math.min(100, Math.max(0, percent)) / 100;
  const d = px.data;
  each(px, mask, (i) => {
    d[i + 3] = Math.round(d[i + 3]! * k);
    if (d[i + 3] === 0) {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
    }
  });
}

/** この色（に近い色）を透明にする。近さに応じてアルファを下げるので、縁もなじむ。 */
export function makeTransparentMasked(px: Pixels, mask: Mask, color: RgbColor, tolerance: number): void {
  const d = px.data;
  each(px, mask, (i) => {
    const dist = Math.sqrt((d[i]! - color.r) ** 2 + (d[i + 1]! - color.g) ** 2 + (d[i + 2]! - color.b) ** 2);
    const w = closeness(dist, tolerance);
    if (w === 0) return;
    d[i + 3] = Math.round(d[i + 3]! * (1 - w));
    if (d[i + 3] === 0) {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
    }
  });
}

/** 使われている色（アルファが 128 以上の画素）を、多い順に。同じ数なら #rrggbb の順。 */
export function extractColors(px: Pixels, max = 16): { hex: string; count: number }[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < px.data.length; i += 4) {
    if (px.data[i + 3]! < 128) continue;
    const key = (px.data[i]! << 16) | (px.data[i + 1]! << 8) | px.data[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, count]) => ({ hex: `#${k.toString(16).padStart(6, '0')}`, count }))
    .sort((a, b) => b.count - a.count || (a.hex < b.hex ? -1 : 1))
    .slice(0, max);
}
