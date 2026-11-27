// ペイントのテスト用：小さな絵を文字の表で書いて比べる（'.'＝透明、'#'＝黒、'r'＝赤、'g'＝緑、'b'＝青、'w'＝白）。
import type { Rgba } from '../../src/icon/paint/color';
import { createPixels, getPixel, setPixel, type Pixels } from '../../src/icon/paint/pixels';

export const COLORS: Record<string, Rgba> = {
  '.': { r: 0, g: 0, b: 0, a: 0 },
  '#': { r: 0, g: 0, b: 0, a: 255 },
  r: { r: 255, g: 0, b: 0, a: 255 },
  g: { r: 0, g: 160, b: 0, a: 255 },
  b: { r: 0, g: 0, b: 255, a: 255 },
  w: { r: 255, g: 255, b: 255, a: 255 },
};

export function fromTable(rows: string[]): Pixels {
  const px = createPixels(rows[0]!.length, rows.length);
  rows.forEach((row, y) => [...row].forEach((ch, x) => setPixel(px, x, y, COLORS[ch] ?? COLORS['.']!)));
  return px;
}

export function toTable(px: Pixels): string[] {
  const rows: string[] = [];
  for (let y = 0; y < px.height; y++) {
    let row = '';
    for (let x = 0; x < px.width; x++) {
      const c = getPixel(px, x, y);
      const hit = Object.entries(COLORS).find(([, v]) => (c.a === 0 && v.a === 0) || (v.r === c.r && v.g === c.g && v.b === c.b && v.a === c.a));
      row += hit ? hit[0] : '?';
    }
    rows.push(row);
  }
  return rows;
}

export function maskTable(mask: Uint8Array, size: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < size; y++) rows.push([...mask.subarray(y * size, (y + 1) * size)].map((v) => (v ? '#' : '.')).join(''));
  return rows;
}
