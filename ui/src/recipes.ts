// レシピ（仕様書 §9.2）。よく使う構成を、XML と VBA のセットで挿入する。
// 挿入先のファイルと id が重なる場合は、id とそれを含むコールバック名・VBA の識別子をまとめて振り直す。

import { childElements, ensureTabs, parseXml, pathOf, suggestId, usedIds, type Path } from './model';
import { NAMESPACES } from './lint';
import { t } from './i18n';

export interface Recipe {
  id: string;
  title: string;
  description: string;
  /** 挿入する要素の種類。tab はタブ一覧に、group は選択中のタブに入る。 */
  kind: 'tab' | 'group';
  /** 名前空間なしの XML 断片（要素1つ）。 */
  xml: string;
  /** 標準モジュールに入れる VBA。 */
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
      'Private m_tglAuto As Boolean',
      '',
      'Public Sub Ribbon_tglAuto_getPressed(control As IRibbonControl, ByRef returnedVal)',
      '    returnedVal = m_tglAuto',
      'End Sub',
      '',
      'Public Sub Ribbon_tglAuto_onAction(control As IRibbonControl, pressed As Boolean)',
      '    m_tglAuto = pressed',
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
      'Private m_ddnTarget_index As Integer',
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
      '    returnedVal = m_ddnTarget_index',
      'End Sub',
      '',
      'Public Sub Ribbon_ddnTarget_onAction(control As IRibbonControl, id As String, index As Integer)',
      '    m_ddnTarget_index = index',
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
      'Private Const SheetName_tabSheetOnly As String = "集計"',
      '',
      'Public Sub Ribbon_tabSheetOnly_getVisible(control As IRibbonControl, ByRef returnedVal)',
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
  workbookVba: string;
  /** 振り直した id（元 → 新）。 */
  renamed: Map<string, string>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 英数字に挟まれていない位置だけを置き換える（Ribbon_btnRun_onAction の btnRun は置き換え、btnRunAll は置き換えない）。 */
export function replaceIdentifier(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(from)}(?![A-Za-z0-9])`, 'g'), to);
}

/** レシピを、挿入先の文書で使える形にする。重なる id は振り直す。 */
export function instantiate(recipe: Recipe, doc: Document, existingVbaNames: ReadonlySet<string> = new Set()): Instance {
  const ns = doc.documentElement.namespaceURI ?? NAMESPACES.office2010;
  const used = usedIds(doc);
  const parsed = parseXml(`<customUI xmlns="${ns}">${recipe.xml}</customUI>`);
  if (!parsed.ok) throw new Error(t('レシピのXMLが壊れています：{message}', { message: parsed.message }));

  const renamed = new Map<string, string>();
  let xml = recipe.xml;
  let vbaText = recipe.vba;
  let wbText = recipe.workbookVba ?? '';
  for (const el of Array.from(parsed.doc.querySelectorAll('[id]'))) {
    const id = el.getAttribute('id')!;
    const clashesVba = [...existingVbaNames].some((n) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`, 'i').test(n));
    if (!used.has(id) && !clashesVba) {
      used.add(id);
      continue;
    }
    let next = id;
    for (let n = 2; used.has(next) || [...existingVbaNames].some((v) => v.toLowerCase().includes(next.toLowerCase())); n++) next = `${id}${n}`;
    used.add(next);
    renamed.set(id, next);
  }
  for (const [from, to] of renamed) {
    xml = replaceIdentifier(xml, from, to);
    vbaText = replaceIdentifier(vbaText, from, to);
    wbText = replaceIdentifier(wbText, from, to);
  }

  const final = parseXml(`<customUI xmlns="${ns}">${xml}</customUI>`);
  if (!final.ok) throw new Error(final.message);
  const element = doc.importNode(final.doc.documentElement.firstElementChild!, true);
  return { element, vba: vbaText, workbookVba: wbText, renamed };
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
    tab = doc.createElementNS(doc.documentElement.namespaceURI, 'tab');
    tab.setAttribute('id', suggestId('tab', null, usedIds(doc)));
    tab.setAttribute('label', t('新しいタブ'));
    tabs.append(tab);
  }
  tab.insertBefore(el, after?.nextElementSibling ?? null);
  return pathOf(el);
}

/** 選択中の要素からレシピを作る（「レシピとして保存」）。 */
export function recipeFromElement(el: Element, title: string, description: string, vba: string): Recipe {
  const clone = el.cloneNode(true) as Element;
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
