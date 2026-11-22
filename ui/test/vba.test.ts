import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/model';
import { callbackName, compareSignature, DEFAULT_NAMING, generateStub, matchCallbacks, parseProcedures, renameDeclaration } from '../src/vba';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';

function doc(body: string): Document {
  const r = parseXml(`<customUI xmlns="${NS}" onLoad="Ribbon_onLoad"><ribbon><tabs><tab id="t"><group id="g">${body}</group></tab></tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

describe('parseProcedures', () => {
  it('Sub と Function の宣言を、行継続とコメントを考慮して拾う', () => {
    const code = [
      "Option Explicit",
      "' Sub Fake(control As IRibbonControl)",
      "Public Sub A(control As IRibbonControl)",
      "End Sub",
      "Private Sub B(control As IRibbonControl, _",
      "    ByRef returnedVal) ' 説明",
      "End Sub",
      "Function C() As Long",
      "End Function",
    ].join('\r\n');
    const procs = parseProcedures({ name: 'modRibbon', type: 1, code });
    expect(procs.map((p) => [p.name, p.line, p.isPrivate])).toEqual([['A', 3, false], ['B', 5, true], ['C', 8, false]]);
    expect(procs[1]!.params.replace(/\s+/g, ' ')).toBe('control As IRibbonControl, ByRef returnedVal');
  });
});

describe('compareSignature', () => {
  it('型を書いていない引数は一致とみなす', () => {
    expect(compareSignature('control As IRibbonControl, pressed As Boolean', 'c As Office.IRibbonControl, p')).toBeNull();
  });
  it('数と型の違いを検出する', () => {
    expect(compareSignature('control As IRibbonControl, pressed As Boolean', 'control As IRibbonControl')).toContain('引数の数');
    expect(compareSignature('control As IRibbonControl, pressed As Boolean', 'control As IRibbonControl, pressed As String')).toContain('型が違います');
  });
  it('値を返す引数の ByVal を検出する', () => {
    expect(compareSignature('control As IRibbonControl, ByRef returnedVal', 'control As IRibbonControl, ByVal returnedVal')).toContain('ByRef');
  });
});

describe('matchCallbacks', () => {
  const d = doc('<button id="b1" onAction="Ribbon_b1_onAction"/><toggleButton id="t1" onAction="Ribbon_t1_onAction" getPressed="Ribbon_t1_getPressed"/>');
  const modules = [
    {
      name: 'modRibbon',
      type: 1,
      code: [
        'Public Sub ribbon_b1_onaction(control As IRibbonControl)',
        'End Sub',
        'Public Sub Ribbon_t1_onAction(control As IRibbonControl)',
        'End Sub',
        'Public Sub Ribbon_old_onAction(control As IRibbonControl)',
        'End Sub',
        'Public Sub Helper()',
        'End Sub',
      ].join('\n'),
    },
  ];

  it('四つの状態に分ける', () => {
    const r = Object.fromEntries(matchCallbacks(d, modules).map((s) => [s.name, s.state]));
    expect(r).toEqual({
      Ribbon_b1_onAction: 'implemented',
      Ribbon_t1_onAction: 'mismatch',
      Ribbon_t1_getPressed: 'missing',
      Ribbon_onLoad: 'missing',
      Ribbon_old_onAction: 'unused',
    });
  });

  it('VBA を読めないときはすべて未実装扱い', () => {
    expect(matchCallbacks(d, null).every((s) => s.state === 'missing')).toBe(true);
  });
});

describe('生成', () => {
  it('命名規則に従って名前を作る', () => {
    expect(callbackName(DEFAULT_NAMING, 'btnSum', 'onAction', 'button')).toBe('Ribbon_btnSum_onAction');
    expect(callbackName({ ...DEFAULT_NAMING, shared: true }, 'btnSum', 'onAction', 'button')).toBe('Ribbon_onAction');
  });

  it('値を返すコールバックには既定値を入れる', () => {
    const stub = generateStub({ name: 'Ribbon_b_getEnabled', expected: '', uses: [{ attr: 'getEnabled', tag: 'button', id: 'b', path: [] }] });
    expect(stub).toBe('Public Sub Ribbon_b_getEnabled(control As IRibbonControl, ByRef returnedVal)\r\n    returnedVal = True\r\nEnd Sub\r\n');
  });

  it('共有 Sub は control.Id で振り分ける', () => {
    const stub = generateStub({
      name: 'Ribbon_onAction',
      expected: '',
      uses: [
        { attr: 'onAction', tag: 'button', id: 'a', path: [] },
        { attr: 'onAction', tag: 'button', id: 'b', path: [] },
      ],
    });
    expect(stub).toContain('Select Case control.Id');
    expect(stub).toContain('Case "b"');
  });

  it('宣言行の名前だけを置き換える', () => {
    expect(renameDeclaration('Public Sub Old_Name(control As IRibbonControl) \' Old_Name', 'Old_Name', 'NewName')).toBe("Public Sub NewName(control As IRibbonControl) ' Old_Name");
  });
});
