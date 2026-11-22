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
  const f = data as Partial<SashFile>;
  if (f.format !== SASH_FORMAT) throw new Error(t('Sash のリボン定義ファイル（.sash.json）ではありません'));
  if (typeof f.formatVersion !== 'number' || f.formatVersion > SASH_FORMAT_VERSION) throw new Error(t('新しいバージョンの Sash で書き出されたファイルです。Sash を更新してください'));
  if (!Array.isArray(f.parts) || f.parts.length === 0) throw new Error(t('リボン定義が含まれていません'));
  return {
    format: SASH_FORMAT,
    formatVersion: f.formatVersion,
    source: f.source,
    parts: f.parts.map((p) => {
      if (p.version !== 'office2007' && p.version !== 'office2010') throw new Error(t('不明な形式です：{version}', { version: String(p.version) }));
      const xml = Array.isArray(p.xml) ? p.xml.join('\n') : String(p.xml ?? '');
      return { version: p.version, xml: xml.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'), images: (p.images ?? []).filter((i) => i && typeof i.id === 'string' && typeof i.base64 === 'string') };
    }),
  };
}

export function partXml(p: SashPart): string {
  return p.xml.join('\n') + '\n';
}
