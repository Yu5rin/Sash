// 未保存の編集の自動退避と復旧（仕様書 §23.2）。
// 編集中の XML と、足した・変えた画像（保存済みからの差分）を、変更のあと数秒おいて（まとめて）ホストへ送り、
// %AppData%\Sash\recovery に書いてもらう。保存したら・閉じたら消す。退避が残っていれば、次に同じブックを開いたときに復旧を選べる。
// 退避は保険なので、失敗しても編集は止めない（ログに残し、続けて失敗するときだけ 1 度だけ知らせる）。

import { app, type Session } from './app';
import { invoke, type CustomUIVersion, type RecoveryEntryDto, type RecoveryPartDto } from './bridge';
import { t } from './i18n';
import { isSampleSession } from './sample';
import { toast } from './shell/toast';
import type { Change, ImageEntry, PartStore } from './store';

/** 最後の変更から、これだけ待ってから書く（入力のたびに書かない）。 */
export const RECOVERY_DELAY_MS = 3000;
/** 続けて編集していても、最後に書いてからこれだけたてば書く（落ちたときに失う長さの上限）。 */
export const RECOVERY_MAX_WAIT_MS = 15000;

export interface DebouncerOptions {
  delay: number;
  maxWait: number;
  /** 時計。テストで差し替える。 */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

/**
 * 最後の呼び出しから delay たったら run を呼ぶ。呼び出しが続いても、最初の呼び出しから maxWait たったら呼ぶ（間引き）。
 * cancel で予約を取り消す。
 */
export function createDebouncer(run: () => void, opts: DebouncerOptions): { trigger(): void; cancel(): void; pending(): boolean } {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
  let timer: number | null = null;
  let firstAt = 0;
  const fire = () => {
    timer = null;
    run();
  };
  return {
    trigger() {
      const t0 = now();
      if (timer === null) firstAt = t0;
      else clearTimer(timer);
      timer = setTimer(fire, Math.max(0, Math.min(opts.delay, firstAt + opts.maxWait - t0)));
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    pending: () => timer !== null,
  };
}

/** 退避する内容。保存していないパーツだけを、保存のときに書き込む形（XML と、画像の差分）で持つ。保存するものがなければ null。 */
export function recoveryPayload(session: Session): { editCount: number; parts: RecoveryPartDto[] } | null {
  const parts: RecoveryPartDto[] = [];
  let editCount = 0;
  for (const p of session.parts.values()) {
    editCount += p.history().index;
    if (!p.dirty) continue;
    const ch = p.pendingImageChanges();
    parts.push({ version: p.version, xml: p.text, addImages: ch.add.map((i) => ({ id: i.id, dataUrl: i.dataUrl })), removeImages: ch.remove });
  }
  return parts.length === 0 ? null : { editCount, parts };
}

// ---- ホストとのやりとり（書く・消すの順番を守る） ----

let queue: Promise<unknown> = Promise.resolve();
let failures = 0;
let warned = false;

/** 書く・消すを、投げた順に 1 つずつ行う（消したあとに古い書き込みが追い越して退避が残らないように）。失敗は例外にしない。 */
function enqueue(job: () => Promise<unknown>): Promise<void> {
  const next = queue.then(job).then(() => undefined, () => undefined);
  queue = next;
  return next;
}

function reportFailure(e: unknown): void {
  failures++;
  void invoke('app.log', { level: 'warning', message: `退避に失敗しました：${(e as Error)?.message ?? String(e)}` }).catch(() => undefined);
  // 続けて失敗するときだけ、1 度だけ知らせる（編集は止めない。保存はこれまでどおりできる）
  if (failures >= 3 && !warned) {
    warned = true;
    toast({ kind: 'warning', message: t('未保存の編集を自動で退避できていません。編集は続けられますが、こまめに保存してください') });
  }
}

/** 前回ホストへ送れた（書けた）内容。変わっていなければ書かない。比べるのは文字列の同一性だけで、全体を直列化しない。 */
let lastPayload: { path: string; editCount: number; parts: RecoveryPartDto[] } | null = null;
/** ホストに退避済みの画像（パーツ・id → 中身）。次からは、これと違うものだけを送る。 */
let sentImages = new Map<string, string>();

function resetSent(): void {
  lastPayload = null;
  sentImages = new Map();
}

/** 前回と同じ内容か（XML・消す画像・足す画像の id と中身。編集の回数も）。 */
export function samePayload(a: { path: string; editCount: number; parts: RecoveryPartDto[] } | null, b: { path: string; editCount: number; parts: RecoveryPartDto[] }): boolean {
  if (!a || a.path !== b.path || a.editCount !== b.editCount || a.parts.length !== b.parts.length) return false;
  return a.parts.every((p, i) => {
    const q = b.parts[i]!;
    return p.version === q.version && p.xml === q.xml
      && p.removeImages.length === q.removeImages.length && p.removeImages.every((id, j) => id === q.removeImages[j])
      && p.addImages.length === q.addImages.length && p.addImages.every((im, j) => im.id === q.addImages[j]!.id && im.dataUrl === q.addImages[j]!.dataUrl);
  });
}

/**
 * ホストへ送る形にする。画像は、前回までに送ったものと違う（足した・差し替えた）ものだけを addImages に入れ、
 * いま足している画像の id の全部を addImageIds に入れる（残りは、ホストが前回の退避から引き継ぐ）。
 */
export function toWire(parts: RecoveryPartDto[], sent: ReadonlyMap<string, string>): (RecoveryPartDto & { addImageIds: string[] })[] {
  return parts.map((p) => ({
    ...p,
    addImages: p.addImages.filter((i) => sent.get(`${p.version}:${i.id}`) !== i.dataUrl),
    addImageIds: p.addImages.map((i) => i.id),
  }));
}

async function writeNow(session: Session): Promise<void> {
  if (!app.settings.autoRecovery || !session.path || isSampleSession()) return;
  const payload = recoveryPayload(session);
  if (!payload) {
    await discardRecovery(session.path);
    return;
  }
  const body = { path: session.path, ...payload };
  if (samePayload(lastPayload, body)) return;
  await enqueue(async () => {
    // 待っている間に別のファイルへ替わっていたら、書かない
    if (app.session !== session) return;
    try {
      await invoke('recovery.write', { ...body, parts: toWire(body.parts, sentImages) });
      lastPayload = body;
      sentImages = new Map(body.parts.flatMap((p) => p.addImages.map((i): [string, string] => [`${p.version}:${i.id}`, i.dataUrl])));
      failures = 0;
    } catch (e) {
      // 書けたかが分からないので、次は画像も全部送り直す
      resetSent();
      reportFailure(e);
      // ホストが前回の退避から画像を引き継げなかったときなど、全部送り直せば書ける。続けて失敗しているときは、次の編集まで待つ
      if (failures < 3) debouncer.trigger();
    }
  });
}

/** 退避を読む（書く・消すと同じ待ち行列を通す。開き直した直後に、捨てたはずの退避を読まないように）。読めなければ null。 */
export function readRecovery(path: string): Promise<RecoveryEntryDto | null> {
  return new Promise((resolve) => {
    void enqueue(async () => {
      try {
        resolve(await invoke('recovery.read', { path }));
      } catch {
        resolve(null);
      }
    });
  });
}

/** そのブックの退避を消す。失敗は黙る。 */
export function discardRecovery(path: string): Promise<void> {
  if (!path) return Promise.resolve();
  resetSent();
  return enqueue(() => invoke('recovery.delete', { path }));
}

// ---- 変更を見て、書く・消す ----

let tracked: Session | null = null;
const debouncer = createDebouncer(() => {
  const s = app.session;
  if (s && s === tracked) void writeNow(s);
}, { delay: RECOVERY_DELAY_MS, maxWait: RECOVERY_MAX_WAIT_MS });

let started = false;

/** 退避を始める（起動時に 1 度だけ呼ぶ。2 度目以降は何もしない）。 */
export function startRecovery(): void {
  if (started) return;
  started = true;
  app.on('store', (c?: Change) => {
    const s = app.session;
    if (!c || !s || s !== tracked || !s.path) return;
    // 選択だけの変更では書かない
    if (!c.kinds.has('doc') && !c.kinds.has('images') && !c.kinds.has('saved')) return;
    if (!app.dirty) {
      // 保存した・元に戻して保存済みと同じになった。退避は要らない
      debouncer.cancel();
      void discardRecovery(s.path);
      return;
    }
    debouncer.trigger();
  });
  app.on('session', () => {
    const next = app.session;
    if (next === tracked) return;
    // ファイルを閉じた・別のファイルへ替わった（未保存の確認を通ってきているので、残す編集はない）。前のブックの退避を消す
    const previous = tracked;
    tracked = next;
    debouncer.cancel();
    resetSent();
    if (previous?.path) void discardRecovery(previous.path);
  });
}

/**
 * 開いているブックの退避を消す。書く予約も取り消す（消したあとに、予約が退避を書き直さないように）。
 * 「保存しない」「破棄する」を選んで終わる・読み込み直すときに呼ぶ。
 */
export function discardCurrentRecovery(): Promise<void> {
  debouncer.cancel();
  const path = app.session?.path;
  return path ? discardRecovery(path) : Promise.resolve();
}

/** 退避を、あらためて予約する（破棄を選んだが、やめて編集を続けることになったとき）。 */
export function rescheduleRecovery(): void {
  if (app.session && app.session === tracked && app.dirty) debouncer.trigger();
}

// ---- 復旧 ----

export interface RecoveryApplied {
  applied: CustomUIVersion[];
  /** 適用したパーツ（元に戻すで、すべてを戻すため）。 */
  stores: PartStore[];
  /** いまのファイルにないパーツ（ファイルの中身が変わっていた）。 */
  missing: CustomUIVersion[];
}

/** 退避の内容を、開いているファイルに適用する。1 回の「元に戻す」で、開いた直後に戻れる（パーツごとに 1 つの履歴にする）。 */
export function applyRecovery(entry: RecoveryEntryDto): RecoveryApplied {
  const s = app.session;
  const result: RecoveryApplied = { applied: [], stores: [], missing: [] };
  if (!s) return result;
  for (const part of entry.parts) {
    const store = s.parts.get(part.version);
    if (!store) {
      result.missing.push(part.version);
      continue;
    }
    const images = new Map<string, ImageEntry>(store.images);
    for (const id of part.removeImages) images.delete(id);
    for (const i of part.addImages) images.set(i.id, { id: i.id, dataUrl: i.dataUrl, isNew: true });
    store.replaceAll(part.xml, [...images.values()], t('未保存の編集の復旧'));
    result.applied.push(part.version);
    result.stores.push(store);
  }
  return result;
}

/** 退避の一覧（ホーム用）。ホストが古いものを掃除する。失敗したら空。 */
export async function listRecoveries() {
  try {
    return await invoke('recovery.list');
  } catch {
    return [];
  }
}
