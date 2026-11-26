// VBA のコールバックの照合と生成（仕様書 §8）。
// VBA のコードはホスト経由で VBE から受け取り、ここで Sub の宣言を解析して XML 側と突き合わせる。

import { allElements, pathOf, type Path } from './model';
import { attributes, callbackSignature, isVbaIdentifier, NAMESPACES } from './schema';
import { t } from './i18n';

export interface VbaModule {
  name: string;
  /** 1 = 標準モジュール、2 = クラス、3 = フォーム、100 = ドキュメント（ThisWorkbook / シート）。 */
  type: number;
  code: string;
}

export interface VbaProcedure {
  module: string;
  name: string;
  /** 引数リスト（括弧の中身）。 */
  params: string;
  /** 宣言がある行（1 始まり）。 */
  line: number;
  /** 宣言行の全文。 */
  declaration: string;
  isPrivate: boolean;
  /** Sub か Function か（Function は戻り値があり、リボンのボタンに直接は割り当てられない）。 */
  kind: 'sub' | 'function';
}

export type CallbackState = 'implemented' | 'missing' | 'mismatch' | 'unused';

export interface CallbackUse {
  attr: string;
  tag: string;
  id: string;
  path: Path;
}

export interface CallbackStatus {
  name: string;
  state: CallbackState;
  uses: CallbackUse[];
  /** XML 側から決まる正しい引数（VBA 側にしかないものは空）。 */
  expected: string;
  procedure?: VbaProcedure;
  /** 不一致の理由。 */
  reason?: string;
  /** 文書の名前空間（getContent の雛形で、パーツの形式に合う名前空間を書くため）。 */
  namespace?: string;
}

/** VBA の識別子に使える1文字（日本語などの文字も含む）。 */
const ID_CHAR = String.raw`[\p{L}\p{N}_]`;
const ID_WORD = String.raw`[\p{L}_][\p{L}\p{N}_]*`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** コールバック属性の値（"Module1.Name" や "Book.xlsm!Name" を含む）から、VBA の Sub 名の部分だけを取り出す。 */
export function bareCallbackName(name: string): string {
  return name.replace(/^.*[.!]/, '');
}

/** コールバック属性の値として使えるか（最後の名前が VBA の識別子であること）。インスペクタの入力チェックにも使う。 */
export function isCallbackName(name: string): boolean {
  const bare = bareCallbackName(name);
  const qualifier = name.slice(0, name.length - bare.length);
  return isVbaIdentifier(bare) && (qualifier === '' || (qualifier.length > 1 && !/["\r\n]/.test(qualifier)));
}

// ---- 解析 ----

/** 行継続（行末の " _"）をつなげたうえで、Sub / Function の宣言を拾う。 */
export function parseProcedures(module: VbaModule): VbaProcedure[] {
  const lines = module.code.split(/\r?\n/);
  const out: VbaProcedure[] = [];
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]!;
    const start = i;
    while (/\s_\s*$/.test(text) && i + 1 < lines.length) {
      text = text.replace(/\s_\s*$/, ' ') + lines[++i]!.trim();
    }
    const m = new RegExp(String.raw`^\s*(?:(Public|Private|Friend)\s+)?(?:Static\s+)?(Sub|Function)\s+(${ID_WORD})\s*\((.*)\)`, 'iu').exec(stripComment(text));
    if (m) {
      out.push({ module: module.name, name: m[3]!, params: m[4]!.trim(), line: start + 1, declaration: lines[start]!, isPrivate: (m[1] ?? '').toLowerCase() === 'private', kind: m[2]!.toLowerCase() === 'function' ? 'function' : 'sub' });
    }
  }
  return out;
}

/** 文字列の外にある ' 以降を取り除く。 */
export function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inString = !inString;
    else if (c === "'" && !inString) return line.slice(0, i);
  }
  return line;
}

export interface Param {
  name: string;
  type: string;
  byVal: boolean;
  optional: boolean;
  /** 配列（name()）か ParamArray か。 */
  array: boolean;
}

/** 引数リストを、括弧と文字列の外にあるカンマで分ける（既定値の Array(1, 2) を分けないため）。 */
export function splitParams(params: string): string[] {
  if (!params.trim()) return [];
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let from = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === '"') inString = !inString;
    else if (!inString && c === '(') depth++;
    else if (!inString && c === ')') depth--;
    else if (!inString && depth === 0 && c === ',') {
      out.push(params.slice(from, i));
      from = i + 1;
    }
  }
  out.push(params.slice(from));
  return out;
}

