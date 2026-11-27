import { describe, expect, it } from 'vitest';
import {
  adjustHsl, closeness, extractColors, grayscaleMasked, hslToRgb, invertColorsMasked, makeTransparentMasked, monochromeMasked, opacityMasked, replaceColorMasked, rgbToHsl,
} from '../src/icon/paint/adjust';
import { createPixels, setPixel, getPixel } from '../src/icon/paint/pixels';
import { maskRect } from '../src/icon/paint/selection';
import { COLORS, fromTable, toTable } from './helpers/paintTable';

describe('HSL の変換', () => {
  it('RGB → HSL → RGB が、すべての 6 万 5 千色の格子点で元に戻る（丸めの 1 まで）', () => {
    let worst = 0;
    for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) {
      const [h, s, l] = rgbToHsl(r, g, b);
      const [r2, g2, b2] = hslToRgb(h, s, l);
      worst = Math.max(worst, Math.abs(r - r2), Math.abs(g - g2), Math.abs(b - b2));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
  it('原色と灰色', () => {
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 1, 0.5]);
    expect(rgbToHsl(0, 255, 0)[0]).toBe(120);
    expect(rgbToHsl(0, 0, 255)[0]).toBe(240);
    expect(rgbToHsl(128, 128, 128)[1]).toBe(0);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
  });
});

