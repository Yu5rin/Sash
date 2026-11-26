// 配布前チェック（ツール メニュー。仕様書 §18.2）。配る前に見ておくべきことを、分類ごとに件数つきで集める。
// 画面（dialogs/distributionDialog.ts）と分けて、DOM の文書と問題の一覧だけから決まる純粋な集計にしておく（テストできるように）。

import { t } from './i18n';
import type { Problem, Severity } from './lint';
import { allElements, displayName, pathOf, type Path } from './model';
import { attributes, titleOf } from './schema';
import type { ImageInfo } from './imageStats';
import { bareCallbackName, parseParams, parseProcedures, procedureCode, stripComment, type CallbackStatus, type VbaModule } from './vba';

/**
 * 確認の重さ。
 * - must：直さないと配れない・配ると困るもの（エラー・警告・VBA にないコールバック・収まらないグループ・キーヒントの重複）。見出しの件数に数える
 * - should：見直すとよいもの（ヒントやアイコンがない、使っていない画像、長いラベル、畳まれるグループ）
 * - info：参考（VBA で決まるラベル。キャンバスでは確かめられないので、Excel で見てもらう）
 */
export type CheckLevel = 'must' | 'should' | 'info';

/** 項目を押したときに移る先。element は要素を選ぶ、callbacks・images は下部パネルのその一覧を開く、none は移る先のない案内。 */
export type CheckTarget = 'element' | 'callbacks' | 'images' | 'none';

export interface CheckItem {
  level: CheckLevel;
  text: string;
  /** どの要素か（表示名と種類）。 */
  detail?: string;
  path?: Path;
  target: CheckTarget;
  severity?: Severity;
}

export type CheckSectionId =
  | 'errors' | 'warnings' | 'callbacks' | 'fit' | 'keytips' | 'longLabels' | 'unusedImages' | 'noScreentip' | 'noIcon' | 'dynamicText'
  // 0.3.0 で足した分（§23.5）
  | 'commonNames' | 'ribbonHolder' | 'themeIcons' | 'bigImages' | 'macroBlock';

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
  /** VBA のモジュール（照合できているとき。onLoad の中身と Invalidate の有無を見る）。 */
  modules?: readonly VbaModule[] | null;
  /** 画像の大きさ・バイト数・色合い（id → 情報。色合いは調べ終えたものだけ）。 */
  images?: ReadonlyMap<string, ImageInfo>;
  /** このブックに、インターネットから取得した印が付いている（ホストが調べる）。 */
  webMark?: boolean;
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
  // 種類は日本語名で（「集計する（ボタン）」。問題の一覧と同じ。英字のタグ名は出さない。総点検 D-3）
  return name ? `${name}（${titleOf(el.localName)}）` : titleOf(el.localName);
};

const isCallbackAttr = (name: string | undefined) => !!name && attributes.get(name)?.kind === 'callback';

const samePath = (a: Path, b: Path) => a.length === b.length && a.every((v, i) => v === b[i]);


// ---- 0.3.0 で足した確認（§23.5） ----

/**
 * ほかのアドインと重なりやすい id（接頭辞のない、種類を表す語＋番号だけ。btn1・Button2・tab_1 など）。
 * ブック固有の接頭辞が付いている id（acct_btnSum など）は対象にしない（誤って出すと煩わしいので、判定は控えめにする）。
 */
export const GENERIC_ID = /^(btn|button|cmd|command|tab|grp|group|menu|mnu|chk|check|checkbox|tgl|toggle|dd|ddn|drop|dropdown|combo|cbo|edit|txt|gal|gallery|lbl|label)[_-]?\d*$/i;

/** 重なりやすいコールバック名（Button1_Click・OnAction・Macro1 など。標準の命名規則で作った Ribbon_… は、規則で別の名前にできるので対象にしない）。 */
export const GENERIC_CALLBACK = /^(Button\d*_Click|On(Action|Change|Load)\d*|Callback\d*|Macro\d*|Test\d*|Sub\d*|Run|Main|Click\d*)$/i;

const normalizeLabel = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

/** Excel のタブ名や、アドインがよく付けるタブ名（同じ名前のタブが並ぶと、どれがどれか分からなくなる）。 */
const COMMON_TAB_LABELS: ReadonlySet<string> = new Set([
  'ホーム', '挿入', '数式', 'データ', '校閲', '表示', '開発', 'ヘルプ', 'アドイン', 'ツール', 'マクロ', 'カスタム', '新しいタブ', 'その他', '設定',
  'home', 'insert', 'formulas', 'data', 'review', 'view', 'developer', 'help', 'addins', 'tools', 'macros', 'custom', 'newtab', 'settings', 'other', 'tab1', 'tab2', 'tab3',
].map(normalizeLabel));

