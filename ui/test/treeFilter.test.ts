import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/model';
import { elementMatches, filterTree, splitHighlight } from '../src/treeFilter';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
function doc(body: string): Document {
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs>${body}</tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

const d = doc(`<tab id="tabTools" label="集計ツール">
  <group id="grpSum" label="集計">
    <button id="btnSummary" label="集計する" imageMso="AutoSum" onAction="Ribbon_btnSummary_onAction" />
    <button id="btnCsv" label="CSV出力" getEnabled="Module1.CanExport" />
  </group>
  <group id="grpOther" label="その他"><button idMso="FileSave" /></group>
</tab>`);
const byId = (id: string) => d.querySelector(`[id="${id}"]`)!;

describe('ツリーの絞り込み', () => {
  it('ラベル・id・idMso・imageMso・コールバック名で当たる（大文字小文字と全角半角は区別しない）', () => {
    expect(elementMatches(byId('btnSummary'), '集計する')).toBe(true);
    expect(elementMatches(byId('btnSummary'), 'BTNSUM')).toBe(true);
    expect(elementMatches(byId('btnSummary'), 'ａｕｔｏｓｕｍ')).toBe(true);
    expect(elementMatches(byId('btnSummary'), 'summary_onaction')).toBe(true);
    expect(elementMatches(byId('btnCsv'), 'canexport')).toBe(true);
    expect(elementMatches(d.querySelector('[idMso="FileSave"]')!, 'filesave')).toBe(true);
    expect(elementMatches(byId('btnCsv'), 'autosum')).toBe(false);
  });

  it('空白で区切った語はすべてに合うものだけ（AND）', () => {
    expect(elementMatches(byId('btnCsv'), 'csv 出力')).toBe(true);
    expect(elementMatches(byId('btnCsv'), 'csv 集計')).toBe(false);
  });

  it('合った要素と、その祖先だけを出す', () => {
    const r = filterTree(d, 'csv')!;
    expect([...r.matches].map((e) => e.getAttribute('id'))).toEqual(['btnCsv']);
    const shown = [...r.visible].map((e) => e.getAttribute('id') ?? e.localName);
    expect(shown).toEqual(expect.arrayContaining(['btnCsv', 'grpSum', 'tabTools', 'tabs', 'ribbon', 'customUI']));
    expect(shown).not.toContain('grpOther');
    expect(shown).not.toContain('btnSummary');
  });

  it('空の検索語では絞り込まない', () => {
    expect(filterTree(d, '  ')).toBeNull();
  });

  it('合った部分を強調用に分ける', () => {
    expect(splitHighlight('btnSummary', 'SUM')).toEqual([{ text: 'btn', hit: false }, { text: 'Sum', hit: true }, { text: 'mary', hit: false }]);
    expect(splitHighlight('集計する', 'xyz')).toEqual([{ text: '集計する', hit: false }]);
  });
});
