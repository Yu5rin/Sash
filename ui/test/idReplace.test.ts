import { describe, expect, it } from 'vitest';
import { applyIdReplacePlan, planIdReplace, replaceId, type IdReplaceOptions } from '../src/idReplace';
import { parseXml, serialize } from '../src/model';
import { DEFAULT_NAMING } from '../src/vba';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
function doc(group: string): Document {
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G">${group}</group></tab></tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}
const opts = (o: Partial<IdReplaceOptions>): IdReplaceOptions => ({ find: 'btn', replace: 'cmd', mode: 'prefix', renameCallbacks: true, rule: DEFAULT_NAMING, ...o });

describe('ID の一括置換', () => {
  it('先頭だけと、含まれるところすべて', () => {
    expect(replaceId('btnA', { find: 'btn', replace: 'cmd', mode: 'prefix' })).toBe('cmdA');
    expect(replaceId('xbtnA', { find: 'btn', replace: 'cmd', mode: 'prefix' })).toBe('xbtnA');
    expect(replaceId('btn_btn', { find: 'btn', replace: 'cmd', mode: 'substring' })).toBe('cmd_cmd');
  });

  it('命名規則どおりのコールバック名を変え、自分で付けた名前は変えない', () => {
    const d = doc('<button id="btnA" label="A" onAction="Ribbon_btnA_onAction" getEnabled="MyEnabled" /><button id="other" onAction="Ribbon_btnA_onAction" />');
    const plan = planIdReplace(d, opts({}));
    expect(plan.ids.map((r) => `${r.oldId}->${r.newId}`)).toEqual(['btnA->cmdA']);
    expect(plan.callbacks).toHaveLength(1);
    expect(plan.callbacks[0]!.oldName).toBe('Ribbon_btnA_onAction');
    expect(plan.callbacks[0]!.newName).toBe('Ribbon_cmdA_onAction');
    // 同じ名前を使っているほかの要素もそろえる
    expect(plan.callbacks[0]!.uses).toHaveLength(2);
    expect(plan.hasProblems).toBe(false);
    applyIdReplacePlan(d, plan);
    const xml = serialize(d);
    expect(xml).toContain('id="cmdA"');
    expect(xml).not.toContain('Ribbon_btnA_onAction');
    expect(xml).toContain('getEnabled="MyEnabled"');
  });

  it('モジュール名つきのコールバック名は、修飾部分を残す', () => {
    const d = doc('<button id="btnA" onAction="Module1.Ribbon_btnA_onAction" />');
    expect(planIdReplace(d, opts({})).callbacks[0]!.newName).toBe('Module1.Ribbon_cmdA_onAction');
  });

  it('既存の id と重なるもの・置き換え後どうしで重なるものを問題にする', () => {
    const d = doc('<button id="btnA" /><button id="cmdA" /><button id="btn-x" /><button id="btn_x" />');
    const plan = planIdReplace(d, opts({ find: 'btn', replace: 'cmd' }));
    const a = plan.ids.find((r) => r.oldId === 'btnA')!;
    expect(a.conflict).toBe(true);
    expect(plan.hasProblems).toBe(true);
    const p2 = planIdReplace(doc('<button id="aX" /><button id="bX" />'), opts({ find: 'a', replace: 'b', mode: 'prefix' }));
    expect(p2.ids[0]!.conflict).toBe(true);
  });

  it('id として使えない結果（数字で始まるなど）を問題にする', () => {
    const plan = planIdReplace(doc('<button id="btnA" />'), opts({ replace: '1' }));
    expect(plan.ids[0]!.invalid).toBe(true);
    expect(plan.hasProblems).toBe(true);
  });

  it('コールバック名が置き換え後に重なるものを問題にする', () => {
    const d = doc('<button id="btnA" onAction="Ribbon_btnA_onAction" /><button id="x" onAction="Ribbon_cmdA_onAction" />');
    const plan = planIdReplace(d, opts({}));
    expect(plan.callbacks[0]!.conflict).toBe(true);
    expect(plan.hasProblems).toBe(true);
  });

  it('コールバック名の置き換えを切ったとき・共有の命名規則のときは、コールバック名を変えない', () => {
    const d = doc('<button id="btnA" onAction="Ribbon_btnA_onAction" />');
    expect(planIdReplace(d, opts({ renameCallbacks: false })).callbacks).toEqual([]);
    expect(planIdReplace(d, opts({ rule: { ...DEFAULT_NAMING, shared: true } })).callbacks).toEqual([]);
  });

  it('VBA で変えられなかったコールバック名は、XML でも変えない', () => {
    const d = doc('<button id="btnA" onAction="Ribbon_btnA_onAction" getLabel="Ribbon_btnA_getLabel" />');
    const plan = planIdReplace(d, opts({}));
    applyIdReplacePlan(d, plan, new Set(['Ribbon_btnA_getLabel']));
    const b = d.querySelector('[id="cmdA"]')!;
    expect(b.getAttribute('onAction')).toBe('Ribbon_cmdA_onAction');
    expect(b.getAttribute('getLabel')).toBe('Ribbon_btnA_getLabel');
  });

  it('idMso と idQ は置き換えない', () => {
    const plan = planIdReplace(doc('<button idMso="btnX" /><button idQ="x:btnY" />'), opts({}));
    expect(plan.ids).toEqual([]);
  });
});
