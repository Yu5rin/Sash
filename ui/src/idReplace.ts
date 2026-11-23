// ID の一括置換（例：btn で始まる id を cmd に）。計画（何がどう変わるか）を純粋な処理で作り、ダイアログはその表示と適用だけをする。
// 計画を先に作るのは、適用する前に「重なる」「id として使えない」を一覧で見せ、壊れた状態を作らないため。

import { allElements, pathOf, type Path } from './model';
import { attributes, isXmlId } from './schema';
import { bareCallbackName, callbackName, type NamingRule } from './vba';

export type IdReplaceMode = 'prefix' | 'substring';

export interface IdReplaceOptions {
  find: string;
  replace: string;
  /** prefix は先頭だけ、substring は含まれるところすべてを置き換える。 */
  mode: IdReplaceMode;
  /** 命名規則どおりのコールバック名も、新しい id に合わせて変えるか。 */
  renameCallbacks: boolean;
  rule: NamingRule;
}

export interface IdRename {
  path: Path;
  tag: string;
  oldId: string;
  newId: string;
  /** id として使えない（先頭が数字になった、記号が入ったなど）。 */
  invalid: boolean;
  /** ほかの要素の id と重なる（置き換えない要素の id か、置き換えた結果どうし）。 */
  conflict: boolean;
}

export interface CallbackRename {
  /** 属性に書かれた値そのもの（"Module1.Name" の形を含む）。 */
  oldName: string;
  newName: string;
  /** この名前を使っている場所。 */
  uses: { path: Path; attr: string }[];
  /** ほかのコールバック名と重なる（大文字小文字は区別しない。VBA が区別しないため）。 */
  conflict: boolean;
}

export interface IdReplacePlan {
  ids: IdRename[];
  callbacks: CallbackRename[];
  /** 問題（重なり・使えない id）があるか。あれば適用しない。 */
  hasProblems: boolean;
}

/** 1つの id に置換を当てる。合わなければ元のまま返す。 */
export function replaceId(id: string, opts: Pick<IdReplaceOptions, 'find' | 'replace' | 'mode'>): string {
  if (!opts.find) return id;
  if (opts.mode === 'prefix') return id.startsWith(opts.find) ? opts.replace + id.slice(opts.find.length) : id;
  return id.split(opts.find).join(opts.replace);
}

const isCallbackAttr = (name: string) => attributes.get(name)?.kind === 'callback';

/**
 * 置換の計画を作る。文書は変えない。
 * 対象は id 属性だけ（idMso は組み込みの名前、idQ は別のアドインの id を指すもので、置き換えると参照が切れるため）。
 */
export function planIdReplace(doc: Document, opts: IdReplaceOptions): IdReplacePlan {
  const els = allElements(doc);
  const ids: IdRename[] = [];
  const renamedEls = new Map<Element, IdRename>();
  for (const el of els) {
    const id = el.getAttribute('id');
    if (!id) continue;
    const next = replaceId(id, opts);
    if (next === id) continue;
    const r: IdRename = { path: pathOf(el), tag: el.localName, oldId: id, newId: next, invalid: !isXmlId(next), conflict: false };
    ids.push(r);
    renamedEls.set(el, r);
  }

  // 置換したあとの id の数を数え、2つ以上になるものを重なりとする
  const finalIds = new Map<string, number>();
  for (const el of els) {
    const id = el.getAttribute('id');
    if (!id) continue;
    const final = renamedEls.get(el)?.newId ?? id;
    finalIds.set(final, (finalIds.get(final) ?? 0) + 1);
  }
  for (const r of ids) r.conflict = (finalIds.get(r.newId) ?? 0) > 1;

  const callbacks: CallbackRename[] = [];
  if (opts.renameCallbacks && !opts.rule.shared) {
    // 命名規則どおりの名前（Ribbon_{id}_{attr} など）だけを変える。利用者が自分で付けた名前は、id と関係がないかもしれないので触らない
    const byOld = new Map<string, string>();
    for (const [el, r] of renamedEls) {
      for (const a of Array.from(el.attributes)) {
        if (!a.value || !isCallbackAttr(a.name)) continue;
        const bare = bareCallbackName(a.value);
        if (bare !== callbackName(opts.rule, r.oldId, a.name, el.localName)) continue;
        const qualifier = a.value.slice(0, a.value.length - bare.length);
        const newName = qualifier + callbackName(opts.rule, r.newId, a.name, el.localName);
        if (newName !== a.value && !byOld.has(a.value)) byOld.set(a.value, newName);
      }
    }
    // 同じ名前を使っている場所はすべてそろえる（複数のコントロールで1つの Sub を共有していることがあるため）
    for (const el of els) {
      for (const a of Array.from(el.attributes)) {
        if (!a.value || !isCallbackAttr(a.name)) continue;
        const rename = byOld.get(a.value);
        if (rename !== undefined) {
          let c = callbacks.find((x) => x.oldName === a.value);
          if (!c) callbacks.push((c = { oldName: a.value, newName: rename, uses: [], conflict: false }));
          c.uses.push({ path: pathOf(el), attr: a.name });
        }
      }
    }
    // 置換したあとのコールバック名（Sub 名の部分）の種類で、重なりを調べる
    const finalOf = (v: string) => bareCallbackName(byOld.get(v) ?? v).toLowerCase();
    const sources = new Map<string, Set<string>>();
    for (const el of els) {
      for (const a of Array.from(el.attributes)) {
        if (!a.value || !isCallbackAttr(a.name)) continue;
        const f = finalOf(a.value);
        if (!sources.has(f)) sources.set(f, new Set());
        sources.get(f)!.add(bareCallbackName(a.value).toLowerCase());
      }
    }
    for (const c of callbacks) c.conflict = (sources.get(bareCallbackName(c.newName).toLowerCase())?.size ?? 0) > 1;
  }

  const hasProblems = ids.some((r) => r.invalid || r.conflict) || callbacks.some((c) => c.conflict);
  return { ids, callbacks, hasProblems };
}

