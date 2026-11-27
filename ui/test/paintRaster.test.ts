import { describe, expect, it } from 'vitest';
import { brushOffsets, line, stamp, stampLine } from '../src/icon/paint/raster';
import { TRANSPARENT } from '../src/icon/paint/color';
import { createPixels } from '../src/icon/paint/pixels';
import { COLORS, maskTable, toTable } from './helpers/paintTable';
import { maskRect } from '../src/icon/paint/selection';

const pts = (x0: number, y0: number, x1: number, y1: number): string => {
  const out: string[] = [];
  line(x0, y0, x1, y1, (x, y) => out.push(`${x},${y}`));
  return out.join(' ');
};
const set = (x0: number, y0: number, x1: number, y1: number) => {
  const s = new Set<string>();
  line(x0, y0, x1, y1, (x, y) => s.add(`${x},${y}`));
  return [...s].sort();
};

describe('直線（Bresenham）', () => {
  it('1 点は 1 点だけ', () => {
    expect(pts(3, 4, 3, 4)).toBe('3,4');
  });
  it('8 方向の直線は、始点と終点を含んで連続する', () => {
    expect(pts(0, 0, 3, 0)).toBe('0,0 1,0 2,0 3,0');
    expect(pts(0, 0, 0, 2)).toBe('0,0 0,1 0,2');
    expect(pts(0, 0, 3, 3)).toBe('0,0 1,1 2,2 3,3');
    expect(pts(3, 0, 0, 3)).toBe('0,3 1,2 2,1 3,0');
    expect(pts(0, 0, 5, 2)).toBe('0,0 1,0 2,1 3,1 4,2 5,2');
  });
  it('逆向きでも同じ点の集まりになる', () => {
    for (const [a, b, c, d] of [[0, 0, 7, 3], [5, 1, -2, 6], [2, 2, 2, 9], [9, 4, 1, 4], [0, 8, 8, 0]] as const) {
      expect(set(a, b, c, d)).toEqual(set(c, d, a, b));
    }
  });
});

describe('筆先', () => {
  it('太さ 1 は 1 画素、2 は 2×2、3 の四角は 3×3', () => {
    expect(brushOffsets({ size: 1, round: false })).toEqual([[0, 0]]);
    expect(brushOffsets({ size: 2, round: true })).toHaveLength(4);
    expect(brushOffsets({ size: 3, round: false })).toHaveLength(9);
  });
  it('丸の筆先は、太さ 3 で十字、太さ 5 で角が欠ける', () => {
    expect(brushOffsets({ size: 3, round: true })).toHaveLength(5);
    const five = brushOffsets({ size: 5, round: true });
    expect(five).toHaveLength(21);
    expect(five.some(([x, y]) => x === 2 && y === 2)).toBe(false);
  });
  it('丸の太さ 4 は、四隅が欠けた 4×4', () => {
    const px = createPixels(6, 6);
    stamp(px, 2, 2, { size: 4, round: true }, COLORS['#']!);
    expect(toTable(px)).toEqual(['......', '..##..', '.####.', '.####.', '..##..', '......']);
  });
});

describe('筆先で線を引く', () => {
  it('太さ 1 の斜めの線', () => {
    const px = createPixels(5, 5);
    stampLine(px, 0, 0, 4, 4, { size: 1, round: false }, COLORS['r']!);
    expect(toTable(px)).toEqual(['r....', '.r...', '..r..', '...r.', '....r']);
  });
  it('太さ 2 は 2 画素幅になる', () => {
    const px = createPixels(6, 3);
    stampLine(px, 0, 0, 3, 0, { size: 2, round: false }, COLORS['#']!);
    expect(toTable(px)).toEqual(['#####.', '#####.', '......']);
  });
  it('範囲の外から入ってくる線も、内側の部分は引ける。外は捨てる', () => {
    const px = createPixels(4, 4);
    stampLine(px, -5, 1, 10, 1, { size: 1, round: false }, COLORS['#']!);
    expect(toTable(px)[1]).toBe('####');
  });
  it('選択の外には書かない', () => {
    const px = createPixels(4, 4);
    stampLine(px, 0, 0, 3, 0, { size: 1, round: false }, COLORS['#']!, maskRect(4, 1, 0, 2, 0));
    expect(toTable(px)[0]).toBe('.##.');
  });
  it('透明を書くと消える（RGB も 0 になる）', () => {
    const px = createPixels(2, 1);
    stamp(px, 0, 0, { size: 1, round: false }, COLORS['r']!);
    stamp(px, 0, 0, { size: 1, round: false }, TRANSPARENT);
    expect([...px.data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });
});

it('maskRect は範囲の外を切る', () => {
  expect(maskTable(maskRect(4, -2, -2, 1, 1), 4)).toEqual(['##..', '##..', '....', '....']);
});