export function parseParams(params: string): Param[] {
  return splitParams(params).map((raw) => {
    const p = raw.trim();
    const optional = /^Optional\s+/i.test(p);
    const rest = p.replace(/^Optional\s+/i, '');
    const byVal = /^ByVal\s+/i.test(rest);
    const body = rest.replace(/^(ByVal|ByRef)\s+/i, '');
    const paramArray = /^ParamArray\s+/i.test(body);
    const m = new RegExp(String.raw`^(${ID_WORD})(\s*\(\s*\))?(?:\s+As\s+([\p{L}_][\p{L}\p{N}_.]*))?`, 'iu').exec(body.replace(/^ParamArray\s+/i, ''));
    const type = (m?.[3] ?? 'Variant').replace(/^Office\./i, '');
    return { name: m?.[1] ?? body, type: type.toLowerCase(), byVal, optional, array: paramArray || !!m?.[2] };
  });
}

/**
 * 型が実用上かみ合うか。番号の引数（index As Integer）は Long / LongPtr でも受け取れ、
 * IRibbonControl / IRibbonUI は Object でも受け取れるので、どちらも一致とみなす。
 */
const NUMERIC = new Set(['integer', 'long', 'longptr', 'longlong', 'byte', 'single', 'double', 'currency']);
function compatibleType(expected: string, actual: string): boolean {
  if (expected === 'variant' || actual === 'variant' || expected === actual) return true;
  if (NUMERIC.has(expected) && NUMERIC.has(actual)) return true;
  if ((expected === 'iribboncontrol' || expected === 'iribbonui') && actual === 'object') return true;
  return false;
}

/** 引数が XML 側の期待と合っているか。合わなければ理由を返す。 */
export function compareSignature(expected: string, actual: string): string | null {
  const e = parseParams(expected);
  const a = parseParams(actual).filter((p) => !p.optional);
  if (e.length !== a.length) return t('引数の数が違います（必要：{expected}、実際：{actual}）', { expected: e.length, actual: a.length });
  for (let i = 0; i < e.length; i++) {
    const ep = e[i]!;
    const ap = a[i]!;
    // 型を書いていない（Variant）引数は、どの型でも受け取れるので一致とみなす
    if (!compatibleType(ep.type, ap.type)) {
      return t('{n}番目の引数の型が違います（必要：{expected}、実際：{actual}）', { n: i + 1, expected: ep.type, actual: ap.type });
    }
    // 値を返す引数（ByRef returnedVal など）を ByVal にすると、値が Excel に戻らない
    if (expected.split(',')[i]!.includes('ByRef') && ap.byVal) {
      return t('{n}番目の引数は ByRef にしてください（ByVal だと値が返りません）', { n: i + 1 });
    }
  }
  return null;
}

/** リボンのコールバックらしい Sub か（VBA 側にしかない未使用のものを拾うため）。 */
function looksLikeCallback(p: VbaProcedure): boolean {
  const first = parseParams(p.params)[0];
  return first !== undefined && (first.type === 'iribboncontrol' || first.type === 'iribbonui');
}

// ---- 照合 ----

export function collectCallbackUses(doc: Document): Map<string, CallbackUse[]> {
  const map = new Map<string, CallbackUse[]>();
  for (const el of allElements(doc)) {
    for (const at of Array.from(el.attributes)) {
      if (attributes.get(at.name)?.kind !== 'callback' || !at.value) continue;
      const use: CallbackUse = { attr: at.name, tag: el.localName, id: el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName, path: pathOf(el) };
      map.set(at.value, [...(map.get(at.value) ?? []), use]);
    }
  }
  return map;
}

/**
 * XML 側のコールバックと VBA 側の Sub を突き合わせる。
 * modules が null のときは VBA を読めていない（Excel で開いていない、または信頼設定がオフ）。
 */
