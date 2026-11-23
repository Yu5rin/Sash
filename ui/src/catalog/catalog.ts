// idMso / imageMso のカタログ（仕様書 §9.1）。
// コマンドの一覧は Microsoft の office-fluent-ui-command-identifiers（MIT）の Excel 分から作った。
// 日本語の表示名は、Excel がある環境で GetLabelMso から取得してキャッシュする。

import data from './excelControls.json';
import { invoke } from '../bridge';

export interface CatalogEntry {
  id: string;
  /** コントロールの種類（button、tab、group など）。 */
  type: string;
  /** 置かれているタブ（idMso）。リボンにないものは空。 */
  tab: string;
  /** 置かれているグループ（idMso）。 */
  group: string;
}

export const catalog: readonly CatalogEntry[] = (data as [string, string, string, string][]).map(([id, type, tab, group]) => ({ id, type, tab, group }));

export const knownIdMso: ReadonlySet<string> = new Set(catalog.map((c) => c.id));

/** 画像を持たない種類。タブ・タブの組・右クリックメニューそのものには imageMso がない。 */
const NO_IMAGE_TYPES: ReadonlySet<string> = new Set(['tab', 'tabSet', 'contextMenu']);

/**
 * Excel から一括で取り込む imageMso の名前（仕様書 §17.7）。imageMso の名前は idMso と同じものが多いので、
 * コマンドの一覧から画像を持ちうるものを選ぶ。グループは縮んだときにアイコンを出すので含める。
 * 一覧にない名前は、使われたときに個別に取りに行く。
 */
export function imageMsoNames(): string[] {
  return [...new Set(catalog.filter((c) => !NO_IMAGE_TYPES.has(c.type)).map((c) => c.id))];
}

const LABEL_CACHE_KEY = 'sash.catalog.labels';

/** idMso → Excel での表示名。 */
export const labels = new Map<string, string>(loadLabels());

function loadLabels(): [string, string][] {
  try {
    const raw = localStorage.getItem(LABEL_CACHE_KEY);
    return raw ? (Object.entries(JSON.parse(raw)) as [string, string][]) : [];
  } catch {
    return [];
  }
}

let labelsLoading: Promise<void> | null = null;

/** Excel から表示名を取得する。取得済みなら何もしない。 */
export function ensureLabels(excelInstalled: boolean): Promise<void> {
  if (!excelInstalled || labels.size > 0) return Promise.resolve();
  labelsLoading ??= invoke('excel.labels', { ids: catalog.map((c) => c.id) })
    .then((res) => {
      for (const [k, v] of Object.entries(res)) if (v) labels.set(k, v);
      try {
        localStorage.setItem(LABEL_CACHE_KEY, JSON.stringify(Object.fromEntries(labels)));
      } catch {
        // 保存できなくても次回また取得するだけ
      }
    })
    .catch(() => undefined);
  return labelsLoading;
}

/**
 * あいまい検索。部分一致を最優先し、次に文字が順番どおり含まれるもの（例：asum → AutoSum）を拾う。
 * 表示名（日本語）も検索対象にする。
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - t.length;
  if (idx > 0) return 800 - idx - t.length / 10;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(found - ti, 10);
    // 単語の先頭（大文字）に当たると加点
    if (/[A-Z]/.test(target[found] ?? '')) score += 8;
    ti = found + 1;
  }
  return Math.max(1, score - t.length / 5);
}

export function search(query: string, filter: (c: CatalogEntry) => boolean, limit = 300): CatalogEntry[] {
  const q = query.trim();
  const scored: { c: CatalogEntry; s: number }[] = [];
  for (const c of catalog) {
    if (!filter(c)) continue;
    const s = Math.max(fuzzyScore(q, c.id), fuzzyScore(q, labels.get(c.id) ?? '') * 0.95);
    if (s > 0) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
  return scored.slice(0, limit).map((x) => x.c);
}

// ---- 最近使ったもの・お気に入り ----

const RECENT_KEY = 'sash.catalog.recent';
const FAV_KEY = 'sash.catalog.favorites';

function readList(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // 保存できない環境では記録しない
  }
}

export const recent = {
  list: () => readList(RECENT_KEY),
  add(id: string) {
    writeList(RECENT_KEY, [id, ...readList(RECENT_KEY).filter((x) => x !== id)].slice(0, 30));
  },
};

export const favorites = {
  list: () => readList(FAV_KEY),
  has: (id: string) => readList(FAV_KEY).includes(id),
  toggle(id: string) {
    const list = readList(FAV_KEY);
    writeList(FAV_KEY, list.includes(id) ? list.filter((x) => x !== id) : [id, ...list]);
  },
};
