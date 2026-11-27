// 画素の変形：整数倍の拡大（出力用）とその逆（拡大した元画像から絵を戻す）、面積平均の縮小。DOM に触らない。

import { sameRgba } from './color';
import { createPixels, getPixel, type Pixels } from './pixels';

/** 最近傍で整数倍に拡大する（ドットがぼけない）。 */
export function upscaleNearest(px: Pixels, k: number): Pixels {
  if (k === 1) return { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
  const out = createPixels(px.width * k, px.height * k);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const si = (Math.floor(y / k) * px.width + Math.floor(x / k)) * 4;
      out.data.set(px.data.subarray(si, si + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/** 描いた絵（キャンバスの大きさ）から、アイコンエディタの元画像にするときの拡大の倍率。出力より小さいときだけ拡大する。 */
export function sourceScale(canvas: number, outputSize: number): number {
  return Math.max(1, Math.floor(outputSize / canvas));
}

/** 元画像から戻せる倍率。 */
const SCALES = [1, 2, 4];

/**
 * upscaleNearest で拡大した元画像から、絵を戻す。正方形で、幅が canvas の 1・2・4 倍で、
 * k×k のブロックの中がどれも同じ色のときだけ戻せる（そうでなければ null：普通の画像として扱う）。
 */
export function recoverFromSource(px: Pixels, canvas: number): Pixels | null {
  if (px.width !== px.height || canvas <= 0 || px.width % canvas !== 0) return null;
  const k = px.width / canvas;
  if (!SCALES.includes(k)) return null;
  const out = createPixels(canvas, canvas);
  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      const first = getPixel(px, x * k, y * k);
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          if (!sameRgba(first, getPixel(px, x * k + dx, y * k + dy))) return null;
        }
      }
      out.data.set([first.r, first.g, first.b, first.a], (y * canvas + x) * 4);
    }
  }
  return out;
}

/** 面積平均で縮める（半透明の画素は、アルファで重み付けして混ぜる）。貼り付けた大きな画像を収めるのに使う。 */
export function downsampleBox(px: Pixels, width: number, height: number): Pixels {
  const out = createPixels(width, height);
  const sx = px.width / width;
  const sy = px.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const y0 = y * sy;
      const y1 = (y + 1) * sy;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const w = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const i = (Math.min(yy, px.height - 1) * px.width + Math.min(xx, px.width - 1)) * 4;
          const pa = px.data[i + 3]! * w;
          r += px.data[i]! * pa;
          g += px.data[i + 1]! * pa;
          b += px.data[i + 2]! * pa;
          a += pa;
          area += w;
        }
      }
      if (a <= 0 || area <= 0) continue;
      const o = (y * width + x) * 4;
      out.data[o] = Math.round(r / a);
      out.data[o + 1] = Math.round(g / a);
      out.data[o + 2] = Math.round(b / a);
      out.data[o + 3] = Math.round(a / area);
    }
  }
  return out;
}

/** 正方形のキャンバスに収まる大きさにする（収まっていればそのまま）。縦横の比は保つ。 */
export function fitWithin(px: Pixels, size: number): Pixels {
  if (px.width <= size && px.height <= size) return px;
  const scale = size / Math.max(px.width, px.height);
  return downsampleBox(px, Math.max(1, Math.round(px.width * scale)), Math.max(1, Math.round(px.height * scale)));
}