/**
 * 計画を文書に当てる。skipCallbacks に入れた古い名前のコールバックは変えない（VBA の Sub 名を変えられなかったものなど）。
 * パスは計画を作ったときの文書のものなので、計画を作ってから適用までの間に文書を変えないこと。
 */
export function applyIdReplacePlan(doc: Document, plan: IdReplacePlan, skipCallbacks: ReadonlySet<string> = new Set()): void {
  const at = (path: Path): Element | null => {
    let el: Element | null = doc.documentElement;
    for (const i of path) el = el?.children[i] ?? null;
    return el;
  };
  // 先に要素を引いておく（属性を変えても並びは変わらないが、引き方を一つにしておく）
  const idTargets = plan.ids.map((r) => ({ el: at(r.path), r }));
  const cbTargets = plan.callbacks.filter((c) => !skipCallbacks.has(c.oldName)).flatMap((c) => c.uses.map((u) => ({ el: at(u.path), attr: u.attr, c })));
  for (const { el, r } of idTargets) if (el && el.getAttribute('id') === r.oldId) el.setAttribute('id', r.newId);
  for (const { el, attr, c } of cbTargets) if (el && el.getAttribute(attr) === c.oldName) el.setAttribute(attr, c.newName);
}

/** VBA の中で、置き換える前の id を文字列として書いている箇所（Case "btnRun"・InvalidateControl "btnRun" など）。 */
export interface VbaIdLiteral {
  module: string;
  /** 1 から数えた行。 */
  line: number;
  id: string;
  /** その行（前後の空白を除く）。 */
  text: string;
}

/**
 * VBA のコードから、古い id と同じ中身の文字列リテラルを探す（大文字と小文字は区別する。id は区別されるため）。
 * コメント（文字列の外の ' 以降）は見ない。一括置換は Sub 名（宣言行）しか変えないので、
 * Select Case control.Id や InvalidateControl に書いた id は、利用者に手で直してもらうために一覧にする。
 */
export function findIdLiteralsInVba(modules: readonly { name: string; code: string }[], oldIds: Iterable<string>): VbaIdLiteral[] {
  const ids = new Set(oldIds);
  const out: VbaIdLiteral[] = [];
  if (ids.size === 0) return out;
  for (const m of modules) {
    const lines = m.code.split(/\r?\n/);
    lines.forEach((raw, i) => {
      // "..." の中身を順に拾う（"" は文字列の中の " ）。文字列の外の ' から後ろはコメントなので見ない
      let j = 0;
      while (j < raw.length) {
        const c = raw[j];
        if (c === "'") break;
        if (c !== '"') {
          j++;
          continue;
        }
        let value = '';
        j++;
        while (j < raw.length) {
          if (raw[j] === '"') {
            if (raw[j + 1] === '"') {
              value += '"';
              j += 2;
              continue;
            }
            break;
          }
          value += raw[j++];
        }
        j++;
        if (ids.has(value)) out.push({ module: m.name, line: i + 1, id: value, text: raw.trim() });
      }
    });
  }
  return out;
}
