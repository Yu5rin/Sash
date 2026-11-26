// 既存のマクロをボタンに割り当てる（仕様書 §23.1）。
// リボンの onAction は IRibbonControl を受ける Sub でなければ呼べないので、既存の「引数なしの Sub」を呼ぶだけの
// 呼び出し用の Sub を作って割り当てる。ここは DOM にも Excel にも触れない純粋な関数だけを置く（テストできるように）。

import type { Path } from './model';
import { callbackSignature, isVbaIdentifier } from './schema';
import { t } from './i18n';
import { parseParams, parseProcedures, type CallbackStatus, type VbaModule, type VbaProcedure } from './vba';

/** 割り当てる候補のマクロ 1 つ。 */
export interface MacroEntry {
  /** 定義されているモジュール名（手で入れたときは、書いたとおり。なければ空）。 */
  module: string;
  /** モジュールの種類（1 = 標準モジュール）。手で入れたときは 1 とみなす。 */
  moduleType: number;
  name: string;
  /** 呼び出し用の Sub の中に書く名前。標準モジュールのものは「モジュール名.Sub 名」にして、同じ名前の Sub が別にあっても取り違えない。 */
  qualified: string;
  /** 割り当てられるか。 */
  assignable: boolean;
  /** 割り当てられない理由（利用者に見せる文言）。 */
  reason?: string;
  /** 同じ名前の Sub が別のモジュールにもある（モジュール名つきで呼ぶので動作は変わらない。一覧に添える）。 */
  duplicated: boolean;
}

/** すべての引数が省略できる（Optional）か。引数なしで呼べるので、引数なしの Sub と同じに扱う。 */
function callableWithoutArguments(p: VbaProcedure): boolean {
  return p.params.trim() === '' || parseParams(p.params).every((x) => x.optional);
}

/** 1 つの手続きを、割り当てられるかどうかを判定して MacroEntry にする。 */
export function toMacroEntry(p: VbaProcedure, moduleType: number, duplicated: boolean): MacroEntry {
  let reason: string | undefined;
  if (p.kind === 'function') reason = t('Function は戻り値があるため、割り当てられません（Sub だけ）');
  else if (p.isPrivate) reason = t('Private のため、ほかのモジュール（呼び出し用の Sub）から呼べません');
  else if (moduleType !== 1) reason = t('クラス・シート・ThisWorkbook のモジュールの Sub は、標準モジュールから直接呼べません');
  else if (!callableWithoutArguments(p)) reason = t('引数があるため、割り当てられません（引数なしの Sub だけ）');
  return {
    module: p.module,
    moduleType,
    name: p.name,
    qualified: moduleType === 1 && p.module ? `${p.module}.${p.name}` : p.name,
    assignable: reason === undefined,
    reason,
    duplicated,
  };
}

/**
 * VBA のモジュール全体から、候補の一覧を作る（モジュールの並び・宣言の順のまま）。
 * 割り当てられないものも、理由つきで残す（なぜ選べないかが分かるように）。
 * リボンのコールバック（IRibbonControl を受けるもの）は、すでに呼び出し用の Sub なので候補に出さない。
 */
export function listMacros(modules: readonly VbaModule[] | null): MacroEntry[] {
  if (!modules) return [];
  const all = modules.map((m) => ({ m, procs: parseProcedures(m) }));
  const counts = new Map<string, number>();
  for (const { procs } of all) for (const p of procs) counts.set(p.name.toLowerCase(), (counts.get(p.name.toLowerCase()) ?? 0) + 1);
  const out: MacroEntry[] = [];
  for (const { m, procs } of all) {
    for (const p of procs) {
      const first = parseParams(p.params)[0];
      if (first && (first.type === 'iribboncontrol' || first.type === 'iribbonui')) continue;
      out.push(toMacroEntry(p, m.type, (counts.get(p.name.toLowerCase()) ?? 0) > 1));
    }
  }
  return out;
}

