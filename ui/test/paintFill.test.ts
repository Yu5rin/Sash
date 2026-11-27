import { describe, expect, it } from 'vitest';
import { floodFill, regionMask } from '../src/icon/paint/fill';
import { maskRect } from '../src/icon/paint/selection';
import { COLORS, fromTable, toTable } from './helpers/paintTable';

describe('塗りつぶし', () => {
  it('つながった同じ色の範囲だけを塗る（斜めには漏れない）', () => {
    const px = fromTable([
      '..#..',
      '.#...',
      '#....',
      '.....',
    ]);
    // 左上の (0,0) は壁（#）に斜めに囲まれている
    floodFill(px, 0, 0, COLORS['r']!, 0, true);
    expect(toTable(px)).toEqual([
      'rr#..',
      'r#...',
      '#....',
      '.....',
    ]);
  });
  it('壁で仕切られていれば反対側は塗らない', () => {
    const px = fromTable(['..#..', '..#..', '..#..']);
    floodFill(px, 0, 0, COLORS['b']!, 0, true);
    expect(toTable(px)).toEqual(['bb#..', 'bb#..', 'bb#..']);
  });
  it('全体モードは、つながっていない同じ色もすべて塗る', () => {
    const px = fromTable(['..#..', '..#..']);
    const n = floodFill(px, 0, 0, COLORS['g']!, 0, false);
    expect(n).toBe(8);
    expect(toTable(px)).toEqual(['gg#gg', 'gg#gg']);
  });
  it('同じ色で塗っても止まる', () => {
    const px = fromTable(['rrr', 'rrr']);
    expect(floodFill(px, 1, 1, COLORS['r']!, 0, true)).toBe(6);
    expect(toTable(px)).toEqual(['rrr', 'rrr']);
  });
  it('透明を塗る・透明で塗る（消す）', () => {
    const px = fromTable(['..#', '..#']);
    floodFill(px, 0, 0, COLORS['r']!, 0, true);
    expect(toTable(px)).toEqual(['rr#', 'rr#']);
    floodFill(px, 0, 0, COLORS['.']!, 0, true);
    expect(toTable(px)).toEqual(['..#', '..#']);
  });
  it('許容差の境目（0 は一致のみ、5% は距離 25.5 まで）', () => {
    const px = fromTable(['###']);
    px.data.set([20, 0, 0, 255], 4); // 距離 20
    px.data.set([40, 0, 0, 255], 8); // 距離 40
    expect(regionMask(px, 0, 0, 0, true)[1]).toBe(0);
    expect(regionMask(px, 0, 0, 5, true)[1]).toBe(255); // 5% = 25.5
    expect(regionMask(px, 0, 0, 5, true)[2]).toBe(0);
    expect(regionMask(px, 0, 0, 10, true)[2]).toBe(255); // 10% = 51 なので距離 40 にも届く
  });
  it('選択範囲があれば、その中だけを塗る（つながりも範囲の外へ広がらない）', () => {
    const px = fromTable(['.....', '.....']);
    floodFill(px, 1, 0, COLORS['r']!, 0, true, maskRect(5, 1, 0, 2, 1));
    expect(toTable(px)).toEqual(['.rr..', '.rr..']);
  });
  it('起点が範囲の外・選択の外なら何もしない', () => {
    const px = fromTable(['..', '..']);
    expect(floodFill(px, -1, 0, COLORS['r']!, 0, true)).toBe(0);
    expect(floodFill(px, 0, 0, COLORS['r']!, 0, true, maskRect(2, 1, 1, 1, 1))).toBe(0);
  });
  it('完全に透明な画素は、色の成分が違っても同じとして塗る', () => {
    const px = fromTable(['..']);
    px.data.set([9, 9, 9, 0], 4);
    expect(floodFill(px, 0, 0, COLORS['r']!, 0, true)).toBe(2);
  });
});
