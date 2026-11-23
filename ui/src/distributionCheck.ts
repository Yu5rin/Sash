// 配布前チェック（ツール メニュー。仕様書 §18.2）。配る前に見ておくべきことを、分類ごとに件数つきで集める。
// 画面（dialogs/distributionDialog.ts）と分けて、DOM の文書と問題の一覧だけから決まる純粋な集計にしておく（テストできるように）。

import { t } from './i18n';
import type { Problem, Severity } from './lint';
import { allElements, displayName, pathOf, type Path } from './model';
import { attributes } from './schema';
import type { CallbackStatus } from './vba';

/**
 * 確認の重さ。
 * - must：直さないと配れない・配ると困るもの（エラー・警告・VBA にないコールバック・収まらないグループ・キーヒントの重複）。見出しの件数に数える
 * - should：見直すとよいもの（ヒントやアイコンがない、使っていない画像、長いラベル、畳まれるグループ）
 * - info：参考（VBA で決まるラベル。キャンバスでは確かめられないので、Excel で見てもらう）
 */
export type CheckLevel = 'must' | 'should' | 'info';

/** 項目を押したときに移る先。element は要素を選ぶ、callbacks・images は下部パネルのその一覧を開く。 */
export type CheckTarget = 'element' | 'callbacks' | 'images';

export interface CheckItem {
  level: CheckLevel;
  text: string;
  /** どの要素か（表示名と種類）。 */
  detail?: string;
  path?: Path;
  target: CheckTarget;
  severity?: Severity;
}

export type CheckSectionId = 'problems' | 'callbacks' | 'fit' | 'keytips' | 'longLabels' | 'unusedImages' | 'noScreentip' | 'noIcon' | 'dynamicText';

export interface CheckSection {
  id: CheckSectionId;
  title: string;
  /** 一覧の説明・確かめられなかった理由など。 */
  note?: string;
  items: CheckItem[];
  /** VBA と照合できず、確かめていないコールバックの数（callbacks の分類だけ）。 */
  unverified?: number;
}

/** キャンバスが測ったグループ 1 つ分（views/ribbonFit.ts の FitReportEntry と同じ形）。 */
export interface FitEntry {
  path: number[];
  id: string | null;
  label: string;
  /** 畳まれる画面の幅のうち、いちばん広いもの。 */
  collapsedAt?: number;
  /** 畳んでも入りきらない画面の幅のうち、いちばん広いもの。 */
  clippedAt?: number;
  /** 畳まれたときに出すアイコンがない。 */
  noIcon: boolean;
}

/** キャンバスが測った結果。 */
export interface FitInput {
  entries: readonly FitEntry[];
  /** 幅の表記（例：「1366 幅（125%）」）。 */
  widthLabel: (width: number) => string;
  /** 確かめた幅の説明（例：「1920 幅、1366 幅」）。 */
  widths: string;
}

export interface CheckInput {
  doc: Document;
  problems: readonly Problem[];
  statuses: readonly CallbackStatus[];
  /** VBA と照合できたか（vba.status === 'ok'）。照合していなければコールバックは数えない。 */
  vbaChecked: boolean;
  /** 照合できなかった理由（vba.statusMessage()）。 */
  vbaNote?: string;
  /** ファイルに入っている画像の Id。 */
  imageIds: readonly string[];
  /** キャンバスが測った結果。まだ測っていない（幅を選んでいない）なら null。 */
  fit: FitInput | null;
}

/** ヒント・アイコンの有無を調べるボタンの類。 */
const BUTTONISH: ReadonlySet<string> = new Set(['button', 'toggleButton', 'menu', 'dynamicMenu', 'gallery']);

/** 文言を VBA で決める属性（キャンバスでは中身を出せないもの）。 */
const DYNAMIC_TEXT_ATTRS: readonly string[] = ['getLabel', 'getScreentip', 'getSupertip', 'getDescription', 'getKeytip', 'getText', 'getTitle', 'getHelperText', 'getAltText', 'getItemLabel'];

/** リボン（タブ・コンテキストタブ・クイックアクセス）の中か。Backstage と右クリックメニューはヒントの出方が違うので除く。 */
function inRibbon(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.localName === 'tabs' || p.localName === 'contextualTabs' || p.localName === 'qat') return true;
    if (p.localName === 'backstage' || p.localName === 'contextMenus') return false;
  }
  return false;
}

/**
 * グループに直接（box・buttonGroup・splitButton を通して）置いたものか。メニューの中の項目は、
 * Excel がヒントを出さない・アイコンがなくても並びが崩れないので対象にしない。
 */
function placedInGroup(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.localName === 'group') return true;
    if (p.localName !== 'box' && p.localName !== 'buttonGroup' && p.localName !== 'splitButton') return false;
  }
  return false;
}

/** 自分で作ったコントロールか（idMso の組み込みは Excel が自分のヒントとアイコンを持つ）。 */
const isCustom = (el: Element) => el.hasAttribute('id') || el.hasAttribute('idQ');

