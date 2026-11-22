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
