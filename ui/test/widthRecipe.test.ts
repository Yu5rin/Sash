import { describe, expect, it } from 'vitest';
import { builtinRecipes, insertInstance, instantiate } from '../src/recipes';
import { lint } from '../src/lint';
import { parseXml } from '../src/model';
import { matchCallbacks, parseProcedures } from '../src/vba';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';

describe('幅の試験用リボン（仕様書 §18.8）', () => {
  const recipe = builtinRecipes.find((r) => r.id === 'width-test')!;
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs/></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  const d = r.doc;
  insertInstance(d, instantiate(recipe, d), null, null);

  it('7 つのグループを持ち、すべてにグループの画像がある（畳んだときに出る）', () => {
    const groups = Array.from(d.querySelectorAll('group'));
    expect(groups).toHaveLength(7);
    expect(groups.every((g) => g.hasAttribute('imageMso'))).toBe(true);
    expect(groups.filter((g) => g.getAttribute('autoScale') === 'true').length).toBeGreaterThanOrEqual(2);
  });

  it('大きいボタンと小さいボタンに 4・6・8・10 文字のラベルと空白入りのラベルがある', () => {
    const lengths = (large: boolean) => new Set(Array.from(d.querySelectorAll('button'))
      .filter((b) => (b.getAttribute('size') === 'large') === large)
      .map((b) => [...(b.getAttribute('label') ?? '')].length));
    for (const n of [4, 6, 8, 10]) {
      expect(lengths(true).has(n), `large ${n}`).toBe(true);
      expect(lengths(false).has(n), `small ${n}`).toBe(true);
    }
    expect(Array.from(d.querySelectorAll('button')).some((b) => / /.test(b.getAttribute('label') ?? ''))).toBe(true);
    expect(d.querySelector('dropDown')).not.toBeNull();
    expect(d.querySelector('editBox')).not.toBeNull();
  });

  it('Lint のエラーはなく、コールバックはすべて VBA にある（引数も合う）', () => {
    const errors = lint(d, { version: 'office2010', imageIds: new Set(), knownIdMso: new Set(), missingImageMso: new Set() }).filter((p) => p.severity === 'error');
    expect(errors).toEqual([]);
    const statuses = matchCallbacks(d, [{ name: 'modRibbon', type: 1, code: recipe.vba }]);
    expect(statuses.filter((s) => s.state !== 'implemented')).toEqual([]);
    expect(parseProcedures({ name: 'modRibbon', type: 1, code: recipe.vba }).map((p) => p.name)).toEqual(['Ribbon_WidthTest_onAction', 'Ribbon_WidthTest_onToggle']);
  });
});