const describe = (el: Element) => {
  const name = displayName(el);
  return name ? `${name}（${el.localName}）` : el.localName;
};

const isCallbackAttr = (name: string | undefined) => !!name && attributes.get(name)?.kind === 'callback';

const samePath = (a: Path, b: Path) => a.length === b.length && a.every((v, i) => v === b[i]);

/** 分類ごとに集める。並びは重い順（must を含むもの → should → info）。 */
export function collectChecks(input: CheckInput): CheckSection[] {
  const { doc } = input;
  const elements = allElements(doc);
  const elAt = (path: Path): Element | null => {
    let el: Element | null = doc.documentElement;
    for (const i of path) el = el?.children[i] ?? null;
    return el;
  };
  const detailOf = (path: Path) => {
    const el = elAt(path);
    return el ? describe(el) : undefined;
  };

  // 1. 問題（Lint）。キーヒント・ラベルの長さは別の分類に、VBA との照合の警告はコールバックの分類に回す（同じものを二度数えない）
  const callbackIssues = input.statuses.filter((s) => s.state === 'missing' || s.state === 'mismatch');
  const fromCallbacks = (p: Problem) =>
    isCallbackAttr(p.attr) && callbackIssues.some((s) => s.uses.some((u) => u.attr === p.attr && samePath(u.path, p.path)));
  const keytipProblems = input.problems.filter((p) => p.attr === 'keytip');
  const longLabelProblems = input.problems.filter((p) => p.attr === 'label' && p.severity === 'warning');
  const restProblems = input.problems.filter(
    (p) => (p.severity === 'error' || p.severity === 'warning') && !keytipProblems.includes(p) && !longLabelProblems.includes(p) && !(input.vbaChecked && fromCallbacks(p)),
  );
  const problemItem = (p: Problem, level: CheckLevel): CheckItem => ({ level, text: p.message, detail: detailOf(p.path), path: p.path, target: 'element', severity: p.severity });

  const sections: CheckSection[] = [];
  sections.push({ id: 'problems', title: t('エラーと警告'), items: restProblems.map((p) => problemItem(p, 'must')) });

  // 2. VBA にないコールバック・引数の合わないコールバック。
  // 照合できていないのにコールバックがあるなら「配ってよい」とは言えない（押すと「マクロが見つかりません」になりうる）ので、
  // 確かめていない数を持たせ、見出しと並びで一番上に出す
  const callbackNames = new Set<string>();
  for (const el of elements) for (const a of Array.from(el.attributes)) if (isCallbackAttr(a.localName) && a.value) callbackNames.add(a.value);
  sections.push({
    id: 'callbacks',
    title: t('VBA にない・引数の合わないコールバック'),
    unverified: input.vbaChecked ? 0 : callbackNames.size,
    note: input.vbaChecked ? undefined : `${t('VBA と照合していないため、数えていません。')}${input.vbaNote ? ` ${input.vbaNote}` : ''}`,
    items: input.vbaChecked
      ? callbackIssues.filter((s) => s.uses.length > 0).map((s): CheckItem => ({
          level: 'must',
          text: s.state === 'missing' ? t('{name} が VBA にありません', { name: s.name }) : t('{name} の引数が合いません：{reason}', { name: s.name, reason: s.reason ?? '' }),
          detail: s.uses.map((u) => `${u.id}.${u.attr}`).join(', '),
          path: s.uses[0]!.path,
          target: 'callbacks',
        }))
      : [],
  });

  // 3. 確かめる幅で畳まれる・収まらないグループ（キャンバスの見積もり）。
  // 収まらない（右にはみ出してボタンが見えなくなる）ものは must、畳まれるだけのもの・畳んだときのアイコンがないものは should
  const fit = input.fit;
  const fitItems: CheckItem[] = [];
  const noIcon: FitEntry[] = [];
  for (const e of fit?.entries ?? []) {
    const name = e.label || e.id || t('(ラベルなし)');
    const base = { path: e.path, detail: detailOf(e.path), target: 'element' as const };
    if (e.clippedAt !== undefined) fitItems.push({ ...base, level: 'must', severity: 'warning', text: t('{width}で［{name}］が収まりません（目安）', { width: fit!.widthLabel(e.clippedAt), name }) });
    else if (e.collapsedAt !== undefined) fitItems.push({ ...base, level: 'should', severity: 'info', text: t('{width}で［{name}］が畳まれます（目安）', { width: fit!.widthLabel(e.collapsedAt), name }) });
    if (e.noIcon && (e.collapsedAt !== undefined || e.clippedAt !== undefined)) noIcon.push(e);
  }
  // 畳まれたときのアイコンがないのは、汎用のアイコンで出るだけなので参考に近い。グループごとに並べると一覧が埋まるので 1 行にまとめる
  // （押すと最初のグループを選ぶ。問題の一覧の fitProblems と同じ形）
  if (noIcon.length) {
    fitItems.push({
      level: 'should',
      severity: 'info',
      text: t('{n} グループで畳まれたときのアイコンが未設定です', { n: noIcon.length }),
      detail: noIcon.map((e) => e.label || e.id || t('(ラベルなし)')).join('、'),
      path: noIcon[0]!.path,
      target: 'element',
    });
  }
  sections.push({
    id: 'fit',
    title: t('チェックする画面の幅で畳まれる・収まらないグループ'),
    note: fit === null ? t('キャンバスで幅を選ぶと確認できます') : t('確かめた幅：{widths}（キャンバスの見積もり。実機の Excel とは少し違うことがあります）', { widths: fit.widths }),
    items: fitItems,
  });

  // 4. キーヒント（重複・長すぎる）
  sections.push({ id: 'keytips', title: t('キーヒントの重複'), items: keytipProblems.map((p) => problemItem(p, 'must')) });

  // 5. 長いラベル（Lint の警告）
  sections.push({ id: 'longLabels', title: t('長いラベル'), items: longLabelProblems.map((p) => problemItem(p, 'should')) });

  // 6. 使っていない画像（ファイルに入っているが、どの image 属性からも使われていない）
  const usedImages = new Set(elements.map((el) => el.getAttribute('image')).filter((v): v is string => !!v));
  sections.push({
    id: 'unusedImages',
    title: t('使っていない画像'),
    note: t('ファイルに入ったまま配られ、ファイルが大きくなります。VBA の getImage / loadImage で使っている場合はそのままで構いません。'),
    items: input.imageIds.filter((id) => !usedImages.has(id)).map((id): CheckItem => ({ level: 'should', text: id, target: 'images' })),
  });

  // 7・8. ヒント・アイコンのないボタン（自作のもので、リボンのグループに直接置いたものだけ）
  const buttons = elements.filter((el) => BUTTONISH.has(el.localName) && isCustom(el) && inRibbon(el) && placedInGroup(el));
  sections.push({
    id: 'noScreentip',
    title: t('ヒント（screentip）のないボタン'),
    items: buttons
      .filter((el) => !el.hasAttribute('screentip') && !el.hasAttribute('getScreentip'))
      .map((el): CheckItem => ({ level: 'should', text: describe(el), path: pathOf(el), target: 'element' })),
  });
  sections.push({
    id: 'noIcon',
    title: t('アイコンのないボタン'),
    items: buttons
      .filter((el) => !el.hasAttribute('image') && !el.hasAttribute('imageMso') && !el.hasAttribute('getImage') && el.getAttribute('showImage') !== 'false')
      .map((el): CheckItem => ({ level: 'should', text: describe(el), path: pathOf(el), target: 'element' })),
  });

  // 9. VBA で決まる文言（キャンバスでは出せないので、Excel で見てもらう）
  sections.push({
    id: 'dynamicText',
    title: t('VBA で決まるラベル・文言'),
    note: t('キャンバスには中身を出せません。Excel で表示を確かめてください。'),
    items: elements.flatMap((el) =>
      DYNAMIC_TEXT_ATTRS.filter((a) => el.hasAttribute(a)).map((a): CheckItem => ({ level: 'info', text: `${a}="${el.getAttribute(a)}"`, detail: describe(el), path: pathOf(el), target: 'element' })),
    ),
  });

  const weight = (s: CheckSection) => ((s.unverified ?? 0) > 0 ? -1 : s.items.some((i) => i.level === 'must') ? 0 : s.items.some((i) => i.level === 'should') ? 1 : s.items.length ? 2 : 3);
  // 同じ重さなら上の定義順のまま（sort は安定）
  return sections.sort((a, b) => weight(a) - weight(b));
}