export function matchCallbacks(doc: Document, modules: VbaModule[] | null): CallbackStatus[] {
  const uses = collectCallbackUses(doc);
  const procs = modules ? modules.flatMap(parseProcedures) : [];
  const byName = new Map<string, VbaProcedure>();
  for (const p of procs) {
    // マクロ名の照合は大文字小文字を区別しない。標準モジュールのものを優先する
    const key = p.name.toLowerCase();
    const mod = modules!.find((m) => m.name === p.module);
    if (!byName.has(key) || mod?.type === 1) byName.set(key, p);
  }

  const namespace = doc.documentElement.namespaceURI ?? undefined;
  const result: CallbackStatus[] = [];
  for (const [name, list] of uses) {
    // "Module1.Name" や "Book.xlsm!Name" のような指定は、最後の名前で照合する
    const bare = bareCallbackName(name);
    const expected = callbackSignature(list[0]!.attr, list[0]!.tag);
    // 1つの Sub を、引数の違うコントロールで共有している（button の onAction と toggleButton の onAction など）。
    // どちらかは必ず実行時エラーになるので、VBA を読めなくても不一致として知らせる
    const conflict = list.find((u) => compareSignature(expected, callbackSignature(u.attr, u.tag)) !== null);
    if (conflict) {
      const kinds = [...new Set(list.map((u) => `${u.tag}.${u.attr}`))].join(t('、'));
      const reason = t('引数の違うコントロール（{kinds}）で同じ Sub を共有しています。Sub を分けてください', { kinds });
      result.push({ name, state: 'mismatch', uses: list, expected, procedure: byName.get(bare.toLowerCase()), reason, namespace });
      continue;
    }
    const proc = byName.get(bare.toLowerCase());
    if (!modules || !proc) {
      result.push({ name, state: 'missing', uses: list, expected, namespace });
      continue;
    }
    const reason = compareSignature(expected, proc.params) ?? (proc.isPrivate ? t('Private の Sub はリボンから呼べません') : null);
    result.push({ name, state: reason ? 'mismatch' : 'implemented', uses: list, expected, procedure: proc, reason: reason ?? undefined, namespace });
  }

  const usedNames = new Set([...uses.keys()].map((n) => bareCallbackName(n).toLowerCase()));
  for (const p of procs) {
    if (looksLikeCallback(p) && !usedNames.has(p.name.toLowerCase())) {
      result.push({ name: p.name, state: 'unused', uses: [], expected: '', procedure: p });
    }
  }

  const order: Record<CallbackState, number> = { mismatch: 0, missing: 1, implemented: 2, unused: 3 };
  return result.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
}

// ---- 生成 ----

export interface NamingRule {
  /** 個別の Sub にするときの名前。{id} と {attr} を置き換える。 */
  pattern: string;
  /** 複数のコントロールで1つの Sub を共有し、control.Id で振り分ける。 */
  shared: boolean;
  /** 共有するときの名前。{attr} を置き換える。 */
  sharedPattern: string;
}

export const DEFAULT_NAMING: NamingRule = { pattern: 'Ribbon_{id}_{attr}', shared: false, sharedPattern: 'Ribbon_{attr}' };

/**
 * 共有 Sub の名前に付ける、引数の種類の印。同じ属性でも要素によって引数が違う（button と toggleButton の onAction など）ので、
 * 標準（button のとき）と違う引数なら、追加の引数名から印を作る（例：pressed → Pressed、id と index → IdIndex）。
 */
export function signatureSuffix(attr: string, tag: string): string {
  const sig = callbackSignature(attr, tag);
  if (sig === callbackSignature(attr, 'button')) return '';
  return parseParams(sig)
    .filter((p) => p.type !== 'iribboncontrol')
    .map((p) => p.name[0]!.toUpperCase() + p.name.slice(1))
    .join('');
}

/**
 * 命名規則からコールバック名を作る。VBA の識別子に使えない文字（- や . など）だけを _ にし、日本語などの文字は残す。
 * taken を渡すと、その名前（大文字小文字は区別しない）と重ならないよう末尾に番号を付ける
 * （btn-a と btn.a のように、置き換えると同じ名前になる id を区別するため）。共有 Sub のときは重ねるのが目的なので番号を付けない。
 */
export function callbackName(rule: NamingRule, id: string, attr: string, tag: string, taken?: ReadonlySet<string>): string {
  if (tag === 'customUI') return `Ribbon_${attr}`;
  let raw = (rule.shared ? rule.sharedPattern : rule.pattern).replace(/\{id\}/g, id).replace(/\{attr\}/g, attr);
  if (rule.shared) {
    const suffix = signatureSuffix(attr, tag);
    if (suffix) raw += `_${suffix}`;
  }
  let name = raw.replace(/[^\p{L}\p{N}_]/gu, '_');
  // VBA の名前は文字で始める必要がある
  if (!/^\p{L}/u.test(name)) name = `Ribbon_${name}`;
  if (rule.shared || !taken) return name;
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!lower.has(`${name}${n}`.toLowerCase())) return `${name}${n}`;
}

