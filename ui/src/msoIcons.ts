// imageMso の画像。ホスト経由で取得し、メモリに持つ（仕様書 §9.1、§17.7）。
// Office のアイコンは Microsoft の著作物なので Sash には同梱しない。利用者の PC の Excel から一度だけ取り込み、
// その PC のキャッシュ（%AppData%\Sash\cache\imageMso）から出す。取り込み済みなら Excel がなくても表示できる。

import { invoke, onHostEvent, type IconPrefetchStatus } from './bridge';
import { imageMsoNames } from './catalog/catalog';
import { lang, t } from './i18n';
import { toast, type ToastHandle, type ToastOptions } from './shell/toast';

const cache = new Map<string, string | null>();
/**
 * 取得できなかった名前と、その時刻。ホストは「存在しない」名前だけを null で返し、
 * Excel が忙しいなど一時的に取れなかった名前は結果に含めない。含まれない名前を「存在しない」と
 * 扱うと、実在する imageMso に警告が出てしまうので、しばらく置いてから取り直す。
 */
const failed = new Map<string, number>();
const RETRY_MS = 60_000;
const queue = new Set<string>();
const listeners = new Set<() => void>();
let enabled = false;
let timer: number | undefined;

export function enableMsoIcons(on: boolean): void {
  enabled = on;
}

export function msoIconsEnabled(): boolean {
  return enabled;
}

export function onMsoIconsLoaded(listener: () => void): void {
  listeners.add(listener);
}

function notifyLoaded(): void {
  for (const l of listeners) l();
}

/** 画像の data URL を返す。まだなければ取得を予約して undefined を返す。存在しなければ null。 */
export function msoIcon(name: string): string | null | undefined {
  if (!enabled || !name) return null;
  if (cache.has(name)) return cache.get(name);
  const at = failed.get(name);
  if (at !== undefined && Date.now() - at < RETRY_MS) return null;
  queue.add(name);
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 30);
  return undefined;
}

/** Excel で存在しないと確認できた imageMso。 */
export function missingImageMso(): Set<string> {
  return new Set([...cache].filter(([, v]) => v === null).map(([k]) => k));
}

/**
 * 覚えている画像と「取れなかった」記録を捨てて、描き直させる。取り込みが終わったときに呼ぶ
 * （取り込み前に取れなかった名前も、キャッシュからすぐ出せるようになるため）。
 */
export function refreshMsoIcons(): void {
  cache.clear();
  failed.clear();
  notifyLoaded();
}

async function flush(): Promise<void> {
  const names = [...queue].filter((n) => !cache.has(n));
  queue.clear();
  if (names.length === 0) return;
  for (const n of names) cache.set(n, undefined as unknown as null);
  try {
    const res = await invoke('excel.imageMso', { names, size: 32 });
    for (const n of names) {
      const v = res[n];
      if (typeof v === 'string' && v) {
        cache.set(n, `data:image/png;base64,${v}`);
        failed.delete(n);
      } else if (v === null) {
        // ホストが「存在しない」と判定した名前だけを null として覚える
        cache.set(n, null);
        failed.delete(n);
      } else {
        cache.delete(n);
        failed.set(n, Date.now());
      }
    }
  } catch {
    for (const n of names) {
      cache.delete(n);
      failed.set(n, Date.now());
    }
    return;
  }
  notifyLoaded();
}

// ---- 一括の取り込み ----

let status: IconPrefetchStatus | null = null;
const statusListeners = new Set<(s: IconPrefetchStatus) => void>();
let progressToast: ToastHandle | null = null;
/** 進み具合の通知の要素。利用者が × で閉じたら、取り込みが続いていても出し直さない。 */
let progressEl: Element | null = null;
let cancelling = false;
/**
 * 進み具合の通知を最後に書き換えた時刻と、まだ出していない最新の状態。
 * まとまりごとに知らせが来るたびに書き換えると、読み上げが追いつかず「中止」も押しにくくなるので、500ms に 1 回までにする。
 */
const PROGRESS_INTERVAL_MS = 500;
let progressShownAt = 0;
let progressPending: IconPrefetchStatus | null = null;
let progressTimer: number | undefined;

/** 利用者が取り込みを中止したことを覚えておく（次の起動で勝手に始めないため）。 */
const DECLINED_KEY = 'sash.msoPrefetch.declined';

function declined(): boolean {
  try {
    return localStorage.getItem(DECLINED_KEY) === '1';
  } catch {
    return false;
  }
}

