// リボンの幅の見積もり（仕様書 §5.2「幅のプレビュー」）。
// 画面の幅と Windows の拡大率から、Excel のリボンにグループがどこまで収まるか、どのグループが畳まれるかを見積もる。
// DOM には触れない純粋な計算と、キャンバスが測った結果（getFitReport）の受け渡しだけをここに置く。
// 実際の幅を測るのは canvas.ts（描いたグループの幅を DOM から読む）。
//
// 【目安であること】Excel の実際の縮め方は公開されていないため、次を仮定している（実機の Excel で確かめていない）。
//  - 縮める順は右のグループから。まず autoScale="true" のグループを large → small → ラベルなし の順に一段ずつ縮め、
//    それでも入らなければ、右のグループから一つずつ「グループ名のボタン（▼つき）」に畳む。
//  - リボンの右端には、表示オプションのボタンなどで RIBBON_RESERVED_PX ぶんの余白がある。
//  - 最大化したウィンドウの幅は画面の幅と同じ（枠は画面の外に出る）。

import { t } from '../i18n';

/** グループの状態。large は書いたとおり、collapsed はグループ名のボタン一つに畳んだ形。 */
export type GroupFitState = 'large' | 'small' | 'nolabel' | 'collapsed';

export interface FitGroupInput {
  id: string;
  /** 状態ごとの幅（CSS px）。縮めても変わらない状態は large と同じ値を入れる。 */
  widths: { large: number; small: number; nolabel: number; collapsed: number };
  /** autoScale="true"。false のグループは large のまま、足りなければ畳むだけ。 */
  autoScale: boolean;
}

export interface FitGroupResult {
  id: string;
  state: GroupFitState;
  /** 畳んでも入りきらず、右端からはみ出す。 */
  clipped: boolean;
  /** 左端からの位置と幅（CSS px）。 */
  left: number;
  width: number;
}

export interface FitResult {
  groups: FitGroupResult[];
  /** 使った幅の合計。 */
  used: number;
  /** すべて入った（はみ出すグループがない）。 */
  fits: boolean;
}

/**
 * リボンの本体のうち、グループを並べられない幅（CSS px）。
 * 本体の枠線と内側の余白（左右 5px ずつ）と、右端の「リボンの表示オプション」のボタンの分。
 * Microsoft 365 の画面写真からの見積もりで、実機では確かめていない。
 */
export const RIBBON_RESERVED_PX = 40;

/** よく使われる画面の幅（目盛りと選択肢に使う）。1536 は 1920 を 125% で使ったときの実効の幅。 */
export const RULER_MARKS: readonly number[] = [1280, 1366, 1536, 1920];
export const WIDTH_CHOICES: readonly number[] = [1280, 1366, 1920, 2560];
export const SCALE_CHOICES: readonly number[] = [100, 125, 150];

/** 画面の幅と拡大率（%）から、アプリが使える実効の幅（CSS px）を出す。例：1920 と 125 → 1536。 */
export function effectiveWidth(width: number, scalePercent: number): number {
  return Math.round(width / (scalePercent / 100));
}

/** 実効の幅のうち、グループを並べられる幅。 */
export function availableForGroups(effective: number): number {
  return Math.max(0, effective - RIBBON_RESERVED_PX);
}

/**
 * 幅に収まるように、グループの状態を決める（Excel の縮め方の目安。ファイル冒頭の仮定を参照）。
 * 縮めるのは幅が実際に減るときだけ（減らない段は飛ばす）。
 */
export function simulateFit(groups: readonly FitGroupInput[], available: number): FitResult {
  const states: GroupFitState[] = groups.map(() => 'large');
  const widthOf = (i: number) => groups[i]!.widths[states[i]!];
  const total = () => groups.reduce((sum, _g, i) => sum + widthOf(i), 0);

  const tryStep = (i: number, next: GroupFitState): boolean => {
    if (groups[i]!.widths[next] >= widthOf(i)) return false;
    states[i] = next;
    return true;
  };

  if (total() > available) {
    outer: {
      // 1. autoScale のグループを、右から一段ずつ縮める（全部を small にしてから、ラベルを消す）
      for (const step of ['small', 'nolabel'] as const) {
        for (let i = groups.length - 1; i >= 0; i--) {
          if (!groups[i]!.autoScale) continue;
          if (tryStep(i, step) && total() <= available) break outer;
        }
      }
      // 2. 右のグループから畳む
      for (let i = groups.length - 1; i >= 0; i--) {
        if (tryStep(i, 'collapsed') && total() <= available) break outer;
      }
    }
  }

  let left = 0;
  const out: FitGroupResult[] = groups.map((g, i) => {
    const width = widthOf(i);
    const r: FitGroupResult = { id: g.id, state: states[i]!, clipped: left + width > available, left, width };
    left += width;
    return r;
  });
  return { groups: out, used: left, fits: out.every((g) => !g.clipped) };
}

// ---- 確かめる幅（問題の一覧と配布前の確認に使う） ----

