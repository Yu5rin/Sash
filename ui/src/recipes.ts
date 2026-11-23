// レシピ（仕様書 §9.2）。よく使う構成を、XML と VBA のセットで挿入する。
// 挿入先のファイルと id が重なる場合は、id とそれを含むコールバック名・VBA の識別子をまとめて振り直す。

import { childElements, createElement, ensureTabs, importElement, parseXml, pathOf, usedIds, type Path } from './model';
import { NAMESPACES } from './schema';
import { parseProcedures, procedureCode } from './vba';
import { t } from './i18n';

export interface Recipe {
  id: string;
  title: string;
  description: string;
  /** 挿入する要素の種類。tab はタブ一覧に、group は選択中のタブに入る。 */
  kind: 'tab' | 'group';
  /** 名前空間なしの XML 断片（要素1つ）。 */
  xml: string;
  /**
   * 標準モジュールに入れる VBA。既存のモジュールの末尾に足すので、モジュールレベルの宣言（Private 変数・Const・Option）は書かない。
   * 宣言が Sub の後ろに来ると、VBA はコンパイルエラーになるため。状態は Static 変数を持つ Function で保持する。
   */
  vba: string;
  /** ThisWorkbook に入れる VBA（イベント処理）。 */
  workbookVba?: string;
  /** IRibbonUI の保持（onLoad と共通コード）が必要か。 */
  needsRibbon?: boolean;
  /** 利用者が保存したレシピか。 */
  custom?: boolean;
}

const CRLF = '\r\n';
const vb = (...lines: string[]) => lines.join(CRLF) + CRLF;