/** 戻り値を返すコールバックの、型に合った既定値。namespace は getContent で返す XML の名前空間（パーツの形式に合わせる）。 */
function defaultReturn(attr: string, namespace: string = NAMESPACES.office2010): string | null {
  if (/^get(Enabled|Visible|Pressed|ShowLabel|ShowImage)$/.test(attr)) return 'True';
  if (attr === 'getItemCount' || attr === 'getSelectedItemIndex' || attr === 'getItemWidth' || attr === 'getItemHeight') return '0';
  if (attr === 'getSize') return 'RibbonControlSize.RibbonControlSizeRegular';
  if (attr === 'getImage' || attr === 'getItemImage') return null;
  if (attr === 'getContent') return `"<menu xmlns=""${namespace}""></menu>"`;
  if (attr.startsWith('get')) return '""';
  return null;
}

/** VBA の雛形。共有 Sub のときは control.Id で振り分ける Select Case を入れる。 */
export function generateStub(status: Pick<CallbackStatus, 'name' | 'uses' | 'expected' | 'namespace'>): string {
  const first = status.uses[0]!;
  const sig = status.expected || callbackSignature(first.attr, first.tag);
  const outParam = parseParams(sig).find((_p, i) => i > 0 && sig.split(',')[i]!.includes('ByRef'));
  const ret = defaultReturn(first.attr, status.namespace);
  const body: string[] = [];
  const ids = [...new Set(status.uses.map((u) => u.id))];
  if (first.attr === 'onLoad') {
    body.push('    Set gRibbon = ribbon');
    body.push('    SaveRibbonPointer ribbon');
  } else if (ids.length > 1 && first.attr !== 'onLoad') {
    body.push('    Select Case control.Id');
    for (const id of ids) {
      body.push(`    Case "${id}"`);
      body.push(outParam && ret !== null ? `        ${outParam.name} = ${ret}` : `        ' TODO: ${id} の処理`);
    }
    body.push('    End Select');
  } else if (outParam) {
    body.push(ret !== null ? `    ${outParam.name} = ${ret}` : `    ' TODO: ${outParam.name} に値を設定する`);
  } else {
    body.push(`    ' TODO: ${ids.join(', ')}.${first.attr} の処理`);
  }
  return [`Public Sub ${status.name}(${sig})`, ...body, 'End Sub', ''].join('\r\n');
}

/** 宣言行の Sub 名だけを置き換える（仕様書 §8.2：宣言行だけを書き換える）。 */
export function renameDeclaration(declaration: string, oldName: string, newName: string): string {
  // 名前は正規表現の特殊文字を含みうるのでエスケープし、日本語の名前も扱えるよう u フラグで照合する
  const re = new RegExp(String.raw`^(\s*(?:(?:Public|Private|Friend)\s+)?(?:Static\s+)?(?:Sub|Function)\s+)${escapeRe(oldName)}(?!${ID_CHAR})(\s*\()`, 'iu');
  return declaration.replace(re, (_m, head: string, tail: string) => `${head}${newName}${tail}`);
}

// ---- onLoad と Invalidate の雛形（仕様書 §8.3） ----

/**
 * IRibbonUI を保持し、VBA のエラーで変数がリセットされても名前定義に退避したポインタから復元する定番のコード。
 * 32bit / 64bit の両方の Office で動くよう、LongPtr と PtrSafe を使う。
 */
