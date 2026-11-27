// PNG の書き出しと読み込み（描いた絵の元画像用）。DOM に触らない。
// canvas を通す（putImageData → toDataURL → getImageData）と、半透明の画素が乗算済みアルファで丸められ、
// ストレートアルファの値がずれる（半透明を含む絵で、成分の 3 割ほどが最大 100 以上ずれた）。描いた絵は
// 元画像として保存して描き直すので、画素をそのまま書く：圧縮しない deflate（stored ブロック）＋CRC32。
// 絵は 64×64 の最大 4 倍以下なので、圧縮しなくても 100KB 以下で済む。

import type { Pixels } from './pixels';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA（ストレートアルファ）をそのまま PNG にする。 */
export function encodePng(px: Pixels): Uint8Array<ArrayBuffer> {
  const rowBytes = px.width * 4;
  // 各行の先頭にフィルタの種類（0＝なし）を付ける
  const raw = new Uint8Array((rowBytes + 1) * px.height);
  for (let y = 0; y < px.height; y++) raw.set(px.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  // zlib：ヘッダ 2 バイト ＋ stored ブロック（1 つ 65535 バイトまで）＋ Adler-32
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const part = raw.subarray(b * 65535, Math.min(raw.length, (b + 1) * 65535));
    z[o++] = b === blocks - 1 ? 1 : 0;
    z[o++] = part.length & 0xff;
    z[o++] = part.length >> 8;
    z[o++] = ~part.length & 0xff;
    z[o++] = (~part.length >> 8) & 0xff;
    z.set(part, o);
    o += part.length;
  }
  new DataView(z.buffer).setUint32(o, adler32(raw));
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, px.width);
  hv.setUint32(4, px.height);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // RGBA
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * encodePng が書いた PNG（8 ビット RGBA・フィルタなし・stored ブロック）を、そのまま読む。
 * そうでない PNG（圧縮されたもの・別の形式）は null（呼び出し側が canvas で読む）。
 */
export function decodePng(bytes: Uint8Array): Pixels | null {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const len = v.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) return null;
    if (type === 'IHDR') {
      width = v.getUint32(pos + 8);
      height = v.getUint32(pos + 12);
      if (body[8] !== 8 || body[9] !== 6 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return null;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096 || idat.length === 0) return null;
  const z = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of idat) {
    z.set(p, at);
    at += p.length;
  }
  if (z.length < 6 || (z[0]! & 0x0f) !== 8 || ((z[0]! << 8) | z[1]!) % 31 !== 0) return null;
  const rowBytes = width * 4;
  const raw = new Uint8Array((rowBytes + 1) * height);
  let rawAt = 0;
  let i = 2;
  for (;;) {
    if (i + 5 > z.length) return null;
    const final = z[i]! & 1;
    // stored ブロック（BTYPE=00）だけ
    if ((z[i]! & 6) !== 0) return null;
    const len = z[i + 1]! | (z[i + 2]! << 8);
    if (((~len) & 0xffff) !== (z[i + 3]! | (z[i + 4]! << 8))) return null;
    i += 5;
    if (i + len > z.length || rawAt + len > raw.length) return null;
    raw.set(z.subarray(i, i + len), rawAt);
    rawAt += len;
    i += len;
    if (final) break;
  }
  if (rawAt !== raw.length) return null;
  const data = new Uint8ClampedArray(rowBytes * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (rowBytes + 1)] !== 0) return null;
    data.set(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)), y * rowBytes);
  }
  return { data, width, height };
}