export const builtinRecipes: readonly Recipe[] = [
  {
    id: 'basic-tab',
    title: '独自タブ＋グループ＋ボタン3つ',
    description: '新しいタブに、大きいボタン1つと小さいボタン2つを並べます。',
    kind: 'tab',
    xml: `<tab id="tabTools" label="ツール">
  <group id="grpMain" label="メイン">
    <button id="btnRun" label="実行" size="large" imageMso="MacroPlay" onAction="Ribbon_btnRun_onAction" />
    <button id="btnClear" label="クリア" imageMso="Clear" onAction="Ribbon_btnClear_onAction" />
    <button id="btnSettings" label="設定" imageMso="ControlProperties" onAction="Ribbon_btnSettings_onAction" />
  </group>
</tab>`,
    vba: vb(
      'Public Sub Ribbon_btnRun_onAction(control As IRibbonControl)',
      '    MsgBox "実行します"',
      'End Sub',
      '',
      'Public Sub Ribbon_btnClear_onAction(control As IRibbonControl)',
      '    MsgBox "クリアします"',
      'End Sub',
      '',
      'Public Sub Ribbon_btnSettings_onAction(control As IRibbonControl)',
      '    MsgBox "設定を開きます"',
      'End Sub',
    ),
  },
  {
    id: 'home-group',
    title: 'ホームタブの末尾に自分のグループを追加',
    description: '組み込みのホームタブの最後に、自分のグループを足します。',
    kind: 'tab',
    xml: `<tab idMso="TabHome">
  <group id="grpMyTools" label="マイツール">
    <button id="btnMyTool" label="マイツール" size="large" imageMso="HappyFace" onAction="Ribbon_btnMyTool_onAction" />
  </group>
</tab>`,
    vba: vb('Public Sub Ribbon_btnMyTool_onAction(control As IRibbonControl)', '    MsgBox "マイツールを実行します"', 'End Sub'),
  },
  {
    id: 'toggle-state',
    title: '状態を保持するトグルボタン',
    description: 'getPressed で押された状態を返し、変わったら Invalidate で表示を更新します。',
    kind: 'group',
    needsRibbon: true,
    xml: `<group id="grpMode" label="モード">
  <toggleButton id="tglAuto" label="自動" size="large" imageMso="AutoFilter" getPressed="Ribbon_tglAuto_getPressed" onAction="Ribbon_tglAuto_onAction" />
</group>`,
    vba: vb(
      "' 押された状態を持つ。モジュールの先頭に変数を置かずに済むよう、Static 変数で保持する",
      'Private Function State_tglAuto(Optional ByVal newValue As Variant) As Boolean',
      '    Static pressed As Boolean',
      '    If Not IsMissing(newValue) Then pressed = CBool(newValue)',
      '    State_tglAuto = pressed',
      'End Function',
      '',
      'Public Sub Ribbon_tglAuto_getPressed(control As IRibbonControl, ByRef returnedVal)',
      '    returnedVal = State_tglAuto()',
      'End Sub',
      '',
      'Public Sub Ribbon_tglAuto_onAction(control As IRibbonControl, pressed As Boolean)',
      '    State_tglAuto pressed',
      '    InvalidateRibbon "tglAuto"',
      'End Sub',
    ),
  },
  {
    id: 'conditional-enabled',
    title: '条件で有効・無効を切り替えるボタン',
    description: '複数のセルを選んでいるときだけ押せるボタンです。選択が変わるたびに getEnabled を呼び直します。',
    kind: 'group',
    needsRibbon: true,
    xml: `<group id="grpRange" label="範囲">
  <button id="btnRange" label="範囲を処理" size="large" imageMso="TableSelect" getEnabled="Ribbon_btnRange_getEnabled" onAction="Ribbon_btnRange_onAction" />
</group>`,
    vba: vb(
      'Public Sub Ribbon_btnRange_getEnabled(control As IRibbonControl, ByRef returnedVal)',
      '    returnedVal = False',
      '    If TypeName(Selection) = "Range" Then returnedVal = (Selection.Cells.CountLarge > 1)',
      'End Sub',
      '',
      'Public Sub Ribbon_btnRange_onAction(control As IRibbonControl)',
      '    MsgBox Selection.Address(False, False) & " を処理します"',
      'End Sub',
    ),
    workbookVba: vb(
      "' 選択が変わったら、ボタンの有効・無効を判定し直す",
      'Private Sub Workbook_SheetSelectionChange(ByVal Sh As Object, ByVal Target As Range)',
      '    InvalidateRibbon "btnRange"',
      'End Sub',
    ),
  },
  {
    id: 'sheet-menu',
    title: 'シート名から中身を作る dynamicMenu',
    description: 'メニューを開くたびにシートの一覧を作り、選んだシートへ移動します。',
    kind: 'group',
    xml: `<group id="grpSheets" label="シート">
  <dynamicMenu id="dmnSheets" label="シートへ移動" size="large" imageMso="SheetInsert" getContent="Ribbon_dmnSheets_getContent" invalidateContentOnDrop="true" />
</group>`,
    vba: vb(
      'Public Sub Ribbon_dmnSheets_getContent(control As IRibbonControl, ByRef content)',
      '    Dim xml As String, ws As Worksheet, i As Long',
      '    xml = "<menu xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">"',
      '    For Each ws In ActiveWorkbook.Worksheets',
      '        i = i + 1',
      '        xml = xml & "<button id=""dmnSheets_" & i & """ label=""" & EscapeXml_dmnSheets(ws.Name) & """ tag=""" & EscapeXml_dmnSheets(ws.Name) & """ onAction=""Ribbon_dmnSheets_item_onAction"" />"',
      '    Next',
      '    content = xml & "</menu>"',
      'End Sub',
      '',
      'Public Sub Ribbon_dmnSheets_item_onAction(control As IRibbonControl)',
      '    ActiveWorkbook.Worksheets(control.Tag).Activate',
      'End Sub',
      '',
      'Private Function EscapeXml_dmnSheets(ByVal s As String) As String',
      '    s = Replace(s, "&", "&amp;")',
      '    s = Replace(s, "<", "&lt;")',
      '    s = Replace(s, ">", "&gt;")',
      '    EscapeXml_dmnSheets = Replace(s, """", "&quot;")',
      'End Function',
    ),
  },
  {
    id: 'vba-dropdown',
    title: '選択肢をVBAで組み立てる dropDown',
    description: '選択肢の数・ラベル・選択中の項目をVBAで返す dropDown です。',
    kind: 'group',
    xml: `<group id="grpTarget" label="出力先">
  <dropDown id="ddnTarget" label="出力先" getItemCount="Ribbon_ddnTarget_getItemCount" getItemLabel="Ribbon_ddnTarget_getItemLabel" getSelectedItemIndex="Ribbon_ddnTarget_getSelectedItemIndex" onAction="Ribbon_ddnTarget_onAction" />
</group>`,
    vba: vb(
      "' 選択中の項目の番号を持つ。モジュールの先頭に変数を置かずに済むよう、Static 変数で保持する",
      'Private Function Index_ddnTarget(Optional ByVal newValue As Variant) As Long',
      '    Static index As Long',
      '    If Not IsMissing(newValue) Then index = CLng(newValue)',
      '    Index_ddnTarget = index',
      'End Function',
      '',
      'Private Function Items_ddnTarget() As Variant',
      '    Items_ddnTarget = Array("新しいシート", "このシート", "CSVファイル")',
      'End Function',
      '',
      'Public Sub Ribbon_ddnTarget_getItemCount(control As IRibbonControl, ByRef count)',
      '    count = UBound(Items_ddnTarget()) + 1',
      'End Sub',
      '',
      'Public Sub Ribbon_ddnTarget_getItemLabel(control As IRibbonControl, index As Integer, ByRef returnedVal)',
      '    returnedVal = Items_ddnTarget()(index)',
      'End Sub',
      '',
      'Public Sub Ribbon_ddnTarget_getSelectedItemIndex(control As IRibbonControl, ByRef returnedVal)',
      '    returnedVal = Index_ddnTarget()',
      'End Sub',
      '',
      'Public Sub Ribbon_ddnTarget_onAction(control As IRibbonControl, id As String, index As Integer)',
      '    Index_ddnTarget index',
      'End Sub',
    ),
  },
  {
    id: 'sheet-tab',
    title: '特定のシートでだけ表示するタブ',
    description: '「集計」シートを開いているときだけ表示されるタブです。シートを切り替えるたびに getVisible を呼び直します（xlsm向け）。',
    kind: 'tab',
    needsRibbon: true,
    xml: `<tab id="tabSheetOnly" label="集計シート" getVisible="Ribbon_tabSheetOnly_getVisible">
  <group id="grpSheetOnly" label="集計">
    <button id="btnSheetOnly" label="集計する" size="large" imageMso="AutoSum" onAction="Ribbon_btnSheetOnly_onAction" />
  </group>
</tab>`,
    vba: vb(
      'Public Sub Ribbon_tabSheetOnly_getVisible(control As IRibbonControl, ByRef returnedVal)',
      "    ' 表示するシートの名前（定数はモジュールの先頭ではなく、この Sub の中に置く）",
      '    Const SheetName_tabSheetOnly As String = "集計"',
      '    returnedVal = False',
      '    If Not ActiveSheet Is Nothing Then returnedVal = (ActiveSheet.Name = SheetName_tabSheetOnly)',
      'End Sub',
      '',
      'Public Sub Ribbon_btnSheetOnly_onAction(control As IRibbonControl)',
      '    MsgBox "集計します"',
      'End Sub',
    ),
    workbookVba: vb(
      "' シートを切り替えたら、タブの表示を判定し直す",
      'Private Sub Workbook_SheetActivate(ByVal Sh As Object)',
      '    InvalidateRibbon "tabSheetOnly"',
      'End Sub',
    ),
  },
];

