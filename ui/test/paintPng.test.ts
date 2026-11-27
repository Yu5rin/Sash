import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/icon/paint/png';
import { createPixels } from '../src/icon/paint/pixels';

describe('PNG の書き出しと読み込み（画素をそのまま）', () => {
  it('ストレートアルファの任意の値が、往復でそのまま戻る（半透明の低いアルファの色も）', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
    for (const n of [1, 16, 32, 64, 128]) {
      const px = createPixels(n, n);
      for (let i = 0; i < px.data.length; i++) px.data[i] = rnd();
      const back = decodePng(encodePng(px))!;
      expect(back.width).toBe(n);
      expect(back.data).toEqual(px.data);
    }
  });
  it('65535 バイトを超える絵（複数の stored ブロック）も戻る', () => {
    const px = createPixels(200, 100);
    for (let i = 0; i < px.data.length; i++) px.data[i] = i % 251;
    expect(decodePng(encodePng(px))!.data).toEqual(px.data);
  });
  it('PNG の署名・IHDR・IEND があり、CRC が正しい（既知の 1×1）', () => {
    const px = createPixels(1, 1);
    px.data.set([255, 0, 0, 255]);
    const b = encodePng(px);
    expect([...b.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IEND チャンクの CRC は固定
    expect([...b.slice(-12)]).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  });
  it('読めないもの（署名が違う・切れている・圧縮されたもの）は null', () => {
    expect(decodePng(new Uint8Array(40))).toBeNull();
    const b = encodePng(createPixels(4, 4));
    expect(decodePng(b.slice(0, 30))).toBeNull();
    const bad = new Uint8Array(b);
    bad[8 + 8 + 9] = 2; // 色の種類が違う
    expect(decodePng(bad)).toBeNull();
  });
});