export const isGenericId = (id: string) => GENERIC_ID.test(id);
export const isGenericCallback = (name: string) => GENERIC_CALLBACK.test(bareCallbackName(name));
export const isCommonTabLabel = (label: string) => COMMON_TAB_LABELS.has(normalizeLabel(label));

/** id の重なりを調べる対象の要素（ほかのアドインと同じ名前空間で見分けられる、タブ・グループ・コントロール）。 */
const ID_CHECKED: ReadonlySet<string> = new Set(['tab', 'group', 'button', 'toggleButton', 'checkBox', 'dropDown', 'comboBox', 'editBox', 'menu', 'dynamicMenu', 'splitButton', 'gallery', 'labelControl']);

/** 大きすぎる画像の目安。Office のリボンのアイコンは 32px（高 DPI でも 64px）までで足りる。 */
export const BIG_IMAGE_PX = 64;
export const BIG_IMAGE_BYTES = 50 * 1024;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sub の中身（宣言と End Sub を除き、コメントを除いたもの）。 */
function procedureBody(module: VbaModule, name: string): { body: string; param: string | undefined } | null {
  const proc = parseProcedures(module).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!proc) return null;
  const lines = procedureCode(module, proc).split(/\r?\n/);
  return { body: lines.slice(1, -2).map(stripComment).join('\n'), param: parseParams(proc.params)[0]?.name };
}