export interface Instance {
  element: Element;
  vba: string;
  /** ThisWorkbook に足す VBA。既存の同名のイベント処理と重なるものは除いてある（workbookVbaConflicts を参照）。 */
  workbookVba: string;
  /**
   * ThisWorkbook にすでにある（existingVbaNames に含まれる）ためレシピから除いたイベント処理の名前
   * （例：Workbook_SheetSelectionChange）。同じ名前の Sub を2つ書くとコンパイルエラーになるので、
   * 利用者に既存の Sub へ workbookVbaConflictCode の行を足してもらう。
   */
  workbookVbaConflicts: string[];
  /** workbookVbaConflicts の名前ごとに、既存の Sub の中に足してほしい行（宣言と End Sub を除いた中身）。 */
  workbookVbaConflictCode: Record<string, string>;
  /** 振り直した id（元 → 新）。 */
  renamed: Map<string, string>;
  /** VBA の既存の Sub と重なったため振り直した、レシピの Sub / Function の名前（元 → 新）。 */
  renamedProcedures: Map<string, string>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 英数字に挟まれていない位置だけを置き換える（Ribbon_btnRun_onAction の btnRun は置き換え、btnRunAll は置き換えない）。 */
export function replaceIdentifier(text: string, from: string, to: string): string {
  return replaceIdentifiers(text, new Map([[from, to]]));
}

/**
 * 複数の名前を1回でまとめて置き換える。順に置き換えると、btnRun → btnRun2 のあとで btnRun2 → btnRun3 が
 * 連鎖してしまうため。境界は「文字・数字に挟まれていない」位置（_ は境界とみなす：Ribbon_btnRun_onAction の btnRun）。
 * wholeWord を true にすると _ も名前の一部として扱う（Sub 名そのものを置き換えるとき）。
 */
export function replaceIdentifiers(text: string, map: ReadonlyMap<string, string>, wholeWord = false): string {
  if (map.size === 0) return text;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const word = wholeWord ? String.raw`[\p{L}\p{N}_]` : String.raw`[\p{L}\p{N}]`;
  const re = new RegExp(`(?<!${word})(?:${keys.map(escapeRe).join('|')})(?!${word})`, wholeWord ? 'giu' : 'gu');
  const lower = new Map([...map].map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(re, (m) => map.get(m) ?? lower.get(m.toLowerCase()) ?? m);
}

/** name が、既存の VBA の名前のどれかに「識別子の境界で」含まれるか（大文字小文字は区別しない）。 */
function containedInAny(name: string, names: readonly string[]): boolean {
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRe(name)}(?![\p{L}\p{N}])`, 'iu');
  return names.some((n) => re.test(n));
}

/** VBA のコードから、指定の Sub / Function を宣言から End まで取り除く。 */
function removeProcedure(code: string, name: string): { code: string; body: string } {
  const mod = { name: 'ThisWorkbook', type: 100, code };
  const proc = parseProcedures(mod).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!proc) return { code, body: '' };
  const lines = code.split(/\r?\n/);
  const block = procedureCode(mod, proc).replace(/\r\n$/, '').split('\r\n');
  // 直前のコメント行（説明）も一緒に外す
  let start = proc.line - 1;
  while (start > 0 && /^\s*'/.test(lines[start - 1]!)) start--;
  lines.splice(start, proc.line - 1 - start + block.length);
  const body = block.slice(1, -1).join(CRLF);
  return { code: lines.join(CRLF).replace(/^(\r\n)+/, ''), body };
}

/**
 * レシピを、挿入先の文書で使える形にする。
 * - 文書の id と重なる id、既存の VBA の名前に含まれる id は振り直す（レシピ内の id もすべて予約してから決め、1回で置き換える）
 * - レシピの Sub / Function の名前が既存の VBA と重なれば、XML と VBA の両方で振り直す
 * - ThisWorkbook のイベント処理が既存のものと重なれば、足さずに workbookVbaConflicts で返す
 * - 文書が 2007 形式なら、VBA に書いた getContent 用の名前空間も 2007 のものにする
 */
export function instantiate(recipe: Recipe, doc: Document, existingVbaNames: ReadonlySet<string> = new Set()): Instance {
  const ns = doc.documentElement.namespaceURI ?? NAMESPACES.office2010;
  const used = usedIds(doc);
  const parsed = parseXml(`<customUI xmlns="${ns}">${recipe.xml}</customUI>`);
  if (!parsed.ok) throw new Error(t('レシピのXMLが壊れています：{message}', { message: parsed.message }));
  const existing = [...existingVbaNames];
  const existingLower = new Set(existing.map((n) => n.toLowerCase()));

  // 1. id の振り直し。レシピの id をすべて予約してから、重なるものだけ新しい名前を決める
  const recipeIds = Array.from(parsed.doc.querySelectorAll('[id]')).map((el) => el.getAttribute('id')!);
  const reserved = new Set([...used, ...recipeIds]);
  const renamed = new Map<string, string>();
  for (const id of new Set(recipeIds)) {
    if (!used.has(id) && !containedInAny(id, existing)) continue;
    let next = id;
    for (let n = 2; reserved.has(next) || containedInAny(next, existing); n++) next = `${id}${n}`;
    reserved.add(next);
    renamed.set(id, next);
  }
  let xml = replaceIdentifiers(recipe.xml, renamed);
  let vbaText = replaceIdentifiers(recipe.vba, renamed);
  let wbText = replaceIdentifiers(recipe.workbookVba ?? '', renamed);

  // 2. ThisWorkbook のイベント処理が既存のものと重なれば、足さずに中身だけを返す
  const workbookVbaConflicts: string[] = [];
  const workbookVbaConflictCode: Record<string, string> = {};
  for (const p of parseProcedures({ name: 'ThisWorkbook', type: 100, code: wbText })) {
    if (!existingLower.has(p.name.toLowerCase())) continue;
    const r = removeProcedure(wbText, p.name);
    wbText = r.code;
    workbookVbaConflicts.push(p.name);
    workbookVbaConflictCode[p.name] = r.body;
  }
  if (!/\S/.test(wbText)) wbText = '';

  // 3. 標準モジュールに入れる Sub / Function の名前が既存のものと重なれば振り直す（XML のコールバック名もそろえる）
  const recipeProcs = parseProcedures({ name: 'recipe', type: 1, code: vbaText }).map((p) => p.name);
  const taken = new Set([...existingLower, ...recipeProcs.map((n) => n.toLowerCase())]);
  const renamedProcedures = new Map<string, string>();
  for (const name of recipeProcs) {
    if (!existingLower.has(name.toLowerCase())) continue;
    let next = name;
    for (let n = 2; taken.has(next.toLowerCase()); n++) next = `${name}${n}`;
    taken.add(next.toLowerCase());
    renamedProcedures.set(name, next);
  }
  xml = replaceIdentifiers(xml, renamedProcedures, true);
  vbaText = replaceIdentifiers(vbaText, renamedProcedures, true);
  wbText = replaceIdentifiers(wbText, renamedProcedures, true);

  // 4. getContent で返す XML の名前空間を、挿入先のパーツの形式に合わせる
  if (ns !== NAMESPACES.office2010) vbaText = vbaText.split(NAMESPACES.office2010).join(ns);

  const final = parseXml(`<customUI xmlns="${ns}">${xml}</customUI>`);
  if (!final.ok) throw new Error(final.message);
  // 接頭辞つきの文書（<mso:customUI>）にも合うよう、文書の接頭辞で作り直して取り込む
  const element = importElement(doc, final.doc.documentElement.firstElementChild!);
  return { element, vba: vbaText, workbookVba: wbText, workbookVbaConflicts, workbookVbaConflictCode, renamed, renamedProcedures };
}

/**
 * 挿入する。タブはタブ一覧の末尾に（組み込みタブへの追加は、同じタブがあればそこにまとめる）、
 * グループは選択中のタブ（なければ最初の自作タブ、それもなければ新しいタブ）に入れる。
 */
export function insertInstance(doc: Document, inst: Instance, selection: Path | null, selected: Element | null): Path {
  const tabs = ensureTabs(doc);
  const el = inst.element;
  if (el.localName === 'tab') {
    const idMso = el.getAttribute('idMso');
    const existing = idMso ? childElements(tabs).find((t) => t.getAttribute('idMso') === idMso) : undefined;
    if (existing) {
      const groups = childElements(el);
      for (const g of groups) existing.append(g);
      return pathOf(groups[0] ?? existing);
    }
    tabs.append(el);
    return pathOf(el);
  }

  let tab: Element | null = selected;
  let after: Element | null = null;
  while (tab && tab.localName !== 'tab') {
    if (tab.localName === 'group') after = tab;
    tab = tab.parentElement;
  }
  if (!tab || !selection) tab = childElements(tabs).find((t) => t.hasAttribute('id')) ?? null;
  if (!tab) {
    tab = createElement(doc, 'tab');
    tabs.append(tab);
  }
  tab.insertBefore(el, after?.nextElementSibling ?? null);
  return pathOf(el);
}

/** 選択中の要素からレシピを作る（「レシピとして保存」）。 */
export function recipeFromElement(el: Element, title: string, description: string, vba: string): Recipe {
  // 接頭辞つきの文書（<mso:tab>）から作っても、名前空間なし・接頭辞なしの断片として保存する
  const holder = new DOMParser().parseFromString(`<customUI xmlns="${el.namespaceURI ?? NAMESPACES.office2010}"/>`, 'application/xml');
  const clone = importElement(holder, el);
  const xml = new XMLSerializer()
    .serializeToString(clone)
    .replace(/\sxmlns="[^"]*"/g, '');
  return {
    id: `custom-${Date.now()}`,
    title,
    description,
    kind: el.localName === 'tab' ? 'tab' : 'group',
    xml,
    vba,
    custom: true,
  };
}
