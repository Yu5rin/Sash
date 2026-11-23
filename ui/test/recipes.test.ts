import { describe, expect, it } from 'vitest';
import { parseXml, serialize } from '../src/model';
import { builtinRecipes, insertInstance, instantiate, recipeFromElement, replaceIdentifier, type Recipe } from '../src/recipes';
import { parseProcedures } from '../src/vba';
import { lint } from '../src/lint';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';

function doc(body = ''): Document {
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs>${body}</tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

const recipe = (id: string) => builtinRecipes.find((r) => r.id === id)!;

describe('レシピ', () => {
  it('すべての組み込みレシピは単体で Lint のエラーが出ない', () => {
    for (const r of builtinRecipes) {
      const d = doc();
      const inst = instantiate(r, d);
      insertInstance(d, inst, null, null);
      const errors = lint(d, { version: 'office2010', imageIds: new Set(), knownIdMso: new Set(), missingImageMso: new Set() }).filter((p) => p.severity === 'error');
      expect(errors, r.title).toEqual([]);
    }
  });

  it('識別子の境界だけを置き換える', () => {
    expect(replaceIdentifier('Ribbon_btnRun_onAction btnRunAll "btnRun" m_btnRun', 'btnRun', 'btnRun2')).toBe('Ribbon_btnRun2_onAction btnRunAll "btnRun2" m_btnRun2');
  });

  it('同じレシピを2回入れると id とコールバック名と VBA が振り直される', () => {
    const d = doc();
    insertInstance(d, instantiate(recipe('toggle-state'), d), null, null);
    const second = instantiate(recipe('toggle-state'), d);
    expect(second.renamed.get('tglAuto')).toBe('tglAuto2');
    expect(second.element.querySelector('toggleButton')!.getAttribute('onAction')).toBe('Ribbon_tglAuto2_onAction');
    expect(second.vba).toContain('Private Function State_tglAuto2(');
    expect(second.vba).toContain('InvalidateRibbon "tglAuto2"');
  });

  it('組み込みタブへの追加は、同じタブがあればそこにまとめる', () => {
    const d = doc('<tab idMso="TabHome"><group id="grpA" label="A"/></tab>');
    insertInstance(d, instantiate(recipe('home-group'), d), null, null);
    expect(d.querySelectorAll('tab').length).toBe(1);
    expect(Array.from(d.querySelectorAll('tab > group')).map((g) => g.id)).toEqual(['grpA', 'grpMyTools']);
  });

  it('グループのレシピは、タブがなければ新しいタブを作って入れる', () => {
    const d = doc();
    const path = insertInstance(d, instantiate(recipe('vba-dropdown'), d), null, null);
    expect(path).toEqual([0, 0, 0, 0]);
    expect(serialize(d)).toContain('<tab id="tab1" label="新しいタブ">');
  });
});

/** モジュールの宣言部（最初の Sub / Function より前を除く、プロシージャの外）にある行。 */
function moduleLevelLines(code: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of code.split(/\r?\n/)) {
    if (/^\s*(?:(?:Public|Private|Friend)\s+)?(?:Static\s+)?(?:Sub|Function)\s/i.test(line)) inside = true;
    else if (/^\s*End\s+(?:Sub|Function)\b/i.test(line)) inside = false;
    else if (!inside && line.trim() && !/^\s*'/.test(line)) out.push(line);
  }
  return out;
}

describe('レシピの VBA', () => {
  it('既存のモジュールの末尾に足せるよう、モジュールレベルの宣言を持たない', () => {
    for (const r of builtinRecipes) {
      expect(moduleLevelLines(r.vba), r.title).toEqual([]);
      expect(moduleLevelLines(r.workbookVba ?? ''), r.title).toEqual([]);
    }
  });

  it('ThisWorkbook にすでにあるイベント処理は足さず、足す行を別に返す', () => {
    const d = doc();
    const inst = instantiate(recipe('conditional-enabled'), d, new Set(['Workbook_SheetSelectionChange']));
    expect(inst.workbookVba).toBe('');
    expect(inst.workbookVbaConflicts).toEqual(['Workbook_SheetSelectionChange']);
    expect(inst.workbookVbaConflictCode['Workbook_SheetSelectionChange']).toBe('    InvalidateRibbon "btnRange"');
    const plain = instantiate(recipe('conditional-enabled'), d);
    expect(plain.workbookVbaConflicts).toEqual([]);
    expect(plain.workbookVba).toContain('Private Sub Workbook_SheetSelectionChange');
  });

  it('id の振り直しが連鎖して重ならない', () => {
    const r: Recipe = {
      id: 'x', title: 'x', description: '', kind: 'group',
      xml: '<group id="grpX" label="X"><button id="btnRun" onAction="Ribbon_btnRun_onAction"/><button id="btnRun2" onAction="Ribbon_btnRun2_onAction"/></group>',
      vba: 'Public Sub Ribbon_btnRun_onAction(control As IRibbonControl)\r\nEnd Sub\r\nPublic Sub Ribbon_btnRun2_onAction(control As IRibbonControl)\r\nEnd Sub\r\n',
    };
    const d = doc('<tab id="t"><group id="g"><button id="btnRun"/></group></tab>');
    const inst = instantiate(r, d);
    const ids = Array.from(inst.element.querySelectorAll('button')).map((b) => b.id);
    expect(ids).toEqual(['btnRun3', 'btnRun2']);
    expect(inst.element.querySelector('[id="btnRun3"]')!.getAttribute('onAction')).toBe('Ribbon_btnRun3_onAction');
    expect(parseProcedures({ name: 'm', type: 1, code: inst.vba }).map((p) => p.name)).toEqual(['Ribbon_btnRun3_onAction', 'Ribbon_btnRun2_onAction']);
  });

  it('id を含まない Sub 名が既存の VBA と重なれば、XML と VBA の両方で振り直す', () => {
    const r: Recipe = {
      id: 'y', title: 'y', description: '', kind: 'group',
      xml: '<group id="grpY" label="Y"><button id="btnY" onAction="DoWork"/></group>',
      vba: 'Public Sub DoWork(control As IRibbonControl)\r\n    Helper\r\nEnd Sub\r\nPrivate Sub Helper()\r\nEnd Sub\r\n',
    };
    const inst = instantiate(r, doc(), new Set(['dowork', 'Helper']));
    expect(inst.element.querySelector('button')!.getAttribute('onAction')).toBe('DoWork2');
    expect(inst.vba).toContain('Public Sub DoWork2(control As IRibbonControl)');
    expect(inst.vba).toContain('    Helper2');
    expect(inst.vba).toContain('Private Sub Helper2()');
    expect(inst.renamedProcedures.get('DoWork')).toBe('DoWork2');
  });

  it('2007 形式の文書では、getContent で返す名前空間も 2007 にする', () => {
    const r = parseXml('<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui"><ribbon><tabs/></ribbon></customUI>');
    if (!r.ok) throw new Error(r.message);
    const inst = instantiate(recipe('sheet-menu'), r.doc);
    expect(inst.vba).toContain('http://schemas.microsoft.com/office/2006/01/customui');
    expect(inst.vba).not.toContain('2009/07');
  });
});

describe('接頭辞つきの文書へのレシピ', () => {
  const MSO = `<mso:customUI xmlns:mso="${NS}"><mso:ribbon><mso:tabs/></mso:ribbon></mso:customUI>`;

  it('文書の接頭辞で取り込み、書き出しても名前空間が保たれる', () => {
    const r = parseXml(MSO);
    if (!r.ok) throw new Error(r.message);
    insertInstance(r.doc, instantiate(recipe('basic-tab'), r.doc), null, null);
    insertInstance(r.doc, instantiate(recipe('vba-dropdown'), r.doc), null, null);
    const text = serialize(r.doc);
    expect(text).toContain('<mso:tab id="tabTools"');
    expect(text).toContain('<mso:button id="btnRun"');
    expect(text).not.toMatch(/<(tab|group|button|dropDown)\b/);
    const back = parseXml(text);
    if (!back.ok) throw new Error(back.message);
    expect(lint(back.doc, { version: 'office2010', imageIds: new Set(), knownIdMso: new Set(), missingImageMso: new Set() }).filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('接頭辞つきの要素から作ったレシピは、接頭辞なしの断片になる', () => {
    const r = parseXml(`<mso:customUI xmlns:mso="${NS}"><mso:ribbon><mso:tabs><mso:tab id="t" label="T"><mso:group id="g"/></mso:tab></mso:tabs></mso:ribbon></mso:customUI>`);
    if (!r.ok) throw new Error(r.message);
    const rec = recipeFromElement(r.doc.getElementsByTagNameNS(NS, 'tab')[0]!, 'T', '', '');
    expect(rec.xml).toBe('<tab id="t" label="T"><group id="g"/></tab>');
  });
});
