// アイコンの加工処理（仕様書 §6.2）。canvas に依存しない純粋な関数にして、テストできるようにする。

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * 指定した色に近い画素を透明にする（白背景の JPG 対策）。
 * tolerance は 0〜100。境界付近は半透明にして、縁のギザギザを抑える。
 */
export function keyOutColor(px: Pixels, key: Rgb, tolerance: number): void {
  const max = Math.sqrt(3 * 255 * 255);
  const t = (tolerance / 100) * max;
  const soft = Math.max(t * 0.3, 1);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt((d[i]! - key.r) ** 2 + (d[i + 1]! - key.g) ** 2 + (d[i + 2]! - key.b) ** 2);
    if (dist <= t) d[i + 3] = 0;
    else if (dist <= t + soft) d[i + 3] = Math.round(d[i + 3]! * ((dist - t) / soft));
  }
}

/** 不透明な部分を囲む矩形。すべて透明なら null。 */
export function opaqueBounds(px: Pixels, threshold = 8): { x: number; y: number; width: number; height: number } | null {
  let minX = px.width;
  let minY = px.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (px.data[(y * px.width + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 出力サイズの正方形の中に、余白を取って収めるときの描画位置。 */
export function fitRect(srcW: number, srcH: number, size: number, paddingPercent: number): { x: number; y: number; width: number; height: number } {
  const pad = Math.round((size * paddingPercent) / 100);
  const inner = Math.max(size - pad * 2, 1);
  const scale = inner / Math.max(srcW, srcH);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  return { x: Math.floor((size - width) / 2), y: Math.floor((size - height) / 2), width, height };
}

/** 画像の四隅で一番多い色（背景色の推定に使う）。 */
export function cornerColor(px: Pixels): Rgb {
  const pts = [[0, 0], [px.width - 1, 0], [0, px.height - 1], [px.width - 1, px.height - 1]] as const;
  const colors = pts.map(([x, y]) => {
    const i = (y * px.width + x) * 4;
    return { r: px.data[i]!, g: px.data[i + 1]!, b: px.data[i + 2]! };
  });
  const key = (c: Rgb) => `${c.r >> 3},${c.g >> 3},${c.b >> 3}`;
  const counts = new Map<string, number>();
  for (const c of colors) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  return colors.reduce((best, c) => ((counts.get(key(c)) ?? 0) > (counts.get(key(best)) ?? 0) ? c : best), colors[0]!);
}

// ---- ICO ----

export interface IcoEntry {
  width: number;
  height: number;
  bitCount: number;
  /** この画像だけを含む、ブラウザで読み込める Blob（PNG か、1枚だけの ICO）。 */
  blob: Blob;
}

/** ICO を分解する。含まれる全サイズを返す。ICO でなければ null。 */
export function parseIco(buf: ArrayBuffer): IcoEntry[] | null {
  const v = new DataView(buf);
  if (buf.byteLength < 6 || v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 1) return null;
  const count = v.getUint16(4, true);
  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.byteLength) break;
    const width = v.getUint8(o) || 256;
    const height = v.getUint8(o + 1) || 256;
    const bitCount = v.getUint16(o + 6, true);
    const size = v.getUint32(o + 8, true);
    const offset = v.getUint32(o + 12, true);
    if (offset + size > buf.byteLength) continue;
    const data = new Uint8Array(buf, offset, size);
    const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    if (isPng) {
      entries.push({ width, height, bitCount, blob: new Blob([data.slice()], { type: 'image/png' }) });
    } else {
      // BMP 形式の画像は、その1枚だけを持つ ICO に包み直してブラウザに読ませる
      const head = new ArrayBuffer(22);
      const hv = new DataView(head);
      hv.setUint16(2, 1, true);
      hv.setUint16(4, 1, true);
      new Uint8Array(head, 6, 16).set(new Uint8Array(buf, o, 16));
      hv.setUint32(6 + 12, 22, true);
      entries.push({ width, height, bitCount, blob: new Blob([head, data.slice()], { type: 'image/x-icon' }) });
    }
  }
  return entries.length ? entries : null;
}

/** 出力サイズ以上で最も近いもの。なければ最大のもの。同じ大きさなら色数の多いもの。 */
export function pickIcoEntry(entries: readonly IcoEntry[], size: number): IcoEntry {
  const sorted = [...entries].sort((a, b) => a.width - b.width || b.bitCount - a.bitCount);
  return sorted.find((e) => e.width >= size) ?? sorted.at(-1)!;
}

// ---- 色と形の加工（仕様書 §6.2、第2弾） ----

/** 不透明な部分を1色にする（アルファは保つ）。 */
export function monochrome(px: Pixels, color: Rgb): void {
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = color.r;
    d[i + 1] = color.g;
    d[i + 2] = color.b;
  }
}

/** from に近い色を to に置き換える。境界は距離に応じて混ぜる。 */
export function replaceColor(px: Pixels, from: Rgb, to: Rgb, tolerance: number): void {
  const max = Math.sqrt(3 * 255 * 255);
  const t = Math.max((tolerance / 100) * max, 1);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt((d[i]! - from.r) ** 2 + (d[i + 1]! - from.g) ** 2 + (d[i + 2]! - from.b) ** 2);
    if (dist > t) continue;
    const k = 1 - (dist / t) * 0.5;
    d[i] = Math.round(d[i]! + (to.r - d[i]!) * k);
    d[i + 1] = Math.round(d[i + 1]! + (to.g - d[i + 1]!) * k);
    d[i + 2] = Math.round(d[i + 2]! + (to.b - d[i + 2]!) * k);
  }
}

