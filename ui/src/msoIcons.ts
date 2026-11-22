// imageMso の画像。Excel がある環境ではホスト経由で GetImageMso から取得し、メモリに持つ。
// ホスト側でもディスクにキャッシュするので、2回目以降の起動では Excel を待たない。

import { invoke } from './bridge';

const cache = new Map<string, string | null>();
const queue = new Set<string>();
const listeners = new Set<() => void>();
let enabled = false;
let timer: number | undefined;

export function enableMsoIcons(excelInstalled: boolean): void {
  enabled = excelInstalled;
}

export function onMsoIconsLoaded(listener: () => void): void {
  listeners.add(listener);
}

/** 画像の data URL を返す。まだなければ取得を予約して undefined を返す。存在しなければ null。 */
export function msoIcon(name: string): string | null | undefined {
  if (!enabled || !name) return null;
  if (cache.has(name)) return cache.get(name);
  queue.add(name);
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 30);
  return undefined;
}

/** Excel で存在しないと確認できた imageMso。 */
export function missingImageMso(): Set<string> {
  return new Set([...cache].filter(([, v]) => v === null).map(([k]) => k));
}

async function flush(): Promise<void> {
  const names = [...queue].filter((n) => !cache.has(n));
  queue.clear();
  if (names.length === 0) return;
  for (const n of names) cache.set(n, undefined as unknown as null);
  try {
    const res = await invoke('excel.imageMso', { names, size: 32 });
    for (const n of names) cache.set(n, res[n] ? `data:image/png;base64,${res[n]}` : null);
  } catch {
    for (const n of names) cache.delete(n);
    return;
  }
  for (const l of listeners) l();
}
