// キャンバスの幅のプレビューの設定（仕様書 §5.2「幅のプレビュー」）。
// 選んだ画面の幅・拡大率・表示のしかたなどを覚えておく。リボンの定義には保存しない（見え方を試すためだけのもの）。
// 次に開いたときも同じ見え方で始められるよう、localStorage に置く（使えない環境ではこの画面の間だけ覚える）。

export type FitMode = 'fit' | 'actual';

export interface PreviewSettings {
  /** 画面の幅（px）。null は「自由」（キャンバスの幅いっぱいに描く、これまでの表示）。 */
  width: number | null;
  /** 「カスタム…」で入れた幅。 */
  customWidth: number;
  /** Windows の拡大率（%）。 */
  scale: number;
  /** 収める（縮小して枠に入れる）／等倍（横にスクロール）。 */
  fit: FitMode;
  /** 2つの幅を比べる。 */
  compare: boolean;
  /** 比べる側の画面の幅。 */
  compareWidth: number;
  /** キーヒントを重ねて表示する。 */
  keytips: boolean;
  /** キーヒントを書いていないコントロールにも「自動」を出す（既定はオフ。書いたものと VBA のもの・重なりだけを見せる）。 */
  keytipsAll: boolean;
}

const KEY = 'sash.preview';

const DEFAULTS: PreviewSettings = { width: null, customWidth: 1600, scale: 100, fit: 'fit', compare: false, compareWidth: 1366, keytips: false, keytipsAll: false };

function load(): PreviewSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<PreviewSettings>;
    const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 320 && x <= 10000 ? Math.round(x) : d);
    return {
      width: v.width === null || v.width === undefined ? null : num(v.width, 1920),
      customWidth: num(v.customWidth, DEFAULTS.customWidth),
      scale: v.scale === 125 || v.scale === 150 ? v.scale : 100,
      fit: v.fit === 'actual' ? 'actual' : 'fit',
      compare: v.compare === true,
      compareWidth: num(v.compareWidth, DEFAULTS.compareWidth),
      keytips: v.keytips === true,
      keytipsAll: v.keytipsAll === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let settings: PreviewSettings = load();

export function preview(): Readonly<PreviewSettings> {
  return settings;
}

export function setPreview(patch: Partial<PreviewSettings>): void {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 保存できない環境では、この画面の間だけ覚える
  }
}

// ---- 動的な状態（getVisible / getEnabled / getLabel）の試し表示 ----
// 保存しない。ファイルを開き直したら消す（別のファイルの id に効いてしまわないように）。

export interface DynamicOverride {
  visible?: boolean;
  enabled?: boolean;
  label?: string;
}

const overrides = new Map<string, DynamicOverride>();

/** 要素の試し表示の状態。キーは id（なければ「@パス」）。 */
export function overrideKey(el: Element, path: readonly number[]): string {
  return el.getAttribute('id') ?? `@${path.join('.')}`;
}

export function getOverride(key: string): DynamicOverride | undefined {
  return overrides.get(key);
}

export function setOverride(key: string, patch: DynamicOverride): void {
  const next = { ...overrides.get(key), ...patch };
  if (next.visible === undefined && next.enabled === undefined && next.label === undefined) overrides.delete(key);
  else overrides.set(key, next);
}

export function clearOverrides(): void {
  overrides.clear();
}

export function overrideCount(): number {
  return overrides.size;
}

/** 測った幅の控えの鍵に混ぜる（試し表示を変えたら測り直すため）。 */
export function overridesSignature(): string {
  return JSON.stringify([...overrides.entries()]);
}
