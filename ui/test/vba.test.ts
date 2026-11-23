import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/model';
import { callbackName, compareSignature, DEFAULT_NAMING, generateStub, isCallbackName, matchCallbacks, parseParams, parseProcedures, renameDeclaration, RIBBON_HOLDER_MODULE } from '../src/vba';
import { callbackSignature, isVbaIdentifier, isXmlId } from '../src/schema';

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

describe('日本語の名前', () => {
  it('日本語の Sub 名と引数名を拾う', () => {
    const procs = parseProcedures({ name: 'modRibbon', type: 1, code: 'Public Sub リボン_集計_onAction(コントロール As IRibbonControl)\r\nEnd Sub' });
    expect(procs.map((p) => p.name)).toEqual(['リボン_集計_onAction']);
    expect(parseParams(procs[0]!.params)[0]).toMatchObject({ name: 'コントロール', type: 'iribboncontrol' });
  });

  it('日本語の id から作るコールバック名は文字を残す', () => {
    expect(callbackName(DEFAULT_NAMING, '集計', 'onAction', 'button')).toBe('Ribbon_集計_onAction');
    expect(callbackName(DEFAULT_NAMING, 'btn-a', 'onAction', 'button')).toBe('Ribbon_btn_a_onAction');
  });

  it('記号を _ にした結果が重なるときは番号を付ける', () => {
    expect(callbackName(DEFAULT_NAMING, 'btn.a', 'onAction', 'button', new Set(['ribbon_btn_a_onaction']))).toBe('Ribbon_btn_a_onAction2');
  });

  it('宣言行の日本語の名前も置き換え、正規表現の特殊文字で壊れない', () => {
    expect(renameDeclaration('Public Sub 集計(control As IRibbonControl)', '集計', '合計')).toBe('Public Sub 合計(control As IRibbonControl)');
    expect(renameDeclaration('Public Sub AB(control As IRibbonControl)', 'A.', 'X')).toBe('Public Sub AB(control As IRibbonControl)');
    // 名前の一部だけが一致しても置き換えない
    expect(renameDeclaration('Public Sub Run2(control As IRibbonControl)', 'Run', 'Go')).toBe('Public Sub Run2(control As IRibbonControl)');
  });

  it('識別子の判定', () => {
    expect(isVbaIdentifier('集計_1')).toBe(true);
    expect(isVbaIdentifier('1abc')).toBe(false);
    expect(isVbaIdentifier('a-b')).toBe(false);
    expect(isVbaIdentifier('a'.repeat(256))).toBe(false);
    expect(isXmlId('タブ.1-a')).toBe(true);
    expect(isXmlId('1tab')).toBe(false);
    expect(isCallbackName('Module1.集計')).toBe(true);
    expect(isCallbackName('Book.xlsm!Run')).toBe(true);
    expect(isCallbackName('Run Now')).toBe(false);
  });
});

describe('シグネチャ', () => {
  it('Backstage の onShow / onHide は Object を受け取る', () => {
    expect(callbackSignature('onShow', 'backstage')).toBe('contextObject As Object');
    expect(callbackSignature('onHide', 'backstage')).toBe('contextObject As Object');
  });

  it('radioGroup の onAction は選ばれた項目の id と番号を受け取る', () => {
    expect(callbackSignature('onAction', 'radioGroup')).toBe('control As IRibbonControl, id As String, index As Integer');
  });

  it('番号の型の違いと、Object で受ける control は一致とみなす', () => {
    expect(compareSignature('control As IRibbonControl, id As String, index As Integer', 'control As Object, id As String, index As Long')).toBeNull();
    expect(compareSignature('ribbon As IRibbonUI', 'ribbon As Object')).toBeNull();
    expect(compareSignature('control As IRibbonControl, index As Integer, ByRef returnedVal', 'control As IRibbonControl, index As String, ByRef returnedVal')).toContain('型が違います');
  });
});

describe('共有 Sub', () => {
  const shared = { ...DEFAULT_NAMING, shared: true };

  it('引数の違うコントロールには、引数の種類の印を付けた名前にする', () => {
    expect(callbackName(shared, 'b', 'onAction', 'button')).toBe('Ribbon_onAction');
    expect(callbackName(shared, 't', 'onAction', 'toggleButton')).toBe('Ribbon_onAction_Pressed');
    expect(callbackName(shared, 'c', 'onAction', 'checkBox')).toBe('Ribbon_onAction_Pressed');
    expect(callbackName(shared, 'd', 'onAction', 'dropDown')).toBe('Ribbon_onAction_IdIndex');
    expect(callbackName(shared, 'b', 'getLabel', 'toggleButton')).toBe('Ribbon_getLabel');
  });

  it('引数の違うコントロールで同じ名前を使っていれば不一致にする（VBA を読めなくても）', () => {
    const d = doc('<button id="b" onAction="Ribbon_onAction"/><toggleButton id="t" onAction="Ribbon_onAction"/>');
    const st = matchCallbacks(d, null).find((s) => s.name === 'Ribbon_onAction')!;
    expect(st.state).toBe('mismatch');
    expect(st.reason).toContain('button.onAction');
    expect(st.reason).toContain('toggleButton.onAction');
  });
});

describe('雛形', () => {
  it('getContent の名前空間はパーツの形式に合わせる', () => {
    const r = parseXml('<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui"><ribbon><tabs><tab id="t"><group id="g"><dynamicMenu id="d" getContent="Ribbon_d_getContent"/></group></tab></tabs></ribbon></customUI>');
    if (!r.ok) throw new Error(r.message);
    const st = matchCallbacks(r.doc, null)[0]!;
    expect(generateStub(st)).toContain('http://schemas.microsoft.com/office/2006/01/customui');
    expect(generateStub({ ...st, namespace: undefined })).toContain('http://schemas.microsoft.com/office/2009/07/customui');
  });

  it('IRibbonUI の退避は数値の数式として登録し、ゼロは同じ型の変数で書く', () => {
    expect(RIBBON_HOLDER_MODULE).toContain('RefersTo:="=" & CStr(CLngPtr(ObjPtr(ribbon)))');
    expect(RIBBON_HOLDER_MODULE).toContain('Dim ptr As LongPtr, zero As LongPtr');
    expect(RIBBON_HOLDER_MODULE).toContain('CopyMemory obj, zero, LenB(ptr)');
    expect(RIBBON_HOLDER_MODULE).not.toContain('CopyMemory obj, 0&');
  });
});