/** onLoad の Sub が、受け取った ribbon（IRibbonUI）を使っているか（変数に保持する・保持する Sub へ渡すなど）。 */
export function onLoadHoldsRibbon(modules: readonly VbaModule[], procName: string, moduleName: string): boolean | null {
  const module = modules.find((m) => m.name === moduleName);
  const found = module ? procedureBody(module, procName) : null;
  if (!found || !found.param) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(found.param)}(?![\\p{L}\\p{N}_])`, 'iu').test(found.body);
}

/** VBA に Invalidate の呼び出しがあるか。IRibbonUI を保持する共通コード（modRibbonCore）の中の定義は数えない（定義だけで、呼んでいないため）。 */
export function hasInvalidateCall(modules: readonly VbaModule[], coreModule: string): boolean {
  return modules.some((m) => m.name !== coreModule && m.code.split(/\r?\n/).some((line) => /\bInvalidate\w*/i.test(stripComment(line))));
}

const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024));

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
  // エラー（id の重複・id のないボタン・使えない属性・ない画像など）は、Excel でリボンが出なくなる。警告と分けて先頭に置く
  sections.push({ id: 'errors', title: t('エラー'), items: restProblems.filter((p) => p.severity === 'error').map((p) => problemItem(p, 'must')) });
  sections.push({ id: 'warnings', title: t('警告'), items: restProblems.filter((p) => p.severity !== 'error').map((p) => problemItem(p, 'must')) });

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

  // 10. ほかのアドインと重なりやすい名前（id・タブ名・コールバック名）。見直し止まり（重なると別のブックのマクロが呼ばれることがある）
  const nameItems: CheckItem[] = [];
  for (const el of elements) {
    const id = el.getAttribute('id');
    if (id && ID_CHECKED.has(el.localName) && isGenericId(id)) {
      nameItems.push({ level: 'should', text: t('id「{id}」は、ほかのアドインと重なりやすい名前です', { id }), detail: describe(el), path: pathOf(el), target: 'element' });
    }
    const label = el.getAttribute('label');
    if (el.localName === 'tab' && id && label && isCommonTabLabel(label)) {
      nameItems.push({ level: 'should', text: t('タブ名「{label}」は、Excel やほかのアドインのタブと紛らわしい名前です', { label }), detail: describe(el), path: pathOf(el), target: 'element' });
    }
  }
  const generic = new Map<string, { path: Path; uses: string[] }>();
  for (const el of elements) {
    for (const a of Array.from(el.attributes)) {
      if (!isCallbackAttr(a.localName) || !a.value || !isGenericCallback(a.value)) continue;
      const use = `${el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName}.${a.localName}`;
      const prev = generic.get(a.value);
      if (prev) prev.uses.push(use);
      else generic.set(a.value, { path: pathOf(el), uses: [use] });
    }
  }
  for (const [name, g] of generic) {
    nameItems.push({ level: 'should', text: t('コールバック名「{name}」は、ほかのアドインと重なりやすい名前です', { name }), detail: g.uses.join(', '), path: g.path, target: 'element' });
  }
  sections.push({
    id: 'commonNames',
    title: t('ほかのアドインと重なりやすい名前'),
    note: t('同じ名前の Sub や id が、同時に開いたほかのアドインにあると、別のブックのマクロが呼ばれたり、リボンが混ざったりすることがあります。［ツール］→［ID の一括置換］で、ブック固有の接頭辞（例：acct_）を付けられます。'),
    items: nameItems,
  });

  // 11. onLoad と Invalidate の入れ忘れ。get〜 の動的な属性は、Invalidate を呼ばないと最初の 1 回しか決まらない。
  // Invalidate するには、onLoad で受け取った ribbon を保持しておく必要がある
  const dynamicAttrs = new Set<string>();
  for (const el of elements) for (const a of Array.from(el.attributes)) if (isCallbackAttr(a.localName) && a.localName.startsWith('get')) dynamicAttrs.add(a.localName);
  const holderItems: CheckItem[] = [];
  const onLoadName = doc.documentElement.getAttribute('onLoad');
  if (dynamicAttrs.size > 0) {
    const attrs = [...dynamicAttrs].slice(0, 4).join(', ') + (dynamicAttrs.size > 4 ? ' …' : '');
    if (!onLoadName) {
      holderItems.push({ level: 'should', text: t('get〜 の動的な属性（{attrs}）を使っていますが、customUI に onLoad がありません。Invalidate で更新できません', { attrs }), path: [], target: 'element' });
    } else if (input.vbaChecked && input.modules) {
      const st = input.statuses.find((x) => x.uses.some((u) => u.attr === 'onLoad'));
      if (st?.state === 'implemented' && st.procedure && onLoadHoldsRibbon(input.modules, st.procedure.name, st.procedure.module) === false) {
        holderItems.push({ level: 'should', text: t('onLoad の Sub「{name}」が、受け取った ribbon を保持していません。Invalidate で更新できません', { name: st.name }), detail: `${st.procedure.module} ${st.procedure.line}行目`, path: st.uses[0]!.path, target: 'callbacks' });
      }
      if (!hasInvalidateCall(input.modules, 'modRibbonCore')) {
        holderItems.push({ level: 'should', text: t('VBA に Invalidate を呼ぶところがありません。get〜 の値は、読み込んだときの 1 回だけ決まります'), target: 'callbacks' });
      }
    }
  }
  sections.push({
    id: 'ribbonHolder',
    title: t('onLoad と Invalidate の入れ忘れ'),
    note: dynamicAttrs.size === 0
      ? t('get〜 の動的な属性を使っていないので、確かめる必要はありません。')
      : input.vbaChecked
        ? t('［ツール］→［VBA］→［onLoad と Invalidate の雛形を挿入］で入れられます。')
        : `${t('VBA と照合していないため、onLoad の中身と Invalidate の呼び出しは確かめていません。')} ${t('［ツール］→［VBA］→［onLoad と Invalidate の雛形を挿入］で入れられます。')}`,
    items: holderItems,
  });

  // 12・13. 画像：テーマで見えにくいもの（色合い）と、大きすぎるもの（寸法・バイト数）。リボンから使っている画像だけを見る
  // （使っていない画像は「使っていない画像」の分類に出る）
  const themeItems: CheckItem[] = [];
  const bigItems: CheckItem[] = [];
  for (const id of usedImages) {
    const info = input.images?.get(id);
    if (!info) continue;
    const st = info.stats;
    if (st && st.opaque >= 16) {
      if (st.solidBackground) {
        themeItems.push({ level: 'should', text: st.solidBackground === 'light' ? t('画像「{id}」は白い背景が透明になっていません。暗いテーマでは白い四角に見えます', { id }) : t('画像「{id}」は黒い背景が透明になっていません。明るいテーマでは黒い四角に見えます', { id }), detail: id, target: 'images' });
      } else if (st.meanLuma < 60 && st.darkShare >= 0.85) {
        themeItems.push({ level: 'should', text: t('画像「{id}」は暗い単色に近く、Office の黒・濃い灰色のテーマで背景に沈みます', { id }), detail: id, target: 'images' });
      } else if (st.meanLuma > 215 && st.lightShare >= 0.85) {
        themeItems.push({ level: 'should', text: t('画像「{id}」は白に近い単色で、Office の白・明るいテーマで背景に沈みます', { id }), detail: id, target: 'images' });
      }
    }
    const tooWide = (info.width ?? 0) > BIG_IMAGE_PX || (info.height ?? 0) > BIG_IMAGE_PX;
    const tooHeavy = info.bytes > BIG_IMAGE_BYTES;
    if (tooWide || tooHeavy) {
      const parts: string[] = [];
      if (tooWide) parts.push(t('{w}×{h} px', { w: info.width ?? 0, h: info.height ?? 0 }));
      if (tooHeavy) parts.push(t('{size} KB', { size: kb(info.bytes) }));
      bigItems.push({ level: 'should', text: t('画像「{id}」が大きすぎます（{detail}）。アイコンは 32px（高 DPI でも 64px）で足ります', { id, detail: parts.join(t('、')) }), detail: id, target: 'images' });
    }
  }
  sections.push({
    id: 'themeIcons',
    title: t('テーマで見えにくいアイコン'),
    note: input.images && [...usedImages].some((id) => input.images!.get(id) && !input.images!.get(id)!.stats)
      ? t('画像の色を調べています…')
      : t('Office には白・明るい灰色・濃い灰色・黒のテーマがあります。黒や白だけのアイコンは、背景と同じ色になって見えなくなります。透明な背景に、どのテーマでも読める色で描いてください。'),
    items: themeItems,
  });
  sections.push({
    id: 'bigImages',
    title: t('大きすぎる画像'),
    note: t('目安：{px}px より大きい、または {kb} KB より大きい画像。ブックが重くなり、リボンの描画も遅くなります。', { px: BIG_IMAGE_PX, kb: Math.round(BIG_IMAGE_BYTES / 1024) }),
    items: bigItems,
  });

  // 14. 配布先でマクロがブロックされること（検査できないので、案内だけ。件数は出さない）
  const blockItems: CheckItem[] = [{ level: 'info', text: t('メールやダウンロードで受け取ったブックは、Windows がマクロをブロックすることがあります'), target: 'none' }];
  if (input.webMark) {
    blockItems.unshift({ level: 'should', text: t('いま開いているこのブックには、インターネットから取得した印が付いています。Excel で開くと保護ビューになり、マクロ（リボンのボタン）が動きません'), detail: t('ファイルのプロパティの［許可する］で解除できます'), target: 'none' });
  }
  sections.push({
    id: 'macroBlock',
    title: t('配布先でのマクロのブロック'),
    note: t('インターネットやメールから取得したファイルには、Windows が「インターネットから取得した」印（Mark of the Web）を付けます。印のあるブックは、Office がマクロを既定で止めるため、配布先でリボンのボタンが動かない・アドインが読み込まれないことがあります。共有フォルダから各自の PC へコピーして使ってもらう、ファイルのプロパティの［許可する］で解除してもらう、または［信頼できる場所］に置いてもらってください。Sash から、これを確かめたり解除したりはできません。'),
    items: blockItems,
  });

  // エラー（Excel でリボンが出なくなるもの）は、照合の未確認よりも前に出す
  const weight = (s: CheckSection) => (s.items.some((i) => i.level === 'must' && i.severity === 'error') ? -2 : (s.unverified ?? 0) > 0 ? -1 : s.items.some((i) => i.level === 'must') ? 0 : s.items.some((i) => i.level === 'should') ? 1 : s.items.length ? 2 : 3);
  // 同じ重さなら上の定義順のまま（sort は安定）
  return sections.sort((a, b) => weight(a) - weight(b));
}

/** 見出しに出す「確認が必要な件数」（must の項目の数）。 */
export function attentionCount(sections: readonly CheckSection[]): number {
  return sections.reduce((n, s) => n + s.items.filter((i) => i.level === 'must').length, 0);
}

/** エラー（Excel でリボンが出なくなるもの）の件数。must のうち severity が error のもの。 */
export function errorCount(sections: readonly CheckSection[]): number {
  return sections.reduce((n, s) => n + s.items.filter((i) => i.level === 'must' && i.severity === 'error').length, 0);
}

/** 見出しの深刻さ。エラーがあれば error、要確認があれば attention、なければ ok。 */
export type SummaryLevel = 'error' | 'attention' | 'ok';

export function summaryLevel(sections: readonly CheckSection[]): SummaryLevel {
  if (errorCount(sections) > 0) return 'error';
  return readyToDistribute(sections) ? 'ok' : 'attention';
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
  // エラーがあれば、ほかより先にそれを伝える（配ってはいけない状態だと分かるように）
  const e = errorCount(sections);
  if (e > 0) return t('このまま配ると、Excel でリボンが表示されません（エラー {n} 件）', { n: e });
  const n = attentionCount(sections);
  const u = unverifiedCallbacks(sections);
  if (u > 0) {
    const head = t('VBA と照合できていません（コールバック {n} 件は未確認）', { n: u });
    return n === 0 ? head : `${head}${t('。ほかに {n} 件の確認が必要です', { n })}`;
  }
  return n === 0 ? t('配ってよい状態です') : t('{n} 件の確認が必要です', { n });
}
