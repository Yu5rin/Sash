// アイコンの色の既定の配色（パレット）。画面に依存しない純粋なデータと関数にして、テストできるようにする。
//
// 並べ方：色相ごとの列（グレー・赤・橙・黄・黄緑・緑・青緑・水色・青・藍・紫・桃・茶の 13 列）に、濃い方から淡い方へ 5 段。
// その下に Office の「標準の色」10 色。アイコンはリボンに置いて使うので、リボンの上で見える中間〜濃い色を中心にし、
// 淡い色は「アクセント」用に残してある（沈む色には印を付けて知らせる。下の legibility）。
// 以前の 6 色（#424242 #217346 #0f6cbd #c42b1c #ca5010 #000000）は、同じ値のままパレットの中に残してある。

import { sinkOfColor } from '../imageStats';

/** 濃さの段（t() のキー）。 */
export const SHADE_NAMES = ['濃い', 'やや濃い', '標準', 'やや淡い', '淡い'] as const;

export interface PaletteHue {
  id: string;
  /** 色相の名前（t() のキー）。 */
  ja: string;
  /** 濃い方から 5 色。 */
  colors: readonly [string, string, string, string, string];
}

export const PALETTE_HUES: readonly PaletteHue[] = [
  { id: 'gray', ja: 'グレー', colors: ['#000000', '#424242', '#707070', '#a6a6a6', '#d6d6d6'] },
  { id: 'red', ja: '赤', colors: ['#691411', '#951c18', '#c42b1c', '#e45d58', '#f4bbb9'] },
  { id: 'orange', ja: 'オレンジ', colors: ['#733207', '#a3470a', '#ca5010', '#f38d49', '#facfb2'] },
  { id: 'yellow', ja: '黄', colors: ['#765605', '#a67907', '#d79d09', '#f6bf31', '#fbe3a7'] },
  { id: 'lime', ja: '黄緑', colors: ['#44611a', '#618924', '#7db12f', '#a0d256', '#d6ecb6'] },
  { id: 'green', ja: '緑', colors: ['#1a6134', '#217346', '#2fb15f', '#66d68f', '#bfeed0'] },
  { id: 'teal', ja: '青緑', colors: ['#126862', '#1a938b', '#22bfb4', '#5ae2d9', '#baf3ef'] },
  { id: 'cyan', ja: '水色', colors: ['#0c546e', '#11779c', '#169aca', '#51c2ec', '#b6e5f7'] },
  { id: 'blue', ja: '青', colors: ['#0d3c6d', '#13549a', '#0f6cbd', '#539cea', '#b6d5f6'] },
  { id: 'indigo', ja: '藍', colors: ['#1d245d', '#2a3384', '#3642ab', '#6c76d0', '#c1c5eb'] },
  { id: 'purple', ja: '紫', colors: ['#41205b', '#5c2d80', '#773aa6', '#a470cd', '#d9c3ea'] },
  { id: 'pink', ja: '桃', colors: ['#63173d', '#8c2157', '#b62b70', '#da629e', '#efbdd6'] },
  { id: 'brown', ja: '茶', colors: ['#573623', '#7b4d32', '#9f6441', '#c79375', '#e7d2c5'] },
];

/** Office の「標準の色」（Excel・Word と同じ 10 色）。名前は t() のキー。 */
export const STANDARD_COLORS: readonly { color: string; label: string }[] = [
  { color: '#c00000', label: '濃い赤' },
  { color: '#ff0000', label: '赤' },
  { color: '#ffc000', label: 'オレンジ' },
  { color: '#ffff00', label: '黄' },
  { color: '#92d050', label: '薄い緑' },
  { color: '#00b050', label: '緑' },
  { color: '#00b0f0', label: '薄い青' },
  { color: '#0070c0', label: '青' },
  { color: '#002060', label: '濃い青' },
  { color: '#7030a0', label: '紫' },
];

/** 色相の列の数（グリッドの列数）。 */
export const PALETTE_COLUMNS = PALETTE_HUES.length;

/** 最近使った色を覚える数。 */
export const RECENT_MAX = 8;

export interface PaletteSwatch {
  color: string;
  /** 色の名前（t() に渡す日本語のキーを、色相と濃さに分けたもの）。標準の色は label だけ。 */
  hue: string;
  shade: string;
}

/** 色相の列 × 濃さの段を、段ごとに左から右へ並べたもの（画面のグリッドの並び）。 */
export function paletteGrid(): PaletteSwatch[] {
  const out: PaletteSwatch[] = [];
  SHADE_NAMES.forEach((shade, row) => {
    for (const hue of PALETTE_HUES) out.push({ color: hue.colors[row]!, hue: hue.ja, shade });
  });
  return out;
}

/** パレットに入っている色（グリッドと標準の色。小文字の #rrggbb）。 */
export function allPaletteColors(): string[] {
  return [...PALETTE_HUES.flatMap((h) => h.colors), ...STANDARD_COLORS.map((c) => c.color)];
}

/** 色の名前（t() のキーの組）。パレットにない色は null。 */
export function paletteName(color: string): { hue: string; shade: string } | { label: string } | null {
  const c = color.toLowerCase();
  for (const h of PALETTE_HUES) {
    const i = h.colors.indexOf(c);
    if (i >= 0) return { hue: h.ja, shade: SHADE_NAMES[i]! };
  }
  const s = STANDARD_COLORS.find((x) => x.color === c);
  return s ? { label: s.label } : null;
}

/**
 * 入力した色を #rrggbb（小文字）にそろえる。#RRGGBB・RRGGBB・#RGB・RGB を受け付け、前後の空白は無視する。
 * 読めなければ null（属性に入れるので、これ以外の文字列は通さない）。
 */
export function normalizeHex(input: string): string | null {
  const t = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(t)) return `#${t[0]}${t[0]}${t[1]}${t[1]}${t[2]}${t[2]}`.toLowerCase();
  return null;
}

/** リボンの上での見え方。dark：Office の黒・濃い灰色のテーマで背景に沈む、light：白・明るいテーマで沈む（配布前チェックと同じ基準）。 */
export function legibility(color: string): 'ok' | 'dark' | 'light' {
  return sinkOfColor(color) ?? 'ok';
}

/** 最近使った色の一覧を更新する（先頭に足し、重複を除き、RECENT_MAX 個まで）。 */
export function pushRecent(list: readonly string[], color: string): string[] {
  const c = normalizeHex(color);
  if (!c) return [...list];
  return [c, ...list.filter((x) => x !== c)].slice(0, RECENT_MAX);
}
