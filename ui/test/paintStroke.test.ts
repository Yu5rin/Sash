import { describe, expect, it } from 'vitest';
import {
  constrainLine, constrainSquare, ellipseCoverage, lineCoverage, newCoverage, rectCoverage, renderCoverage, stampBrush, stampPencil, strokeBrushLine,
} from '../src/icon/paint/stroke';
import { createPixels, getPixel } from '../src/icon/paint/pixels';
import { maskRect } from '../src/icon/paint/selection';
import { COLORS, fromTable, toTable } from './helpers/paintTable';

const cov = (c: Uint8Array, size: number, on = 128): string[] => {
  const rows: string[] = [];
  for (let y = 0; y < size; y++) rows.push([...c.subarray(y * size, (y + 1) * size)].map((v) => (v === 0 ? '.' : v >= on ? '#' : '+')).join(''));
  return rows;
};

describe('ブラシ', () => {
  it('ぼかしなし・硬さ 100：太さ 1 は 1 画素、3 は 3×3、5 は丸', () => {
    for (const [n, want] of [[1, ['.....', '.....', '..#..', '.....', '.....']], [3, ['.....', '.###.', '.###.', '.###.', '.....']], [5, ['.###.', '#####', '#####', '#####', '.###.']]] as const) {
      const c = newCoverage(5);
      stampBrush(c, 5, 2, 2, { size: n, hardness: 100, antialias: false });
      expect(cov(c, 5)).toEqual(want);
    }
  });
  it('なめらか：縁は半分の濃さ、中心は 255', () => {
    const c = newCoverage(7);
    stampBrush(c, 7, 3, 3, { size: 4, hardness: 100, antialias: true });
    expect(c[3 * 7 + 3]).toBe(255);
    const edge = c[3 * 7 + 5]!;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });
  it('硬さが低いと、中心から外へなだらかに薄くなる', () => {
    const c = newCoverage(11);
    stampBrush(c, 11, 5, 5, { size: 9, hardness: 0, antialias: true });
    expect(c[5 * 11 + 5]).toBe(255);
    expect(c[5 * 11 + 6]!).toBeGreaterThan(c[5 * 11 + 8]!);
    expect(c[5 * 11 + 8]!).toBeGreaterThan(c[5 * 11 + 9]!);
  });
  it('1 回のストロークで行き来しても、カバレッジは最大値のまま（重ね塗りで濃くならない）', () => {
    const c = newCoverage(9);
    const b = { size: 3, hardness: 50, antialias: true };
    strokeBrushLine(c, 9, 1, 4, 7, 4, b);
    const once = [...c];
    strokeBrushLine(c, 9, 7, 4, 1, 4, b);
    expect([...c]).toEqual(once);
  });
  it('絵の外の画素は書かない', () => {
    const c = newCoverage(3);
    stampBrush(c, 3, -1, -1, { size: 5, hardness: 100, antialias: false });
    expect(c.length).toBe(9);
  });
});

describe('鉛筆の筆先', () => {
  it('太さ 2 の四角は 2×2（中心の右下へ）', () => {
    const c = newCoverage(4);
    stampPencil(c, 4, 1, 1, { size: 2, round: false });
    expect(cov(c, 4)).toEqual(['....', '.##.', '.##.', '....']);
  });
});

describe('直線', () => {
  it('ぼかしなしの斜めの線は、Bresenham', () => {
    expect(cov(lineCoverage(5, 0, 0, 4, 4, 1, false), 5)).toEqual(['#....', '.#...', '..#..', '...#.', '....#']);
  });
  it('なめらかな水平線：太さ 1 は、その行だけが 255', () => {
    const c = lineCoverage(5, 0, 2, 4, 2, 1, true);
    expect(cov(c, 5).join('/')).toBe('...../...../#####/...../.....');
  });
  it('なめらかな太さ 2 の水平線は、2 行ぶん（境目の 2 行）が濃い', () => {
    const c = lineCoverage(5, 0, 2, 4, 2, 2, true);
    expect(c[2 * 5 + 2]).toBe(255);
    expect(c[1 * 5 + 2]! + c[3 * 5 + 2]!).toBeGreaterThanOrEqual(255);
  });
  it('太さ 3 は 3 画素幅', () => {
    const c = lineCoverage(7, 0, 3, 6, 3, 3, false);
    expect(cov(c, 7)).toEqual(['.......', '.......', '#######', '#######', '#######', '.......', '.......']);
  });
  it('Shift：水平・垂直・45° に揃える', () => {
    expect(constrainLine(0, 0, 10, 2)).toEqual([10, 0]);
    expect(constrainLine(0, 0, 2, 10)).toEqual([0, 10]);
    expect(constrainLine(0, 0, 7, 5)).toEqual([7, 7]);
    expect(constrainLine(5, 5, 1, 2)).toEqual([1, 1]);
  });
});

