// アイコン集（Fluent UI System Icons・Tabler Icons・Lucide・Sash のオリジナル）のデータの扱い。SVG の組み立てとデータの読み込みだけを持つ純粋な処理にして、テストできるようにする。
// 名前は Fluent 時代のまま（FluentIcon など）だが、Tabler も同じ型で持つ（set で出どころを区別する）。これまでの import を壊さないため。
// データ（fluentIcons.json 2.6MB、tablerIcons.json 1.7MB）は大きいので、最初の画面の読み込みに含めないよう、使うときに動的 import で読む。
// データの作り方は scripts/build-fluent-icons.mjs・scripts/build-tabler-icons.mjs、ライセンス文は LICENSE-*.txt。
// 検索は iconSearch.ts（概念の辞書は iconConcepts.ts、カテゴリは iconCategories.ts）。

import { ICON_COUNTS } from './iconCounts';

export type FluentVariant = 'regular' | 'filled';

/** 1つのアイコンのパス。パスが複数あるときは配列（1本につなぐと重なった部分の塗りが変わりうるため、分けたまま持つ）。0 はその種類がない。 */
export type PathData = string | readonly string[] | 0;

export interface FluentData {
  source: string;
  version: string;
  license: string;
  /** 名前 → [regular, filled] か [regular, filled, 元のサイズ]（24 以外のときだけ）。 */
  icons: Readonly<Record<string, readonly [PathData, PathData] | readonly [PathData, PathData, number]>>;
}

/** アイコンの出どころ。 */
export type IconSet = 'fluent' | 'tabler' | 'lucide' | 'sash';

/** 出どころの表示名（固有名詞なので訳さない）。Sash はこのアプリのオリジナル。 */
export function setLabel(set: IconSet): string {
  return set === 'tabler' ? 'Tabler' : set === 'lucide' ? 'Lucide' : set === 'sash' ? 'Sash' : 'Fluent';
}

/** 元画像のファイル名に付ける出どころ。同じ名前（home など）が複数の集にあるので、Fluent 以外には付ける。 */
export function setFilePrefix(set: IconSet): string {
  return set === 'fluent' ? '' : `${set}-`;
}

/** 線（stroke）で描くアイコン集か。Tabler・Lucide・Sash は同じ作り（24×24・線幅 2・丸い端の線）で、Fluent だけが塗りのパス。 */
export function isStrokeSet(set: IconSet): boolean {
  return set !== 'fluent';
}

export interface FluentIcon {
  /** パッケージでの名前（Fluent は arrow_clockwise、Tabler は arrow-up-circle のように、区切りが違う）。 */
  name: string;
  /** 名前を単語に分けたもの（検索用）。 */
  words: readonly string[];
  /**
   * 線のアイコン。Fluent は塗りのパス、Tabler は線（stroke）のパス。
   * Tabler のパスの先頭の '#' は「塗りと線の両方」、'@' は「塗りだけ」の印（組み立てるのは buildSvg）。
   */
  regular: PathData;
  /** 塗りのアイコン。 */
  filled: PathData;
  /** viewBox の大きさ。ほとんどは 24、24 がないものだけ 20。 */
  size: number;
  /** 出どころ。省略したら Fluent（Fluent だけだった頃のデータや、テストで作るアイコンのため）。 */
  set?: IconSet;
  /** 検索に使う言葉（Tabler にだけある）。 */
  tags?: readonly string[];
  /** 元のカテゴリ名（Tabler にだけある。例：Animals）。 */
  tablerCategory?: string;
}

/** Tabler のデータ（tablerIcons.json）。Lucide・Sash のデータ（lucideIcons.json・sashIcons.json）も同じ形。 */
export interface TablerData {
  source: string;
  version: string;
  license: string;
  categories: readonly string[];
  /** 名前 → [カテゴリ番号, タグ（空白区切り）, 線のパス, 塗りのパス]。 */
  icons: Readonly<Record<string, readonly [number, string, PathData, PathData]>>;
}

/** リボン（Excel の明るいリボン）に置いて見やすい既定の色。画面のテーマの文字色を使うと、暗いテーマで白いアイコンができてしまうため固定にする。 */
export const DEFAULT_COLOR = '#424242';

export function toIcons(data: FluentData): FluentIcon[] {
  return Object.entries(data.icons).map(([name, e]) => ({ name, words: name.split('_'), regular: e[0], filled: e[1], size: e[2] ?? 24, set: 'fluent' as const }));
}

/** Tabler（と同じ形の Lucide・Sash）のデータをアイコンにする。タグは検索の手がかりとして、空白で分けて持つ。 */
export function toTablerIcons(data: TablerData, set: Exclude<IconSet, 'fluent'> = 'tabler'): FluentIcon[] {
  return Object.entries(data.icons).map(([name, e]) => ({
    name,
    words: name.split('-'),
    regular: e[2],
    filled: e[3],
    size: 24,
    set,
    tags: e[1] ? e[1].split(' ') : [],
    tablerCategory: data.categories[e[0]] ?? '',
  }));
}

/** 表示用の名前（単語をスペースで区切る）。Fluent は _、Tabler は - で区切ってある。 */
export function displayName(name: string): string {
  return name.replace(/[_-]/g, ' ');
}

/** アイコンの出どころ（省略されていたら Fluent）。 */
export function iconSet(icon: Pick<FluentIcon, 'set'>): IconSet {
  return icon.set ?? 'fluent';
}

/** 出どころを含めた一意の名前。同じ名前（例：home）が両方にあるので、選択の記憶やファイル名にはこちらを使う。 */
export function iconKey(icon: Pick<FluentIcon, 'name' | 'set'>): string {
  return `${iconSet(icon)}:${icon.name}`;
}