/** 明るさを変える。amount は -100〜100。 */
export function adjustBrightness(px: Pixels, amount: number): void {
  if (amount === 0) return;
  const d = px.data;
  const a = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c]!;
      d[i + c] = Math.round(a > 0 ? v + (255 - v) * a : v * (1 + a));
    }
  }
}

/** 角丸（radius は短辺に対する割合 0〜50%）か円形で切り抜く。縁は1px分なめらかにする。 */
export function shapeMask(px: Pixels, shape: 'none' | 'rounded' | 'circle', radiusPercent: number): void {
  if (shape === 'none') return;
  const w = px.width;
  const h = px.height;
  const r = shape === 'circle' ? Math.min(w, h) / 2 : (Math.min(w, h) * Math.min(radiusPercent, 50)) / 100;
  if (r <= 0) return;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 画素の中心から、角の円の中心までの距離で判定する
      const cx = x + 0.5;
      const cy = y + 0.5;
      const dx = cx < r ? r - cx : cx > w - r ? cx - (w - r) : 0;
      const dy = cy < r ? r - cy : cy > h - r ? cy - (h - r) : 0;
      if (dx === 0 || dy === 0) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cover = Math.min(Math.max(r - dist + 0.5, 0), 1);
      const i = (y * w + x) * 4 + 3;
      px.data[i] = Math.round(px.data[i]! * cover);
    }
  }
}

/**
 * シャープ化（アンシャープマスク）。縮小で線がぼけるのを補う。amount は 0〜100。
 * 透明な部分の色を引き込まないよう、アルファで重み付けして平均を取る。
 */
export function sharpen(px: Pixels, amount: number): void {
  if (amount <= 0) return;
  const w = px.width;
  const h = px.height;
  const src = new Uint8ClampedArray(px.data);
  const k = amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = (ny * w + nx) * 4;
            const a = src[j + 3]! / 255;
            sum += src[j + c]! * a;
            weight += a;
          }
        }
        const blur = weight > 0 ? sum / weight : src[i + c]!;
        px.data[i + c] = Math.round(src[i + c]! + (src[i + c]! - blur) * k);
      }
    }
  }
}

/** 16進の色（#rrggbb）を RGB にする。 */
export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

export function toHex(c: Rgb): string {
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 手動切り抜きの矩形を、画像の範囲に収まる正方形にそろえる。 */
export function squareCrop(x0: number, y0: number, x1: number, y1: number, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  const size = Math.round(Math.min(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)), width, height));
  if (size < 2) return null;
  const x = Math.round(Math.min(Math.max(x1 < x0 ? x0 - size : x0, 0), width - size));
  const y = Math.round(Math.min(Math.max(y1 < y0 ? y0 - size : y0, 0), height - size));
  return { x, y, width: size, height: size };
}
