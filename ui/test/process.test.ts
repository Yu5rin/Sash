import { describe, expect, it } from 'vitest';
import { cornerColor, fitRect, keyOutColor, opaqueBounds, parseIco, pickIcoEntry, type Pixels } from '../src/icon/process';

function pixels(w: number, hgt: number, fill: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * hgt * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { data, width: w, height: hgt };
}

describe('アイコンの加工', () => {
  it('指定色に近い画素を透明にする', () => {
    const px = pixels(2, 1, [255, 255, 255, 255]);
    px.data.set([0, 0, 0, 255], 4);
    keyOutColor(px, { r: 250, g: 250, b: 250 }, 5);
    expect(px.data[3]).toBe(0);
    expect(px.data[7]).toBe(255);
  });

  it('不透明な部分の範囲を求める', () => {
    const px = pixels(10, 10, [0, 0, 0, 0]);
    px.data.set([1, 2, 3, 255], (3 * 10 + 2) * 4);
    px.data.set([1, 2, 3, 255], (6 * 10 + 7) * 4);
    expect(opaqueBounds(px)).toEqual({ x: 2, y: 3, width: 6, height: 4 });
    expect(opaqueBounds(pixels(3, 3, [0, 0, 0, 0]))).toBeNull();
  });

  it('余白をとって中央に収める', () => {
    expect(fitRect(100, 50, 32, 8)).toEqual({ x: 3, y: 9, width: 26, height: 13 });
  });

  it('四隅の色から背景色を推定する', () => {
    const px = pixels(4, 4, [255, 255, 255, 255]);
    px.data.set([0, 0, 0, 255], 0);
    expect(cornerColor(px)).toEqual({ r: 255, g: 255, b: 255 });
  });
});

function ico(entries: { w: number; png: boolean }[]): ArrayBuffer {
  const datas = entries.map((e) => (e.png ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]) : new Uint8Array([40, 0, 0, 0, 9, 9])));
  const total = 6 + 16 * entries.length + datas.reduce((s, d) => s + d.length, 0);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  v.setUint16(2, 1, true);
  v.setUint16(4, entries.length, true);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    v.setUint8(o, e.w === 256 ? 0 : e.w);
    v.setUint8(o + 1, e.w === 256 ? 0 : e.w);
    v.setUint16(o + 6, 32, true);
    v.setUint32(o + 8, datas[i]!.length, true);
    v.setUint32(o + 12, offset, true);
    new Uint8Array(buf, offset, datas[i]!.length).set(datas[i]!);
    offset += datas[i]!.length;
  });
  return buf;
}

describe('ICO', () => {
  it('含まれる全サイズを取り出し、出力サイズ以上で最も近いものを選ぶ', () => {
    const entries = parseIco(ico([{ w: 16, png: false }, { w: 48, png: false }, { w: 256, png: true }]))!;
    expect(entries.map((e) => e.width)).toEqual([16, 48, 256]);
    expect(entries[2]!.blob.type).toBe('image/png');
    expect(entries[0]!.blob.type).toBe('image/x-icon');
    expect(pickIcoEntry(entries, 32).width).toBe(48);
    expect(pickIcoEntry(entries, 300).width).toBe(256);
  });

  it('ICO でなければ null', () => {
    expect(parseIco(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer)).toBeNull();
  });
});

import { adjustBrightness, monochrome, parseHex, replaceColor, shapeMask, sharpen, squareCrop, toHex } from '../src/icon/process';

describe('色と形の加工', () => {
  it('単色化はアルファを保つ', () => {
    const px = pixels(1, 1, [10, 20, 30, 128]);
    monochrome(px, { r: 200, g: 100, b: 0 });
    expect(Array.from(px.data)).toEqual([200, 100, 0, 128]);
  });

  it('近い色だけを置き換える', () => {
    const px = pixels(2, 1, [255, 0, 0, 255]);
    px.data.set([0, 0, 255, 255], 4);
    replaceColor(px, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, 10);
    expect(Array.from(px.data.slice(0, 3))).toEqual([0, 255, 0]);
    expect(Array.from(px.data.slice(4, 7))).toEqual([0, 0, 255]);
  });

  it('明るさを上げ下げする', () => {
    const px = pixels(1, 1, [100, 100, 100, 255]);
    adjustBrightness(px, 50);
    expect(px.data[0]).toBe(178);
    adjustBrightness(px, -100);
    expect(px.data[0]).toBe(0);
  });

  it('円形マスクは四隅を透明にし、中心は残す', () => {
    const px = pixels(32, 32, [0, 0, 0, 255]);
    shapeMask(px, 'circle', 0);
    expect(px.data[3]).toBe(0);
    expect(px.data[(16 * 32 + 16) * 4 + 3]).toBe(255);
  });

  it('シャープ化は平らな面を変えない', () => {
    const px = pixels(3, 3, [100, 100, 100, 255]);
    sharpen(px, 100);
    expect(px.data[16]).toBe(100);
  });

  it('16進の色を変換する', () => {
    expect(parseHex('#1e7145')).toEqual({ r: 30, g: 113, b: 69 });
    expect(toHex({ r: 30, g: 113, b: 69 })).toBe('#1e7145');
  });

  it('手動切り抜きは画像に収まる正方形にする', () => {
    expect(squareCrop(10, 10, 40, 30, 100, 100)).toEqual({ x: 10, y: 10, width: 30, height: 30 });
    expect(squareCrop(90, 90, 120, 95, 100, 100)).toEqual({ x: 70, y: 70, width: 30, height: 30 });
    expect(squareCrop(5, 5, 5, 6, 100, 100)).toBeNull();
  });
});
