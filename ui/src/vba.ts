// VBA のコールバックの照合と生成（仕様書 §8）。
// VBA のコードはホスト経由で VBE から受け取り、ここで Sub の宣言を解析して XML 側と突き合わせる。

import { allElements, pathOf, type Path } from './model';
import { attributes, callbackSignature } from './schema';
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
    const m = /^\s*(?:(Public|Private|Friend)\s+)?(?:Static\s+)?(?:Sub|Function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)/i.exec(stripComment(text));
    if (m) {
      out.push({ module: module.name, name: m[2]!, params: m[3]!.trim(), line: start + 1, declaration: lines[start]!, isPrivate: (m[1] ?? '').toLowerCase() === 'private' });
    }
  }
  return out;
}

/** 文字列の外にある ' 以降を取り除く。 */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inString = !inString;
    else if (c === "'" && !inString) return line.slice(0, i);
  }
  return line;
}

interface Param {
  name: string;
  type: string;
  byVal: boolean;
  optional: boolean;
}

export function parseParams(params: string): Param[] {
  if (!params.trim()) return [];
  return params.split(',').map((raw) => {
    const p = raw.trim();
    const optional = /^Optional\s+/i.test(p);
    const rest = p.replace(/^Optional\s+/i, '');
    const byVal = /^ByVal\s+/i.test(rest);
    const body = rest.replace(/^(ByVal|ByRef)\s+/i, '');
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\(\))?(?:\s+As\s+([A-Za-z_][\w.]*))?/i.exec(body);
    const type = (m?.[3] ?? 'Variant').replace(/^Office\./i, '');
    return { name: m?.[1] ?? body, type: type.toLowerCase(), byVal, optional };
  });
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
    if (ep.type !== 'variant' && ap.type !== 'variant' && ep.type !== ap.type) {
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

  const result: CallbackStatus[] = [];
  for (const [name, list] of uses) {
    // "Module1.Name" や "Book.xlsm!Name" のような指定は、最後の名前で照合する
    const bare = name.replace(/^.*[.!]/, '');
    const expected = callbackSignature(list[0]!.attr, list[0]!.tag);
    const proc = byName.get(bare.toLowerCase());
    if (!modules) {
      result.push({ name, state: 'missing', uses: list, expected });
      continue;
    }
    if (!proc) {
      result.push({ name, state: 'missing', uses: list, expected });
      continue;
    }
    const reason = compareSignature(expected, proc.params) ?? (proc.isPrivate ? t('Private の Sub はリボンから呼べません') : null);
    result.push({ name, state: reason ? 'mismatch' : 'implemented', uses: list, expected, procedure: proc, reason: reason ?? undefined });
  }

  const usedNames = new Set([...uses.keys()].map((n) => n.replace(/^.*[.!]/, '').toLowerCase()));
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

export function callbackName(rule: NamingRule, id: string, attr: string, tag: string): string {
  if (tag === 'customUI') return `Ribbon_${attr}`;
  const raw = (rule.shared ? rule.sharedPattern : rule.pattern).replace(/\{id\}/g, id).replace(/\{attr\}/g, attr);
  return raw.replace(/[^A-Za-z0-9_]/g, '_');
}

/** 戻り値を返すコールバックの、型に合った既定値。 */
function defaultReturn(attr: string): string | null {
  if (/^get(Enabled|Visible|Pressed|ShowLabel|ShowImage)$/.test(attr)) return 'True';
  if (attr === 'getItemCount' || attr === 'getSelectedItemIndex' || attr === 'getItemWidth' || attr === 'getItemHeight') return '0';
  if (attr === 'getSize') return 'RibbonControlSize.RibbonControlSizeRegular';
  if (attr === 'getImage' || attr === 'getItemImage') return null;
  if (attr === 'getContent') return '"<menu xmlns=""http://schemas.microsoft.com/office/2009/07/customui""></menu>"';
  if (attr.startsWith('get')) return '""';
  return null;
}

/** VBA の雛形。共有 Sub のときは control.Id で振り分ける Select Case を入れる。 */
export function generateStub(status: Pick<CallbackStatus, 'name' | 'uses' | 'expected'>): string {
  const first = status.uses[0]!;
  const sig = status.expected || callbackSignature(first.attr, first.tag);
  const outParam = parseParams(sig).find((_p, i) => i > 0 && sig.split(',')[i]!.includes('ByRef'));
  const ret = defaultReturn(first.attr);
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
  const re = new RegExp(`^(\\s*(?:(?:Public|Private|Friend)\\s+)?(?:Static\\s+)?(?:Sub|Function)\\s+)${oldName}(\\s*\\()`, 'i');
  return declaration.replace(re, `$1${newName}$2`);
}

// ---- onLoad と Invalidate の雛形（仕様書 §8.3） ----

/**
 * IRibbonUI を保持し、VBA のエラーで変数がリセットされても名前定義に退避したポインタから復元する定番のコード。
 * 32bit / 64bit の両方の Office で動くよう、LongPtr と PtrSafe を使う。
 */
export const RIBBON_HOLDER_MODULE = [
  "' Sash が生成したリボン用の共通コード。",
  "' onLoad で受け取った IRibbonUI を保持し、エラーで変数が消えても復元できるようにする。",
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
  '#If VBA7 Then',
  '    ThisWorkbook.Names.Add Name:=POINTER_NAME, RefersTo:=CStr(CLngPtr(ObjPtr(ribbon))), Visible:=False',
  '#Else',
  '    ThisWorkbook.Names.Add Name:=POINTER_NAME, RefersTo:=CStr(CLng(ObjPtr(ribbon))), Visible:=False',
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
  '    Dim ptr As LongPtr',
  '    ptr = CLngPtr(text)',
  '#Else',
  '    Dim ptr As Long',
  '    ptr = CLng(text)',
  '#End If',
  '    Dim obj As Object',
  '    CopyMemory obj, ptr, LenB(ptr)',
  '    Set gRibbon = obj',
  '    CopyMemory obj, 0&, LenB(ptr)',
  '    Set GetRibbon = gRibbon',
  'End Function',
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
