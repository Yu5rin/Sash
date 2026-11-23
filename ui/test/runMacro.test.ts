import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { vba } from '../src/callbacks';
import { parseXml } from '../src/model';
import { parseParams } from '../src/vba';
import { checkRunnable, macroArgument, runMacroDisabledReason } from '../src/vbaReveal';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
function el(xml: string): Element {
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G">${xml}</group></tab></tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc.querySelector('group')!.firstElementChild!;
}

describe('マクロを Excel で試す：呼び方の決め方', () => {
  beforeEach(() => {
    vba.status = 'notOpen';
    vba.modules = null;
  });

  it('引数なしはそのまま、IRibbonControl・Object・型なし 1 つは control に Nothing、ほかは断る', () => {
    expect(macroArgument('')).toEqual({ ok: true, argument: 'none' });
    expect(macroArgument('control As IRibbonControl')).toEqual({ ok: true, argument: 'control' });
    expect(macroArgument('ByVal c As Office.IRibbonControl')).toEqual({ ok: true, argument: 'control' });
    expect(macroArgument('c As Object')).toEqual({ ok: true, argument: 'control' });
    expect(macroArgument('c')).toEqual({ ok: true, argument: 'control' });
    expect(macroArgument('control As IRibbonControl, pressed As Boolean').ok).toBe(false);
    expect(macroArgument('s As String').ok).toBe(false);
    expect(macroArgument('v() As Variant').ok).toBe(false);
    expect(macroArgument('ParamArray v() As Variant').ok).toBe(false);
  });

  it('既定値の中の括弧のカンマで引数を分けない', () => {
    expect(parseParams('Optional v As Variant = Array(1, 2), n As Long').map((p) => p.name)).toEqual(['v', 'n']);
  });

  it('VBA を読めていなければ、XML のコールバックの形から決める', () => {
    expect(checkRunnable(el('<button id="b" onAction="Ribbon_b_onAction" />'))).toEqual({ ok: true, macro: 'Ribbon_b_onAction', argument: 'control' });
    const toggle = checkRunnable(el('<toggleButton id="tg" onAction="Ribbon_tg_onAction" />'));
    expect(toggle.ok).toBe(false);
    expect(checkRunnable(el('<button id="b" />')).ok).toBe(false);
    // VBA の名前として正しくないものは、ホストに送る前に断る
    expect(checkRunnable(el('<button id="b" onAction="Run(1)" />')).ok).toBe(false);
  });

  it('照合済みの VBA があれば、宣言から決める', () => {
    app.open({ path: 'C:\\t\\a.xlam', parts: [{ version: 'office2010', xml: `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G"><button id="a" onAction="NoArgs" /><button id="b" onAction="TwoArgs" /><button id="c" onAction="Missing" /></group></tab></tabs></ribbon></customUI>`, images: [] }] });
    // 開くと照合の結果は消えるので、開いた後に照合済みにする
    vba.status = 'ok';
    vba.modules = [{ name: 'modRibbon', type: 1, code: 'Sub NoArgs()\r\nEnd Sub\r\nSub TwoArgs(a As Long, b As Long)\r\nEnd Sub\r\n' }];
    const doc = app.store!.doc;
    const at = (id: string) => doc.querySelector(`[id="${id}"]`);
    expect(checkRunnable(at('a'))).toEqual({ ok: true, macro: 'NoArgs', argument: 'none' });
    expect(checkRunnable(at('b')).ok).toBe(false);
    expect(checkRunnable(at('c')).ok).toBe(false);
  });

  it('サンプル（パスが空）では使えない理由を返す', () => {
    app.info.excelInstalled = true;
    app.open({ path: '', parts: [{ version: 'office2010', xml: `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G"><button id="a" onAction="Run" /></group></tab></tabs></ribbon></customUI>`, images: [] }] });
    expect(runMacroDisabledReason(app.store!.doc.querySelector('[id="a"]'))).toContain('サンプル');
  });
});