export const RIBBON_HOLDER_MODULE = [
  "' Sash が生成したリボン用の共通コード。",
  "' onLoad で受け取った IRibbonUI を保持し、エラーで変数が消えても復元できるようにする。",
  "' ※ポインタからの復元は定番の手法だが、Sash としては実機の Excel（32bit / 64bit）での動作をまだ確かめていない。",
  'Option Explicit',
  '',
  '#If VBA7 Then',
  '    Private Declare PtrSafe Sub CopyMemory Lib "kernel32" Alias "RtlMoveMemory" (ByRef Destination As Any, ByRef Source As Any, ByVal Length As LongPtr)',
  '#Else',
  '    Private Declare Sub CopyMemory Lib "kernel32" Alias "RtlMoveMemory" (ByRef Destination As Any, ByRef Source As Any, ByVal Length As Long)',
  '#End If',
  '',
  'Private Const POINTER_NAME As String = "SashRibbonPointer"',
  'Public gRibbon As IRibbonUI',
  '',
  "' onLoad から呼ぶ。ポインタを非表示の名前定義に退避する",
  'Public Sub SaveRibbonPointer(ByVal ribbon As IRibbonUI)',
  '    On Error Resume Next',
  '    ThisWorkbook.Names(POINTER_NAME).Delete',
  '    On Error GoTo 0',
  "    ' 先頭に = を付けて数式（数値）として登録する。= がないと文字列の定数になり、読み戻すときに引用符が混じる",
  '#If VBA7 Then',
  '    ThisWorkbook.Names.Add Name:=POINTER_NAME, RefersTo:="=" & CStr(CLngPtr(ObjPtr(ribbon))), Visible:=False',
  '#Else',
  '    ThisWorkbook.Names.Add Name:=POINTER_NAME, RefersTo:="=" & CStr(CLng(ObjPtr(ribbon))), Visible:=False',
  '#End If',
  'End Sub',
  '',
  "' IRibbonUI を返す。変数が消えていれば名前定義から復元する",
  'Public Function GetRibbon() As IRibbonUI',
  '    If Not gRibbon Is Nothing Then',
  '        Set GetRibbon = gRibbon',
  '        Exit Function',
  '    End If',
  '    Dim text As String',
  '    On Error Resume Next',
  '    text = Mid$(ThisWorkbook.Names(POINTER_NAME).RefersTo, 2)',
  '    On Error GoTo 0',
  '    If Len(text) = 0 Then Exit Function',
  '#If VBA7 Then',
  '    Dim ptr As LongPtr, zero As LongPtr',
  '    ptr = CLngPtr(text)',
  '#Else',
  '    Dim ptr As Long, zero As Long',
  '    ptr = CLng(text)',
  '#End If',
  '    Dim obj As Object',
  '    CopyMemory obj, ptr, LenB(ptr)',
  '    Set gRibbon = obj',
  "    ' 参照カウントを増やさずに作った参照なので、解放される前にゼロで消す。",
  "    ' 64bit では 0& だと 4 バイトしかなく、残りの 4 バイトに余計な値を読むので、ポインタと同じ型の変数を使う",
  '    CopyMemory obj, zero, LenB(ptr)',
  '    Set GetRibbon = gRibbon',
  'End Function',
  '',
  "' Sash の反映（F5）のあとで、指定のタブを前面に出す（Sash から Application.Run で呼ばれる）",
  'Public Sub SashActivateTab(ByVal tabId As String)',
  '    Dim ribbon As IRibbonUI',
  '    Set ribbon = GetRibbon()',
  '    If ribbon Is Nothing Then Exit Sub',
  '    On Error Resume Next',
  '    ribbon.ActivateTab tabId',
  'End Sub',
  '',
  "' コントロールの状態を作り直す。id を省略するとリボン全体",
  'Public Sub InvalidateRibbon(Optional ByVal controlId As String = "")',
  '    Dim ribbon As IRibbonUI',
  '    Set ribbon = GetRibbon()',
  '    If ribbon Is Nothing Then Exit Sub',
  '    If Len(controlId) = 0 Then',
  '        ribbon.Invalidate',
  '    Else',
  '        ribbon.InvalidateControl controlId',
  '    End If',
  'End Sub',
  '',
].join('\r\n');

export const RIBBON_HOLDER_MODULE_NAME = 'modRibbonCore';

/** 指定のパスの要素が使っているコールバック名（リネーム連動に使う）。 */
export function callbacksAt(doc: Document, path: Path): { attr: string; name: string }[] {
  const el = allElements(doc).find((e) => {
    const p = pathOf(e);
    return p.length === path.length && p.every((v, i) => v === path[i]);
  });
  if (!el) return [];
  return Array.from(el.attributes)
    .filter((a) => attributes.get(a.name)?.kind === 'callback')
    .map((a) => ({ attr: a.name, name: a.value }));
}

/** モジュールから、指定の Sub / Function の本体（宣言から End まで）を取り出す。 */
export function procedureCode(module: VbaModule, proc: VbaProcedure): string {
  const lines = module.code.split(/\r?\n/);
  const out: string[] = [];
  for (let i = proc.line - 1; i < lines.length; i++) {
    out.push(lines[i]!);
    if (/^\s*End\s+(Sub|Function)\b/i.test(lines[i]!)) break;
  }
  return out.join('\r\n') + '\r\n';
}
