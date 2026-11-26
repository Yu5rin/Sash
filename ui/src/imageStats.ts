// リボンに使う画像の大きさ・重さ・色合いを調べる（配布前チェック。仕様書 §23.5）。
// 大きさとバイト数は PNG のヘッダーと base64 の長さだけで分かるので同期で求める。色合いは画素を読む必要があるので、
// 画像を描いて調べる（ブラウザだけ。結果は覚えておき、チェックの画面は覚えた結果を使う）。画素の集計そのものは純粋な関数にしてある。

import type { ImageEntry } from './store';

/** 画素の集計。 */
export interface PixelStats {
  width: number;
  height: number;
  /** 不透明な（alpha が 128 以上の）画素の数。 */
  opaque: number;
  total: number;
  /** 不透明な画素の明るさ（0〜255）の平均。 */
  meanLuma: number;
  /** 不透明な画素のうち、暗い（明るさ 80 未満）ものの割合。 */
  darkShare: number;
  /** 不透明な画素のうち、明るい（明るさ 190 超）ものの割合。 */
  lightShare: number;
  /** 透明（alpha が 255 未満）の画素が 1 つでもあるか。 */
  hasTransparency: boolean;
  /** 四隅の画素がすべて不透明で、ほぼ同じ色の背景が付いているとき、その明るさの区分。背景が透明か、色が揃っていなければ null。 */
  solidBackground: 'light' | 'dark' | null;
}

export interface ImageInfo {
  bytes: number;
  width?: number;
  height?: number;
  stats?: PixelStats;
}

/** 明るさ（Rec.709 の係数。ガンマは補正しない目安）。 */
export function lumaOf(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** RGBA の画素列（1 画素 4 つ）から集計する。 */
export function analyzePixels(data: ArrayLike<number>, width: number, height: number): PixelStats {
  const total = width * height;
  let opaque = 0;
  let lumaSum = 0;
  let dark = 0;
  let light = 0;
  let transparent = false;
  for (let i = 0; i < total; i++) {
    const a = data[i * 4 + 3]!;
    if (a < 255) transparent = true;
    if (a < 128) continue;
    const l = lumaOf(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
    opaque++;
    lumaSum += l;
    if (l < 80) dark++;
    else if (l > 190) light++;
  }
  const corner = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    return { r: data[o]!, g: data[o + 1]!, b: data[o + 2]!, a: data[o + 3]! };
  };
  let solidBackground: PixelStats['solidBackground'] = null;
  if (width >= 4 && height >= 4) {
    const cs = [corner(0, 0), corner(width - 1, 0), corner(0, height - 1), corner(width - 1, height - 1)];
    const same = cs.every((c) => c.a >= 250 && Math.abs(c.r - cs[0]!.r) < 24 && Math.abs(c.g - cs[0]!.g) < 24 && Math.abs(c.b - cs[0]!.b) < 24);
    if (same) {
      const l = lumaOf(cs[0]!.r, cs[0]!.g, cs[0]!.b);
      solidBackground = l > 235 ? 'light' : l < 40 ? 'dark' : null;
    }
  }
  return {
    width,
    height,
    opaque,
    total,
    meanLuma: opaque ? lumaSum / opaque : 0,
    darkShare: opaque ? dark / opaque : 0,
    lightShare: opaque ? light / opaque : 0,
    hasTransparency: transparent,
    solidBackground,
  };
}

/** data URL の画像のバイト数（base64 の長さから）。 */
export function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',');
  const b64 = i < 0 ? '' : dataUrl.slice(i + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** PNG のヘッダー（IHDR）から幅と高さを読む。PNG でなければ null。 */
export function pngSize(dataUrl: string): { width: number; height: number } | null {
  const i = dataUrl.indexOf(',');
  if (i < 0 || !/^data:image\/png/i.test(dataUrl)) return null;
  let bin: string;
  try {
    bin = atob(dataUrl.slice(i + 1, i + 1 + 44));
  } catch {
    return null;
  }
  if (bin.length < 24 || bin.charCodeAt(0) !== 0x89 || bin.slice(1, 4) !== 'PNG') return null;
  const u32 = (o: number) => ((bin.charCodeAt(o) << 24) | (bin.charCodeAt(o + 1) << 16) | (bin.charCodeAt(o + 2) << 8) | bin.charCodeAt(o + 3)) >>> 0;
  return { width: u32(16), height: u32(20) };
}

// ---- 画素の読み取り（ブラウザ） ----

const cache = new Map<string, PixelStats | null>();

/** 画像を描いて集計する（大きい画像は縮める。色合いの判定には十分）。描けない環境（テスト）・壊れた画像は null。 */
export function loadPixelStats(dataUrl: string): Promise<PixelStats | null> {
  if (cache.has(dataUrl)) return Promise.resolve(cache.get(dataUrl)!);
  return new Promise((resolve) => {
    const done = (v: PixelStats | null) => {
      cache.set(dataUrl, v);
      resolve(v);
    };
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight, 1));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return done(null);
          ctx.drawImage(img, 0, 0, w, h);
          done({ ...analyzePixels(ctx.getImageData(0, 0, w, h).data, w, h), width: img.naturalWidth, height: img.naturalHeight });
        } catch {
          done(null);
        }
      };
      img.onerror = () => done(null);
      img.src = dataUrl;
    } catch {
      done(null);
    }
  });
}

/** 画像すべての色合いを調べて覚える。終わったら true（呼び出し側がチェックの画面を描き直す）。 */
export async function ensurePixelStats(images: readonly ImageEntry[]): Promise<boolean> {
  const todo = images.filter((i) => !cache.has(i.dataUrl));
  if (todo.length === 0) return false;
  await Promise.all(todo.map((i) => loadPixelStats(i.dataUrl)));
  return true;
}

/** 画像の情報（大きさ・バイト数は同期で、色合いは調べ終えていれば）。 */
export function imageInfoMap(images: readonly ImageEntry[]): Map<string, ImageInfo> {
  return new Map(images.map((i): [string, ImageInfo] => {
    const size = pngSize(i.dataUrl);
    const stats = cache.get(i.dataUrl) ?? undefined;
    return [i.id, { bytes: dataUrlBytes(i.dataUrl), width: size?.width ?? stats?.width, height: size?.height ?? stats?.height, stats }];
  }));
}