describe('色相・彩度・明るさ', () => {
  it('色相を 120° 回すと、赤は緑になる。アルファは保つ。透明には触れない', () => {
    const px = createPixels(3, 1);
    setPixel(px, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
    setPixel(px, 1, 0, { r: 255, g: 0, b: 0, a: 100 });
    adjustHsl(px, null, { hue: 120, saturation: 0, lightness: 0 });
    expect(getPixel(px, 0, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(getPixel(px, 1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 100 });
    expect(getPixel(px, 2, 0).a).toBe(0);
  });
  it('色相は 360° で一周する・負の向きにも回る', () => {
    const a = createPixels(1, 1);
    setPixel(a, 0, 0, { r: 200, g: 50, b: 20, a: 255 });
    const b = createPixels(1, 1);
    b.data.set(a.data);
    adjustHsl(a, null, { hue: 180, saturation: 0, lightness: 0 });
    adjustHsl(a, null, { hue: -180, saturation: 0, lightness: 0 });
    expect(Math.abs(a.data[0]! - b.data[0]!)).toBeLessThanOrEqual(2);
    expect(Math.abs(a.data[1]! - b.data[1]!)).toBeLessThanOrEqual(2);
  });
  it('彩度 −100 で灰色、明るさ −100 で黒・100 で白', () => {
    const mk = () => fromTable(['r']);
    const a = mk();
    adjustHsl(a, null, { hue: 0, saturation: -100, lightness: 0 });
    expect(a.data[0]).toBe(a.data[1]);
    expect(a.data[1]).toBe(a.data[2]);
    const b = mk();
    adjustHsl(b, null, { hue: 0, saturation: 0, lightness: -100 });
    expect([...b.data]).toEqual([0, 0, 0, 255]);
    const c = mk();
    adjustHsl(c, null, { hue: 0, saturation: 0, lightness: 100 });
    expect([...c.data]).toEqual([255, 255, 255, 255]);
  });
  it('選択範囲（マスク）の外は変わらない', () => {
    const px = fromTable(['rrrr']);
    adjustHsl(px, maskRect(4, 1, 0, 2, 0), { hue: 120, saturation: 0, lightness: 0 });
    expect([...px.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
  });
  it('何も変えない値なら、そのまま', () => {
    const px = fromTable(['rb']);
    const copy = [...px.data];
    adjustHsl(px, null, { hue: 0, saturation: 0, lightness: 0 });
    expect([...px.data]).toEqual(copy);
  });
});

describe('色の置き換え', () => {
  const red = { r: 255, g: 0, b: 0 };
  const blue = { r: 0, g: 0, b: 255 };
  it('許容差 0 は同じ色だけ、近い色は許容差を上げると置き換わる', () => {
    const mk = () => {
      const p = createPixels(2, 1);
      p.data.set([255, 0, 0, 255, 250, 5, 0, 255]);
      return p;
    };
    const exact = mk();
    replaceColorMasked(exact, null, red, blue, 0);
    expect([...exact.data]).toEqual([0, 0, 255, 255, 250, 5, 0, 255]);
    const wide = mk();
    replaceColorMasked(wide, null, red, blue, 10);
    expect([...wide.data]).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
  });
  it('半透明の縁（同じ色でアルファだけ低い）も置き換わり、アルファは保たれる', () => {
    const px = createPixels(3, 1);
    px.data.set([255, 0, 0, 255, 255, 0, 0, 128, 255, 0, 0, 40]);
    replaceColorMasked(px, null, red, blue, 0);
    expect([...px.data]).toEqual([0, 0, 255, 255, 0, 0, 255, 128, 0, 0, 255, 40]);
  });
  it('縁の混ざった色は、近さに応じて混ざる（境目がなだらか）', () => {
    expect(closeness(0, 20)).toBe(1);
    expect(closeness(1000, 20)).toBe(0);
    const t = (20 / 100) * Math.sqrt(3 * 255 * 255);
    expect(closeness(t * 0.5, 20)).toBe(1);
    expect(closeness(t * 0.75, 20)).toBeCloseTo(0.5, 5);
    expect(closeness(t, 20)).toBe(0);
    expect(closeness(1, 0)).toBe(0);
  });
  it('透明な画素・マスクの外には触れない', () => {
    const px = fromTable(['r.r']);
    replaceColorMasked(px, maskRect(3, 0, 0, 1, 0), red, blue, 0);
    expect(toTable(px)).toEqual(['b.r']);
  });
});

describe('そのほかの色の変更', () => {
  it('単色化は RGB だけを変える（アルファは保つ）', () => {
    const px = createPixels(2, 1);
    px.data.set([1, 2, 3, 255, 9, 9, 9, 77]);
    monochromeMasked(px, null, { r: 10, g: 20, b: 30 });
    expect([...px.data]).toEqual([10, 20, 30, 255, 10, 20, 30, 77]);
  });
  it('色の反転は 2 回で元に戻り、アルファは変わらない', () => {
    const px = createPixels(2, 1);
    px.data.set([1, 2, 3, 255, 9, 9, 9, 77]);
    const copy = [...px.data];
    invertColorsMasked(px, null);
    expect([...px.data]).toEqual([254, 253, 252, 255, 246, 246, 246, 77]);
    invertColorsMasked(px, null);
    expect([...px.data]).toEqual(copy);
  });
  it('グレースケール：白は白、純色は Rec.709 の明るさ', () => {
    const px = createPixels(3, 1);
    px.data.set([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
    grayscaleMasked(px, null);
    expect([px.data[0], px.data[4], px.data[8]]).toEqual([255, 54, 182]);
  });
  it('不透明度は今のアルファに掛ける。0 は透明にそろえる', () => {
    const px = createPixels(2, 1);
    px.data.set([5, 6, 7, 200, 5, 6, 7, 255]);
    opacityMasked(px, null, 50);
    expect([px.data[3], px.data[7]]).toEqual([100, 128]);
    opacityMasked(px, null, 0);
    expect([...px.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('この色を透明にする：一致は透明、縁はアルファを下げる、遠い色は変わらない', () => {
    const px = createPixels(3, 1);
    px.data.set([255, 255, 255, 255, 255, 255, 255, 100, 0, 0, 0, 255]);
    makeTransparentMasked(px, null, { r: 255, g: 255, b: 255 }, 5);
    expect([...px.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]);
  });
  it('使われている色を、多い順に（半透明の薄い画素は数えない）', () => {
    const px = fromTable(['rrb', 'rb.']);
    px.data.set([9, 9, 9, 100], 20); // 6 番目（透明のところ）を薄い画素に
    expect(extractColors(px)).toEqual([{ hex: '#ff0000', count: 3 }, { hex: '#0000ff', count: 2 }]);
    expect(extractColors(px, 1)).toHaveLength(1);
    expect(COLORS['r']).toBeTruthy();
  });
});

describe('見直し：無彩色・低彩度への彩度・色相・明るさ', () => {
  const run = (r: number, g: number, b: number, a: { hue?: number; saturation?: number; lightness?: number }) => {
    const px = createPixels(1, 1);
    px.data.set([r, g, b, 255]);
    adjustHsl(px, null, { hue: 0, saturation: 0, lightness: 0, ...a });
    return [px.data[0]!, px.data[1]!, px.data[2]!];
  };
  it('灰色・白・黒は、彩度を上げても変わらない（赤くならない）', () => {
    for (const v of [0, 1, 64, 128, 200, 255]) {
      for (const s of [10, 50, 100]) expect(run(v, v, v, { saturation: s })).toEqual([v, v, v]);
    }
  });
  it('わずかに色かぶりのある灰色は、少ししか鮮やかにならない（赤に飛ばない）', () => {
    const [r, g, b] = run(130, 128, 128, { saturation: 50 });
    expect(r - g).toBeLessThan(10);
    expect(g).toBe(b);
    const [r2, g2] = run(130, 128, 128, { saturation: 100 });
    expect(r2 - g2).toBeLessThan(20);
  });
  it('彩度は今の彩度に掛ける：+100 で 2 倍、−100 で灰色、負の途中は比例', () => {
    // 彩度 0.5 の色（#bf4040）：+100 で最大（1.0）
    const [r, g, b] = run(191, 64, 64, { saturation: 100 });
    expect(g).toBe(b);
    expect(r - g).toBeGreaterThan(191 - 64);
    const [r2, g2, b2] = run(191, 64, 64, { saturation: -100 });
    expect(r2).toBe(g2);
    expect(g2).toBe(b2);
    const half = run(191, 64, 64, { saturation: -50 });
    expect(half[0]! - half[1]!).toBeCloseTo((191 - 64) / 2, -1);
  });
  it('色相を回しても、灰色は灰色のまま。明るさを変えても R=G=B のまま', () => {
    for (const h of [-180, -90, 45, 120, 180]) expect(run(100, 100, 100, { hue: h })).toEqual([100, 100, 100]);
    for (const l of [-100, -50, 50, 100]) {
      const [r, g, b] = run(100, 100, 100, { lightness: l });
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });
  it('白と黒は、色相・彩度を変えても、明るさだけで動く', () => {
    expect(run(255, 255, 255, { hue: 90, saturation: 100 })).toEqual([255, 255, 255]);
    expect(run(0, 0, 0, { hue: 90, saturation: 100 })).toEqual([0, 0, 0]);
    expect(run(0, 0, 0, { lightness: 100 })).toEqual([255, 255, 255]);
  });
});
