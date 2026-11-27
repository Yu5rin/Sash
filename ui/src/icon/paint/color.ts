// ペイントの色（ストレートアルファの RGBA）。画素そのものは ../process の Pixels と同じ形で持つ。
// DOM に触らない純粋な関数だけを置く（jsdom の Vitest で試せる）。

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0（透明）〜255（不透明）。ストレートアルファ。 */
  a: number;
}

export const TRANSPARENT: Readonly<Rgba> = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

const clamp8 = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return { r: clamp8(r), g: clamp8(g), b: clamp8(b), a: clamp8(a) };
}

/** 完全に透明な色は、色の成分を 0 にそろえる（PNG に余計な色を残さない・同じ「透明」として比べられるようにする）。 */
export function normalizeRgba(c: Rgba): Rgba {
  return c.a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { ...c };
}

export function sameRgba(x: Rgba, y: Rgba): boolean {
  if (x.a === 0 && y.a === 0) return true;
  return x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a;
}

/** #rrggbb（不透明）か #rrggbbaa（半透明）。完全に透明なときは null（色の入力欄には出さない）。 */
export function rgbaToHex(c: Rgba): string | null {
  if (c.a === 0) return null;
  const h = (v: number) => clamp8(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a === 255 ? '' : h(c.a)}`;
}

/** #rgb・#rrggbb・#rrggbbaa（# なしも可）を読む。読めなければ null。 */
export function parseRgba(input: string): Rgba | null {
  const s = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) return rgba(parseInt(s[0]! + s[0]!, 16), parseInt(s[1]! + s[1]!, 16), parseInt(s[2]! + s[2]!, 16));
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) {
    return rgba(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255);
  }
  return null;
}

/** RGBA 4 成分の距離の最大値（0,0,0,0 と 255,255,255,255 の間）。許容差 100% に当たる。 */
export const MAX_COLOR_DISTANCE = 510;

/**
 * 2 色の距離（RGBA の 4 成分のユークリッド距離）。完全に透明な画素どうしは、色の成分が違っても同じ（距離 0）として扱う。
 * 塗りつぶしの許容差（0〜100）は、この距離の最大値に対する割合で測る。
 */
export function colorDistance(x: Rgba, y: Rgba): number {
  if (x.a === 0 && y.a === 0) return 0;
  return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2 + (x.a - y.a) ** 2);
}

/** 許容差（0〜100）を距離のしきい値にする。0 は完全一致だけ。 */
export function toleranceToDistance(tolerance: number): number {
  return (Math.min(100, Math.max(0, tolerance)) / 100) * MAX_COLOR_DISTANCE;
}
