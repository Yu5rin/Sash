import { describe, expect, it } from 'vitest';
import { parseXml, serialize } from '../src/model';
import { builtinRecipes, insertInstance, instantiate, replaceIdentifier } from '../src/recipes';
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
    expect(second.vba).toContain('Private m_tglAuto2 As Boolean');
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