/** 見出しに出す「確認が必要な件数」（must の項目の数）。 */
export function attentionCount(sections: readonly CheckSection[]): number {
  return sections.reduce((n, s) => n + s.items.filter((i) => i.level === 'must').length, 0);
}

/** 見直すとよいものの件数（should）。 */
export function suggestionCount(sections: readonly CheckSection[]): number {
  return sections.reduce((n, s) => n + s.items.filter((i) => i.level === 'should').length, 0);
}

/** VBA と照合できず、確かめていないコールバックの数。 */
export function unverifiedCallbacks(sections: readonly CheckSection[]): number {
  return sections.reduce((n, s) => n + (s.unverified ?? 0), 0);
}

/** 配ってよいと言えるか（確認が必要なものがなく、コールバックも照合できている）。 */
export function readyToDistribute(sections: readonly CheckSection[]): boolean {
  return attentionCount(sections) === 0 && unverifiedCallbacks(sections) === 0;
}

/** 見出しの文言。コールバックを照合できていなければ、ほかに何もなくても「配ってよい」とは言わない。 */
export function summaryText(sections: readonly CheckSection[]): string {
  const n = attentionCount(sections);
  const u = unverifiedCallbacks(sections);
  if (u > 0) {
    const head = t('VBA と照合できていません（コールバック {n} 件は未確認）', { n: u });
    return n === 0 ? head : `${head}${t('。ほかに {n} 件の確認が必要です', { n })}`;
  }
  return n === 0 ? t('配ってよい状態です') : t('{n} 件の確認が必要です', { n });
}
