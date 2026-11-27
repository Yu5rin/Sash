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

// ---- 反転・90° 回転・大きさの変更（第 2 段階） ----

export type Flip = 'h' | 'v';
export type Rotation = 'cw' | 'ccw';

/** 1 画素 channels バイトの格子（画素なら 4、マスクなら 1）を、左右・上下に反転する。 */
function flipBytes(src: Uint8ClampedArray | Uint8Array, w: number, h: number, channels: number, axis: Flip): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = axis === 'h' ? w - 1 - x : x;
      const sy = axis === 'v' ? h - 1 - y : y;
      for (let c = 0; c < channels; c++) out[(y * w + x) * channels + c] = src[(sy * w + sx) * channels + c]!;
    }
  }
  return out;
}

/** 90° 回転した格子（幅と高さが入れ替わる）。 */
function rotateBytes(src: Uint8ClampedArray | Uint8Array, w: number, h: number, channels: number, dir: Rotation): Uint8Array {
  const out = new Uint8Array(src.length);
  // 回転後の幅は h、高さは w
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < h; x++) {
      // cw：回転後の (x, y) は、元の (y, h-1-x)。ccw：元の (w-1-y, x)
      const sx = dir === 'cw' ? y : w - 1 - y;
      const sy = dir === 'cw' ? h - 1 - x : x;
      for (let c = 0; c < channels; c++) out[(y * h + x) * channels + c] = src[(sy * w + sx) * channels + c]!;
    }
  }
  return out;
}

export function flipPixels(px: Pixels, axis: Flip): Pixels {
  return { data: new Uint8ClampedArray(flipBytes(px.data, px.width, px.height, 4, axis)), width: px.width, height: px.height };
}

export function rotatePixels(px: Pixels, dir: Rotation): Pixels {
  return { data: new Uint8ClampedArray(rotateBytes(px.data, px.width, px.height, 4, dir)), width: px.height, height: px.width };
}

export function flipMask(mask: Uint8Array, w: number, h: number, axis: Flip): Uint8Array {
  return flipBytes(mask, w, h, 1, axis);
}

export function rotateMask(mask: Uint8Array, w: number, h: number, dir: Rotation): Uint8Array {
  return rotateBytes(mask, w, h, 1, dir);
}

export type ResizeMode = 'nearest' | 'smooth';

/** 正方形の絵を size × size にする。nearest は最近傍（ドットを保つ）、smooth は縮小が面積平均・拡大が双一次（半透明は乗算済みで混ぜる）。 */
export function resizeSquare(px: Pixels, size: number, mode: ResizeMode): Pixels {
  if (px.width === size && px.height === size) return { data: new Uint8ClampedArray(px.data), width: size, height: size };
  if (mode === 'nearest') {
    const out = createPixels(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const si = (Math.floor((y * px.height) / size) * px.width + Math.floor((x * px.width) / size)) * 4;
        out.data.set(px.data.subarray(si, si + 4), (y * size + x) * 4);
      }
    }
    return out;
  }
  if (size < px.width) return downsampleBox(px, size, size);
  // 拡大：双一次補間（乗算済みアルファで混ぜる）
  const out = createPixels(size, size);
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = (Math.min(px.height - 1, Math.max(0, y)) * px.width + Math.min(px.width - 1, Math.max(0, x))) * 4;
    const a = px.data[i + 3]! / 255;
    return [px.data[i]! * a, px.data[i + 1]! * a, px.data[i + 2]! * a, px.data[i + 3]!];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = ((x + 0.5) * px.width) / size - 0.5;
      const fy = ((y + 0.5) * px.height) / size - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const mix = [0, 0, 0, 0];
      for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]] as const) {
        const v = at(x0 + dx, y0 + dy);
        for (let c = 0; c < 4; c++) mix[c]! += v[c]! * w;
      }
      const a = mix[3]!;
      if (a <= 0) continue;
      const o = (y * size + x) * 4;
      out.data[o] = Math.round((mix[0]! * 255) / a);
      out.data[o + 1] = Math.round((mix[1]! * 255) / a);
      out.data[o + 2] = Math.round((mix[2]! * 255) / a);
      out.data[o + 3] = Math.round(a);
    }
  }
  return out;
}

/** 不透明な部分（アルファが 0 でない画素）を、同じ大きさの絵の中央に寄せる（余白のカット）。何も描かれていなければそのまま。 */
export function trimToCenter(px: Pixels): Pixels {
  let minX = px.width;
  let minY = px.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (px.data[(y * px.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const out = createPixels(px.width, px.height);
  const ox = Math.floor((px.width - bw) / 2);
  const oy = Math.floor((px.height - bh) / 2);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = ((minY + y) * px.width + minX + x) * 4;
      out.data.set(px.data.subarray(si, si + 4), ((oy + y) * px.width + ox + x) * 4);
    }
  }
  return out;
}