describe('四角形と楕円', () => {
  it('四角形の輪郭と塗り（太さ 1・2）', () => {
    expect(cov(rectCoverage(6, 1, 1, 4, 4, 1).outline, 6)).toEqual(['......', '.####.', '.#..#.', '.#..#.', '.####.', '......']);
    expect(cov(rectCoverage(6, 1, 1, 4, 4, 2).outline, 6)).toEqual(['......', '.####.', '.####.', '.####.', '.####.', '......']);
    expect(cov(rectCoverage(6, 4, 4, 1, 1, 1).fill, 6)).toEqual(['......', '.####.', '.####.', '.####.', '.####.', '......']);
  });
  it('四角形は絵の外へ出た部分を切る', () => {
    expect(cov(rectCoverage(3, -2, -2, 1, 1, 1).fill, 3)).toEqual(['##.', '##.', '...']);
  });
  it('楕円（ぼかしなし）：7×7 の円の塗りと輪郭', () => {
    const e = ellipseCoverage(7, 0, 0, 6, 6, 1, false);
    expect(cov(e.fill, 7)).toEqual(['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..']);
    expect(cov(e.outline, 7)).toEqual(['..###..', '.#...#.', '#.....#', '#.....#', '#.....#', '.#...#.', '..###..']);
  });
  it('楕円は細長くもできる（8×4）。端の画素は左右対称', () => {
    const e = ellipseCoverage(8, 0, 0, 7, 3, 1, false);
    const rows = cov(e.fill, 8).slice(0, 4);
    for (const r of rows) expect(r).toBe([...r].reverse().join(''));
    expect(rows[0]).toBe('.######.');
  });
  it('太さが半径以上なら、輪郭は塗りと同じ', () => {
    const e = ellipseCoverage(5, 0, 0, 4, 4, 9, false);
    expect(cov(e.outline, 5)).toEqual(cov(e.fill, 5));
  });
  it('なめらかな楕円は、縁に中間の濃さがあり、中心は 255。合計の面積は円に近い', () => {
    const e = ellipseCoverage(10, 0, 0, 9, 9, 1, true);
    expect(e.fill[5 * 10 + 5]).toBe(255);
    expect([...e.fill].some((v) => v > 0 && v < 255)).toBe(true);
    const area = [...e.fill].reduce((s, v) => s + v / 255, 0);
    expect(Math.abs(area - Math.PI * 25)).toBeLessThan(2);
  });
  it('Shift：正方形・正円に揃える（動かした向きのまま）', () => {
    expect(constrainSquare(0, 0, 5, 3)).toEqual([5, 5]);
    expect(constrainSquare(5, 5, 2, 4)).toEqual([2, 2]);
    expect(constrainSquare(5, 5, 8, 0)).toEqual([10, 0]);
  });
});

describe('カバレッジを色にして重ねる', () => {
  it('不透明な色・カバレッジ 255 はそのまま置く', () => {
    const px = createPixels(2, 1);
    const c = newCoverage(2);
    c[0] = 255;
    renderCoverage({ ...px, data: px.data }, c, COLORS['r']!, 100);
    expect(toTable(px)).toEqual(['r.']);
  });
  it('不透明度とカバレッジの積で、下の色と混ざる', () => {
    const px = fromTable(['w']);
    const c = Uint8Array.from([255]);
    renderCoverage(px, c, { r: 0, g: 0, b: 0, a: 255 }, 50);
    expect(getPixel(px, 0, 0)).toEqual({ r: 127, g: 127, b: 127, a: 255 });
    const px2 = fromTable(['w']);
    renderCoverage(px2, Uint8Array.from([128]), { r: 0, g: 0, b: 0, a: 255 }, 100);
    expect(getPixel(px2, 0, 0).r).toBe(127);
  });
  it('透明な色は「消す」：下のアルファを割合だけ下げ、0 になれば RGB も 0', () => {
    const px = fromTable(['rr']);
    renderCoverage(px, Uint8Array.from([255, 128]), COLORS['.']!, 100);
    expect(getPixel(px, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(getPixel(px, 1, 0)).toEqual({ r: 255, g: 0, b: 0, a: 127 });
  });
  it('選択（マスク）の外には重ねない', () => {
    const px = createPixels(3, 1);
    renderCoverage(px, Uint8Array.from([255, 255, 255]), COLORS['r']!, 100, maskRect(3, 1, 0, 1, 0));
    expect(toTable(px)).toEqual(['.r.']);
  });
});