const CHECK_KEY = 'sash.fit.checkWidths';
export const DEFAULT_CHECK_WIDTHS: readonly number[] = [1920, 1366];

/** 確かめる画面の幅（大きい順）。既定は 1920 と 1366。 */
export function getCheckWidths(): number[] {
  try {
    const raw = localStorage.getItem(CHECK_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const ws = normalizeWidths(parsed.filter((x): x is number => typeof x === 'number'));
        if (ws.length) return ws;
      }
    }
  } catch {
    // 読めない環境では既定に戻す
  }
  return [...DEFAULT_CHECK_WIDTHS];
}

/** 確かめる幅を変える。キャンバスが測り直せるよう sash:fitsettings を投げる。 */
export function setCheckWidths(widths: readonly number[]): void {
  const ws = normalizeWidths(widths);
  try {
    localStorage.setItem(CHECK_KEY, JSON.stringify(ws.length ? ws : DEFAULT_CHECK_WIDTHS));
  } catch {
    // 保存できない環境では、この画面の間だけ効かせる手段がないので既定のまま
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sash:fitsettings'));
}

function normalizeWidths(ws: readonly number[]): number[] {
  return [...new Set(ws.map((w) => Math.round(w)).filter((w) => w >= 320 && w <= 10000))].sort((a, b) => b - a);
}

// ---- キャンバスが測った結果の受け渡し ----

export interface FitReportEntry {
  path: number[];
  id: string | null;
  label: string;
  /** グループのあるタブの表示名。 */
  tab: string;
  /** 畳まれる画面の幅のうち、いちばん広いもの（畳まれなければ無し）。 */
  collapsedAt?: number;
  /** 畳んでも入りきらない（右にはみ出す）画面の幅のうち、いちばん広いもの。 */
  clippedAt?: number;
  /** 畳まれたときに出すアイコン（image / imageMso / getImage）がない。 */
  noIcon: boolean;
}

export interface FitReport {
  /** プレビューで選んでいる画面の幅（「自由」なら null）。 */
  width: number | null;
  /** Windows の拡大率（%）。 */
  scale: number;
  /** 実効の幅（width / 拡大率）。「自由」なら null。 */
  effective: number | null;
  /** 確かめた幅。確かめる幅とプレビューの幅を合わせたもの（大きい順）。 */
  checkedWidths: number[];
  /** 畳まれる・はみ出すグループ（自作のタブのものだけ。組み込みのグループの幅は再現していないため）。 */
  overflowing: FitReportEntry[];
}

let report: FitReport = { width: null, scale: 100, effective: null, checkedWidths: [], overflowing: [] };
let reportKey = JSON.stringify(report);

/** 直近に測った結果。キャンバスを描くたびに更新され、変わったら window に sash:fitreport を投げる。 */
export function getFitReport(): FitReport {
  return report;
}

/** canvas.ts から呼ぶ。中身が変わったときだけ sash:fitreport を投げる（問題の一覧が無駄に描き直されないように）。 */
export function setFitReport(next: FitReport): void {
  const key = JSON.stringify(next);
  if (key === reportKey) return;
  report = next;
  reportKey = key;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sash:fitreport', { detail: next }));
}

export interface FitProblem {
  severity: 'warning' | 'info';
  message: string;
  path: number[];
}

/** 画面の幅の表記。拡大率が 100% 以外なら添える（例：「1920 幅（125%）」）。 */
export function widthLabel(width: number, scale: number): string {
  return scale === 100 ? t('{w} 幅', { w: width }) : t('{w} 幅（{s}%）', { w: width, s: scale });
}

/** 問題の一覧に出す形にする（下部パネルと配布前の確認で使う）。 */
export function fitProblems(r: FitReport = report): FitProblem[] {
  const out: FitProblem[] = [];
  const noIcon: FitReportEntry[] = [];
  for (const e of r.overflowing) {
    const name = e.label || e.id || t('(ラベルなし)');
    if (e.clippedAt !== undefined) {
      out.push({ severity: 'warning', path: e.path, message: t('{width}で［{name}］が収まりません（目安）', { width: widthLabel(e.clippedAt, r.scale), name }) });
    } else if (e.collapsedAt !== undefined) {
      out.push({ severity: 'info', path: e.path, message: t('{width}で［{name}］が畳まれます（目安）', { width: widthLabel(e.collapsedAt, r.scale), name }) });
    }
    if (e.noIcon && (e.collapsedAt !== undefined || e.clippedAt !== undefined)) noIcon.push(e);
  }
  // 畳まれたときのアイコンがなくても汎用のアイコンで出るだけなので、参考（info）にし、グループごとではなく 1 行にまとめる
  // （一覧が埋まって大事な警告が見えなくなるため）。押すと最初のグループを選ぶ
  if (noIcon.length) out.push({ severity: 'info', path: noIcon[0]!.path, message: t('{n} グループで畳まれたときのアイコンが未設定です', { n: noIcon.length }) });
  return out;
}
