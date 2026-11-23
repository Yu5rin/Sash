// リボン定義の書き出し・読み込み（.sash.json、仕様書 §5.1）。別のブックへの流用と、Git での差分管理に使う。
// XML は1行ずつの配列で持ち、Git の差分が行単位で読めるようにする。

import type { CustomUIVersion } from './bridge';
import type { PartStore } from './store';
import { t } from './i18n';

export const SASH_FORMAT = 'sash-ribbon';
export const SASH_FORMAT_VERSION = 1;

export interface SashImage {
  id: string;
  contentType: string;
  base64: string;
}

export interface SashPart {
  version: CustomUIVersion;
  xml: string[];
  images: SashImage[];
}

export interface SashFile {
  format: typeof SASH_FORMAT;
  formatVersion: number;
  /** 書き出し元のファイル名（参考情報）。 */
  source?: string;
  parts: SashPart[];
}

function splitDataUrl(url: string): { contentType: string; base64: string } {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
  return m ? { contentType: m[1]!, base64: m[2]! } : { contentType: 'image/png', base64: '' };
}

export function exportSash(parts: readonly PartStore[], source?: string): string {
  const file: SashFile = {
    format: SASH_FORMAT,
    formatVersion: SASH_FORMAT_VERSION,
    source,
    parts: parts.map((p) => ({
      version: p.version,
      xml: p.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'),
      images: [...p.images.values()].sort((a, b) => a.id.localeCompare(b.id)).map((i) => ({ id: i.id, ...splitDataUrl(i.dataUrl) })),
    })),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/** 読み込んで検証する。形式が違えば理由つきで例外にする。 */
export function parseSash(text: string): SashFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t('JSONとして読み込めません'));
  }
  if (!isObject(data)) throw new Error(t('Sash のリボン定義ファイル（.sash.json）ではありません'));
  const f = data as Partial<SashFile>;
  if (f.format !== SASH_FORMAT) throw new Error(t('Sash のリボン定義ファイル（.sash.json）ではありません'));
  if (typeof f.formatVersion !== 'number' || f.formatVersion > SASH_FORMAT_VERSION) throw new Error(t('新しいバージョンの Sash で書き出されたファイルです。Sash を更新してください'));
  if (!Array.isArray(f.parts) || f.parts.length === 0) throw new Error(t('リボン定義が含まれていません'));
  return {
    format: SASH_FORMAT,
    formatVersion: f.formatVersion,
    source: typeof f.source === 'string' ? f.source : undefined,
    parts: (f.parts as unknown[]).map((raw, index) => parsePart(raw, index + 1)),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 1つのパーツを検証する。手で書き換えたファイルでも、どこが違うかわかる言葉で断る。 */
function parsePart(raw: unknown, n: number): SashPart {
  if (!isObject(raw)) throw new Error(t('{n} 番目のリボン定義の形式が正しくありません', { n }));
  const version = raw['version'];
  if (version !== 'office2007' && version !== 'office2010') throw new Error(t('不明な形式です：{version}', { version: String(version) }));
  const x = raw['xml'];
  let xml: string;
  if (typeof x === 'string') xml = x;
  else if (Array.isArray(x) && x.every((l) => typeof l === 'string')) xml = x.join('\n');
  else throw new Error(t('{n} 番目のリボン定義の XML が文字列（または文字列の配列）ではありません', { n }));
  const imgs = raw['images'] ?? [];
  if (!Array.isArray(imgs)) throw new Error(t('{n} 番目のリボン定義の画像の一覧が配列ではありません', { n }));
  const images = imgs.map((i: unknown, k): SashImage => {
    if (!isObject(i) || typeof i['id'] !== 'string' || i['id'] === '' || typeof i['base64'] !== 'string') {
      throw new Error(t('{n} 番目のリボン定義の {k} 番目の画像の形式が正しくありません（id と base64 が必要です）', { n, k: k + 1 }));
    }
    const contentType = i['contentType'];
    if (contentType !== undefined && typeof contentType !== 'string') throw new Error(t('画像「{id}」の contentType が文字列ではありません', { id: i['id'] }));
    // contentType は省略できる。省略したら PNG とみなす（Sash が書き出す画像は PNG）
    return { id: i['id'], contentType: contentType || 'image/png', base64: i['base64'] };
  });
  return { version, xml: xml.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'), images };
}

export function partXml(p: SashPart): string {
  return p.xml.join('\n') + '\n';
}