function setDeclined(on: boolean): void {
  try {
    if (on) localStorage.setItem(DECLINED_KEY, '1');
    else localStorage.removeItem(DECLINED_KEY);
  } catch {
    // 保存できなくても、次の起動でもう一度始めるだけ
  }
}

/** 最後に分かった取り込みの状態。まだ問い合わせていなければ null。 */
export function prefetchStatus(): IconPrefetchStatus | null {
  return status;
}

/** 状態が変わるたびに呼ぶ。戻り値で登録を外す。 */
export function onPrefetchStatus(listener: (s: IconPrefetchStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** アイコンを出せるか。Excel があるか、前に取り込んだキャッシュがあれば出せる。 */
export function shouldEnableMsoIcons(excelInstalled: boolean, s: IconPrefetchStatus | null): boolean {
  return excelInstalled || (s?.cached ?? 0) > 0 || s?.state === 'done';
}

/**
 * 起動時に自動で取り込みを始めるか。Excel があり、まだ取り込んでおらず、利用者が中止していないときだけ。
 * failed（前の起動で失敗し、Excel の版も変わっていない。ホストがファイルに記録している）は、中止したときと同じく始めない。
 * 始めると起動のたびに見えない Excel を起動して、同じ理由で失敗してエラーを出し続けるため。設定画面からは始められる。
 */
export function shouldAutoPrefetch(excelInstalled: boolean, s: IconPrefetchStatus | null, wasDeclined: boolean): boolean {
  return excelInstalled && s?.state === 'none' && !wasDeclined;
}

function setStatus(next: IconPrefetchStatus): void {
  const prev = status;
  status = next;
  for (const l of statusListeners) l(next);
  if (prev?.state === 'running' && next.state !== 'running') finished(next);
  else if (next.state === 'running' && !cancelling) showProgress(next);
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function progressOptions(s: IconPrefetchStatus): ToastOptions {
  return {
    kind: 'info',
    message: s.total > 0
      ? t('Excel のアイコンを取り込んでいます… {done} / {total}', { done: formatCount(s.done), total: formatCount(s.total) })
      : t('Excel のアイコンを取り込む準備をしています…'),
    timeout: 0,
    action: { label: t('中止'), run: () => void cancelMsoPrefetch() },
  };
}

function showProgress(s: IconPrefetchStatus): void {
  if (progressToast) {
    // 利用者が閉じた通知は出し直さない（編集の邪魔をしないため）。設定の「アイコン」で進み具合を見られる
    if (progressEl && !progressEl.isConnected) return;
    const wait = progressShownAt + PROGRESS_INTERVAL_MS - Date.now();
    if (wait > 0) {
      // 間引いた分は最後の状態だけを、間隔が空いたところで出す（最後の件数が出ないままにならないように）
      progressPending = s;
      if (progressTimer === undefined) {
        progressTimer = window.setTimeout(() => {
          progressTimer = undefined;
          const next = progressPending;
          progressPending = null;
          if (next && progressToast && status?.state === 'running' && !cancelling) showProgress(next);
        }, wait);
      }
      return;
    }
    progressShownAt = Date.now();
    progressToast.update(progressOptions(s));
    return;
  }
  progressShownAt = Date.now();
  progressToast = toast(progressOptions(s));
  progressEl = document.getElementById('toasts')?.lastElementChild ?? null;
}

function closeProgress(): void {
  if (progressEl?.isConnected) progressToast?.close();
  progressToast = null;
  progressEl = null;
  window.clearTimeout(progressTimer);
  progressTimer = undefined;
  progressPending = null;
}

function finished(s: IconPrefetchStatus): void {
  closeProgress();
  const wasCancelling = cancelling;
  cancelling = false;
  // 取り込めた分はキャッシュから出せるので、取れなかった名前も含めて描き直す
  enableMsoIcons(enabled || shouldEnableMsoIcons(s.excelInstalled ?? false, s));
  refreshMsoIcons();
  // 中止を先に見る。取り込み直しを中止すると、前の記録が残っているので state は done になる。
  // done を先に見ると、中止したのに「取り込みました」と出てしまう
  if (wasCancelling || s.cancelled) {
    toast({ kind: 'info', message: t('アイコンの取り込みを中止しました。設定の「アイコン」からいつでも取り込めます。') });
  } else if (s.state === 'done') {
    toast({ kind: 'success', message: t('Excel のアイコンを取り込みました（{n} 件）', { n: formatCount(s.cached) }) });
  } else if (s.state === 'failed') {
    toast({ kind: 'error', message: s.message || t('Excel のアイコンを取り込めませんでした') });
  }
  // 日時や Excel の版は進み具合の知らせに入っていないので、取り直して画面に出す
  void invoke('icons.prefetchStatus').then((full) => {
    if (full.state !== 'running') {
      status = full;
      for (const l of statusListeners) l(full);
    }
  }).catch(() => undefined);
}

let listening = false;

/**
 * ホストからの進み具合の知らせを受け始める。モジュールの読み込み時ではなく、取り込みの状態に初めて触れたときに登録する
 * （ホストとのやり取りを差し替えたテストで、このモジュールを読み込むだけの場合に影響しないように）。
 */
function listen(): void {
  if (listening) return;
  listening = true;
  onHostEvent((e) => {
    if (e.event !== 'iconPrefetch') return;
    const { event: _event, ...rest } = e;
    setStatus({ ...(status ?? { cached: 0, size: 32 }), ...rest, cached: rest.cached ?? status?.cached ?? 0, size: rest.size ?? status?.size ?? 32 });
  });
}

/** 取り込みの状態をホストに問い合わせる。失敗したら null。 */
export async function loadPrefetchStatus(): Promise<IconPrefetchStatus | null> {
  listen();
  try {
    const s = await invoke('icons.prefetchStatus');
    setStatus(s);
    return s;
  } catch {
    return null;
  }
}

/** 取り込みを始める。force なら取り込み済みの名前も Excel から取り直す（設定の「取り込み直す」）。 */
export async function startMsoPrefetch(force: boolean): Promise<void> {
  listen();
  setDeclined(false);
  cancelling = false;
  try {
    // 表示に使うのは 32px だけ（小さいボタンも 32px を縮めて描く）なので、32px だけを取り込む
    const s = await invoke('icons.prefetchStart', { names: imageMsoNames(), sizes: [32], force });
    // 始めた直後の状態。以後は iconPrefetch の知らせで進む
    if (s.state === 'running' || status?.state !== 'running') setStatus(s);
  } catch (e) {
    toast({ kind: 'error', message: t('Excel のアイコンを取り込めませんでした：{message}', { message: (e as Error).message }) });
  }
}

/** 実行中の取り込みを止める。次の起動では自動で始めない。 */
export async function cancelMsoPrefetch(): Promise<void> {
  cancelling = true;
  setDeclined(true);
  closeProgress();
  try {
    const s = await invoke('icons.prefetchCancel');
    if (s.state !== 'running') setStatus(s);
  } catch {
    cancelling = false;
  }
}

/**
 * 起動時の準備。キャッシュがあれば Excel がなくてもアイコンを出し、初めての起動なら取り込みを裏で始める。
 * 起動の画面を待たせないよう、取り込みは少し遅らせて始める。
 */
export async function initMsoIcons(excelInstalled: boolean, autoStartDelay = 1500): Promise<void> {
  enableMsoIcons(excelInstalled);
  const s = await loadPrefetchStatus();
  if (!enabled && shouldEnableMsoIcons(excelInstalled, s)) {
    enableMsoIcons(true);
    notifyLoaded();
  }
  if (shouldAutoPrefetch(excelInstalled, s, declined())) {
    window.setTimeout(() => {
      if (status?.state === 'none') void startMsoPrefetch(false);
    }, autoStartDelay);
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang === 'en' ? 'en-US' : 'ja-JP');
}

/** 取り込みの状態を 1 行の文にする（設定画面とカタログで使う）。 */
export function describePrefetch(s: IconPrefetchStatus): string {
  switch (s.state) {
    case 'running':
      return s.total > 0
        ? t('取り込んでいます… {done} / {total}', { done: formatCount(s.done), total: formatCount(s.total) })
        : t('取り込みを始めています…');
    case 'done':
      return s.excelVersion
        ? t('取り込み済み：{n} 件（Excel {version}・{date}）', { n: formatCount(s.cached), version: s.excelVersion, date: formatDate(s.cachedAt) })
        : t('取り込み済み：{n} 件（{date}）', { n: formatCount(s.cached), date: formatDate(s.cachedAt) });
    case 'failed':
      return t('取り込めませんでした：{message}', { message: s.message || t('不明なエラー') });
    case 'unavailable':
      return t('Excel が見つからないため、取り込めません');
    default:
      return s.cached > 0 ? t('一部だけ取り込み済み：{n} 件', { n: formatCount(s.cached) }) : t('まだ取り込んでいません');
  }
}
