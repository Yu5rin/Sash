// 元に戻す・やり直し（丸ごとのスナップショット。設計書 §3.4）。DOM に触らない。
// 絵は 64×64 以下なので、差分ではなく 1 手ごとに前後の複製を持つ方が単純で、間違いが起きにくい。

export interface HistoryEntry<S> {
  label: string;
  before: S;
  after: S;
}

export interface HistoryLimits {
  /** 手数の上限。 */
  maxEntries: number;
  /** 合計バイト数の上限（古いものから捨てる）。 */
  maxBytes: number;
}

export const DEFAULT_LIMITS: HistoryLimits = { maxEntries: 300, maxBytes: 32 * 1024 * 1024 };

export class History<S> {
  private done: { entry: HistoryEntry<S>; bytes: number }[] = [];
  private undone: { entry: HistoryEntry<S>; bytes: number }[] = [];
  private total = 0;

  constructor(private readonly sizeOf: (s: S) => number, private readonly limits: HistoryLimits = DEFAULT_LIMITS) {}

  /** 1 手積む。やり直しの列は消える。上限を超えた古い手は捨てる（直前の 1 手は、大きくても必ず残す）。 */
  push(entry: HistoryEntry<S>): void {
    this.undone = [];
    const bytes = this.sizeOf(entry.before) + this.sizeOf(entry.after);
    this.done.push({ entry, bytes });
    this.total += bytes;
    while (this.done.length > 1 && (this.done.length > this.limits.maxEntries || this.total > this.limits.maxBytes)) {
      this.total -= this.done.shift()!.bytes;
    }
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get count(): number {
    return this.done.length;
  }

  get bytes(): number {
    return this.total;
  }

  /** 1 手戻す。戻した手を返す（呼び出し側が before を絵に入れる）。 */
  undo(): HistoryEntry<S> | null {
    const e = this.done.pop();
    if (!e) return null;
    this.total -= e.bytes;
    this.undone.push(e);
    return e.entry;
  }

  redo(): HistoryEntry<S> | null {
    const e = this.undone.pop();
    if (!e) return null;
    this.done.push(e);
    this.total += e.bytes;
    return e.entry;
  }

  /** いちばん新しい手（連続した操作を 1 手にまとめるときに使う）。 */
  get last(): HistoryEntry<S> | null {
    return this.done.at(-1)?.entry ?? null;
  }

  /** いちばん新しい手の「後」を差し替える（矢印キーでの連続した移動を 1 手にまとめる）。 */
  amendLast(after: S): void {
    const e = this.done.at(-1);
    if (!e) return;
    const bytes = this.sizeOf(e.entry.before) + this.sizeOf(after);
    this.total += bytes - e.bytes;
    e.bytes = bytes;
    e.entry = { ...e.entry, after };
  }

  /** 次に戻す手の名前（読み上げ・ツールチップ用）。 */
  get undoLabel(): string | null {
    return this.done.at(-1)?.entry.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone.at(-1)?.entry.label ?? null;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.total = 0;
  }
}
