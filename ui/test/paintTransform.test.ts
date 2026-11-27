import { describe, expect, it } from 'vitest';
import { createPixels, setPixel } from '../src/icon/paint/pixels';
import { downsampleBox, fitWithin, recoverFromSource, sourceScale, upscaleNearest } from '../src/icon/paint/transform';
import { isNewerPaintMeta, readPaintMeta, withPaintMeta, withoutPaintMeta } from '../src/icon/paint/doc';
import { COLORS, fromTable, toTable } from './helpers/paintTable';

describe('整数倍の拡大と、その逆', () => {
  it('最近傍で拡大し、ブロックがそろっていれば元に戻る', () => {
    const px = fromTable(['r.', '.b']);
    const up = upscaleNearest(px, 2);
    expect(toTable(up)).toEqual(['rr..', 'rr..', '..bb', '..bb']);
    expect(toTable(recoverFromSource(up, 2)!)).toEqual(['r.', '.b']);
    expect(toTable(recoverFromSource(upscaleNearest(px, 4), 2)!)).toEqual(['r.', '.b']);
    expect(toTable(recoverFromSource(px, 2)!)).toEqual(['r.', '.b']);
  });
  it('半透明を含む乱数の絵が往復で一致する（16・32・64、倍率 1・2・4）', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const canvas of [16, 32, 64]) {
      const px = createPixels(canvas, canvas);
      for (let y = 0; y < canvas; y++) for (let x = 0; x < canvas; x++) setPixel(px, x, y, { r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256), a: [0, 255, 128, 17][Math.floor(rnd() * 4)]! });
      for (const k of [1, 2, 4]) {
        const back = recoverFromSource(upscaleNearest(px, k), canvas)!;
        expect(back.data).toEqual(px.data);
      }
    }
  });
  it('ブロックがそろわない・正方形でない・倍率が 1・2・4 でないときは null', () => {
    const up = upscaleNearest(fromTable(['r.', '.b']), 2);
    up.data.set([1, 2, 3, 255], 0);
    expect(recoverFromSource(up, 2)).toBeNull();
    expect(recoverFromSource(createPixels(4, 2), 2)).toBeNull();
    expect(recoverFromSource(createPixels(24, 24), 8)).toBeNull(); // 3 倍
    expect(recoverFromSource(createPixels(10, 10), 3)).toBeNull();
    expect(recoverFromSource(createPixels(32, 32), 4)).toBeNull(); // 8 倍
  });
  it('出力より小さいキャンバスだけ拡大する倍率', () => {
    expect(sourceScale(16, 32)).toBe(2);
    expect(sourceScale(16, 64)).toBe(4);
    expect(sourceScale(32, 32)).toBe(1);
    expect(sourceScale(32, 64)).toBe(2);
    expect(sourceScale(64, 32)).toBe(1);
  });
});

describe('縮小（貼り付けの収め方）', () => {
  it('面積平均で縮める', () => {
    const px = fromTable(['#w', 'w#']);
    const d = downsampleBox(px, 1, 1);
    expect([...d.data]).toEqual([128, 128, 128, 255]);
  });
  it('透明な画素は色を混ぜない', () => {
    const px = fromTable(['r.', '..']);
    const d = downsampleBox(px, 1, 1);
    expect([...d.data]).toEqual([255, 0, 0, 64]);
  });
  it('収まっていればそのまま、大きければ縦横の比を保って収める', () => {
    const small = createPixels(3, 2);
    expect(fitWithin(small, 4)).toBe(small);
    const big = createPixels(8, 4);
    const f = fitWithin(big, 4);
    expect([f.width, f.height]).toEqual([4, 2]);
  });
});

describe('保存形式（options.paint）', () => {
  it('正しい形だけを読む', () => {
    expect(readPaintMeta({ paint: { v: 1, canvas: 16 } }, 32, 32)).toEqual({ v: 1, canvas: 16 });
    expect(readPaintMeta({ paint: { v: 1, canvas: 32 } }, 32, 32)).toEqual({ v: 1, canvas: 32 });
    expect(readPaintMeta({ paint: { v: 1, canvas: 16 } }, 64, 64)).toEqual({ v: 1, canvas: 16 });
  });
  it('v が違う・キャンバスの値が変・倍率が合わない・正方形でないものは null（共有フォルダの値は信用しない）', () => {
    expect(readPaintMeta({ paint: { v: 2, canvas: 16 } }, 32, 32)).toBeNull();
    expect(readPaintMeta({ paint: { v: 0, canvas: 16 } }, 32, 32)).toBeNull();
    expect(readPaintMeta({ paint: { v: 1, canvas: 24 } }, 48, 48)).toBeNull();
    expect(readPaintMeta({ paint: { v: 1, canvas: '16' } }, 32, 32)).toBeNull();
    expect(readPaintMeta({ paint: { v: 1, canvas: 16 } }, 48, 48)).toBeNull(); // 3 倍
    expect(readPaintMeta({ paint: { v: 1, canvas: 16 } }, 32, 16)).toBeNull();
    expect(readPaintMeta({ paint: { v: 1, canvas: 64 } }, 32, 32)).toBeNull(); // 縮小は戻せない
    expect(readPaintMeta({ paint: null }, 32, 32)).toBeNull();
    expect(readPaintMeta({ paint: [1] }, 32, 32)).toBeNull();
    expect(readPaintMeta({}, 32, 32)).toBeNull();
    expect(readPaintMeta(null, 32, 32)).toBeNull();
    expect(readPaintMeta('x', 32, 32)).toBeNull();
  });
  it('もっと新しい版の形式を見分ける', () => {
    expect(isNewerPaintMeta({ paint: { v: 2, canvas: 16 } })).toBe(true);
    expect(isNewerPaintMeta({ paint: { v: 1, canvas: 16 } })).toBe(false);
    expect(isNewerPaintMeta({})).toBe(false);
  });
  it('足す・外すは、元のオブジェクトを変えず、ほかの鍵を残す', () => {
    const o = { size: 32, padding: 0 };
    const w = withPaintMeta(o, 16);
    expect(w).toEqual({ size: 32, padding: 0, paint: { v: 1, canvas: 16 } });
    expect(o).toEqual({ size: 32, padding: 0 });
    expect(withoutPaintMeta(w)).toEqual({ size: 32, padding: 0 });
    expect(COLORS['.']).toBeTruthy();
  });
});