/** 手で入れた名前（Excel で開いていないとき）から候補を作る。使えない名前なら null。「モジュール名.Sub 名」の形も受ける。 */
export function manualMacro(text: string): MacroEntry | null {
  const value = text.trim();
  const m = /^(?:([^\s.!]+)[.!])?([^\s.!]+)$/u.exec(value);
  if (!m || !isVbaIdentifier(m[2]!) || (m[1] !== undefined && !isVbaIdentifier(m[1]))) return null;
  return { module: m[1] ?? '', moduleType: 1, name: m[2]!, qualified: m[1] ? `${m[1]}.${m[2]}` : m[2]!, assignable: true, duplicated: false };
}

/** 呼び出し用の Sub を作れる属性か（戻り値を返す ByRef の引数がなく、onLoad でないもの）。 */
export function canWrapAttr(attr: string, tag: string): boolean {
  if (attr === 'onLoad' || !attr.startsWith('on')) return false;
  return !/ByRef/i.test(callbackSignature(attr, tag));
}

/** 呼び出し用の Sub 1 つ分の VBA。マクロの引数は使わないので、使わない引数があればコメントで断る。 */
export function generateWrapper(name: string, attr: string, tag: string, macro: MacroEntry): string {
  const sig = callbackSignature(attr, tag);
  const unused = parseParams(sig).slice(1).map((p) => p.name);
  const lines = [`Public Sub ${name}(${sig})`, `    ' リボンから「${macro.name}」を呼び出す（Sash が生成）`];
  if (unused.length) lines.push(`    ' ${unused.join('・')} は使わずに呼びます`);
  lines.push(`    Call ${macro.qualified}`, 'End Sub', '');
  return lines.join('\r\n');
}

/** 割り当てる先 1 つ分。baseName は命名規則から決めた、呼び出し用の Sub の名前の案。 */
export interface AssignTarget {
  path: Path;
  attr: string;
  tag: string;
  baseName: string;
}

export interface WrapperPlan {
  /** 属性に書く名前（targets と同じ順）。 */
  assignments: { path: Path; attr: string; name: string }[];
  /** 作る呼び出し用の Sub。 */
  wrappers: { name: string; code: string }[];
  /** 名前が重なったので番号を付けたもの（案 → 実際）。 */
  renamed: [string, string][];
}

/**
 * 呼び出し用の Sub の名前と中身を決める。
 * - taken（VBA にすでにある名前・XML のほかの場所が使っている名前。大文字小文字は区別しない）と重なれば、番号を付けて避ける（Ribbon_x → Ribbon_x2）
 * - 同じ名前の案で、引数の形も同じ対象は、1 つの Sub を共有する（命名規則で Sub を共有する設定のとき）
 */
export function planWrappers(targets: readonly AssignTarget[], macro: MacroEntry, taken: ReadonlySet<string>): WrapperPlan {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const byKey = new Map<string, string>();
  const plan: WrapperPlan = { assignments: [], wrappers: [], renamed: [] };
  for (const tg of targets) {
    const key = `${tg.baseName.toLowerCase()}|${callbackSignature(tg.attr, tg.tag)}`;
    let name = byKey.get(key);
    if (name === undefined) {
      name = tg.baseName;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${tg.baseName}${n}`;
      if (name !== tg.baseName) plan.renamed.push([tg.baseName, name]);
      used.add(name.toLowerCase());
      byKey.set(key, name);
      plan.wrappers.push({ name, code: generateWrapper(name, tg.attr, tg.tag, macro) });
    }
    plan.assignments.push({ path: tg.path, attr: tg.attr, name });
  }
  return plan;
}

/**
 * 「引数の不一致」の指摘を、呼び出し用の Sub を作って直せるか。
 * onAction などに引数なしのマクロ名が直接書かれている（状態が mismatch で、見つかった Sub が割り当てられる形）ときだけ、その候補を返す。
 */
export function fixableMacro(status: CallbackStatus, moduleTypeOf: (module: string) => number, duplicated = false): MacroEntry | null {
  if (status.state !== 'mismatch' || !status.procedure || status.uses.length === 0) return null;
  if (!status.uses.every((u) => canWrapAttr(u.attr, u.tag))) return null;
  const entry = toMacroEntry(status.procedure, moduleTypeOf(status.procedure.module), duplicated);
  return entry.assignable ? entry : null;
}