export function hasVariant(icon: FluentIcon, variant: FluentVariant): boolean {
  return icon[variant] !== 0;
}

/** #rrggbb だけを通す（SVG の属性に入れるので、それ以外の文字列は既定の色にする）。 */
export function safeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : DEFAULT_COLOR;
}

/** 塗りに使うパスの文字だけを通す（SVG の属性に入れるので、それ以外の文字列は使わない）。 */
const PATH_CHARS = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/;

/** 色の指定。#rrggbb か、画面の文字色に合わせる currentColor だけを通す（一覧を暗いテーマでも見えるように描くため）。 */
function paintOf(color: string): string {
  return color === 'currentColor' ? color : safeColor(color);
}

/**
 * パスのデータから SVG の文字列を組み立てる。px を渡すと width / height を付ける（省略時は元のサイズ）。
 * その種類がないときは null。color は #rrggbb（それ以外は既定の色にする）。画面に直接置く一覧では 'currentColor' も使える。
 *
 * Fluent は塗りのパス。Tabler の「線」は stroke-width 2・丸い端の線で描くので、色は stroke に入れる
 * （fill に入れると輪郭が塗りつぶされてしまう）。Tabler の「塗り」は塗りのパス。
 */
export function buildSvg(icon: FluentIcon, variant: FluentVariant, color: string, px?: number): string | null {
  const data = icon[variant];
  if (data === 0) return null;
  const list = typeof data === 'string' ? [data] : data;
  const paint = paintOf(color);
  const s = px ?? icon.size;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${icon.size} ${icon.size}"`;
  if (isStrokeSet(iconSet(icon)) && variant === 'regular') {
    const parts: string[] = [];
    for (const raw of list) {
      const mark = raw.startsWith('#') || raw.startsWith('@') ? raw[0] : '';
      const d = mark ? raw.slice(1) : raw;
      if (!PATH_CHARS.test(d)) continue;
      // 線だけ → 色は継承（root の stroke）。'#' は塗りと線、'@' は塗りだけ（線なし）
      if (mark === '#') parts.push(`<path d="${d}" fill="${paint}"/>`);
      else if (mark === '@') parts.push(`<path d="${d}" fill="${paint}" stroke="none"/>`);
      else parts.push(`<path d="${d}"/>`);
    }
    if (parts.length === 0) return null;
    return `${head} fill="none" stroke="${paint}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${parts.join('')}</svg>`;
  }
  const paths = list.filter((d) => PATH_CHARS.test(d));
  if (paths.length === 0) return null;
  return `${head} fill="${paint}">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

// ---- 検索 ----
// 日本語の語の扱い（normalize・JA_KEYWORDS・jaToEnglish・jaTermsInText）は iconWords.ts。これまでの import が動くよう、ここからも出す。
export { JA_KEYWORDS, jaToEnglish, jaTermsInText, normalize } from './iconWords';
// 検索（概念による絞り込み）は iconSearch.ts。ここから再び出すと、fluent.ts を読むだけで概念の辞書（約 100KB）が
// 最初の読み込みに入ってしまうので、出さない（検索を使う側が iconSearch.ts を動的 import で読む）。

export interface IconSetData {
  icons: FluentIcon[];
  /** Fluent のパッケージの版。 */
  version: string;
  /** Tabler のパッケージの版。 */
  tablerVersion: string;
  /** Lucide のパッケージの版。 */
  lucideVersion: string;
}

let cache: Promise<{ icons: FluentIcon[]; version: string }> | null = null;
let setCache: Promise<IconSetData> | null = null;

/** Fluent のデータだけを読み込む（初回だけ。失敗したら次にもう一度読み込めるよう、覚えておかない）。 */
export function loadFluentIcons(): Promise<{ icons: FluentIcon[]; version: string }> {
  cache ??= import('./fluentIcons.json')
    .then((m) => {
      const data = (m as unknown as { default: FluentData }).default;
      return { icons: toIcons(data), version: data.version };
    })
    .catch((e: unknown) => {
      cache = null;
      throw e;
    });
  return cache;
}

/**
 * Fluent・Tabler・Lucide・Sash のオリジナルを合わせたアイコン集を読み込む（初回だけ）。ピッカーを開いたときと、ラベルから候補を出すときにだけ呼ぶ
 * （データは合わせて 4.3MB ほどあるので、起動時の読み込みに含めない。Lucide と Sash は小さいが、別のチャンクにして並べて読む）。
 */
export function loadIconSet(): Promise<IconSetData> {
  setCache ??= Promise.all([loadFluentIcons(), import('./tablerIcons.json'), import('./lucideIcons.json'), import('./sashIcons.json')])
    .then(([fluent, tabler, lucide, sash]) => {
      const t = (tabler as unknown as { default: TablerData }).default;
      const l = (lucide as unknown as { default: TablerData }).default;
      const s = (sash as unknown as { default: TablerData }).default;
      return {
        icons: [...fluent.icons, ...toTablerIcons(t), ...toTablerIcons(l, 'lucide'), ...toTablerIcons(s, 'sash')],
        version: fluent.version,
        tablerVersion: t.version,
        lucideVersion: l.version,
      };
    })
    .catch((e: unknown) => {
      setCache = null;
      throw e;
    });
  return setCache;
}

/** 同梱のアイコン集の名前（ツールチップ用）。 */
export const ICON_SET_NAMES = 'Fluent・Tabler・Lucide・Sash';

/** 同梱のアイコンのおよその個数（100 個単位に丸める。例：8,200）。個数は iconCounts.ts（データから数えたもの）から作る。 */
export function approxIconCount(): string {
  const total = Object.values(ICON_COUNTS).reduce((a, b) => a + b, 0);
  return (Math.round(total / 100) * 100).toLocaleString('en-US');
}
