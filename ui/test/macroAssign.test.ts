import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canWrapAttr, fixableMacro, generateWrapper, listMacros, manualMacro, planWrappers, toMacroEntry } from '../src/macroAssign';
import { matchCallbacks, parseProcedures, type VbaModule } from '../src/vba';
import { filterMacros } from '../src/dialogs/macroDialog';

// 既存のマクロを割り当てる（仕様書 §23.1）。候補の判定・呼び出し用の Sub の生成・名前の衝突を押さえる

const MAIN: VbaModule = {
  name: 'modMain',
  type: 1,
  code: [
    'Public Sub CSV出力()',
    'End Sub',
    'Sub 集計()',
    'End Sub',
    'Private Sub 内部()',
    'End Sub',
    'Public Sub 引数あり(ByVal n As Long)',
    'End Sub',
    'Public Function 値を返す() As Long',
    'End Function',
    'Public Sub 省略可(Optional ByVal n As Long = 1)',
    'End Sub',
    'Public Sub Ribbon_btnA_onAction(control As IRibbonControl)',
    'End Sub',
    '',
  ].join('\r\n'),
};
const SHEET: VbaModule = { name: 'Sheet1', type: 100, code: 'Public Sub シート操作()\r\nEnd Sub\r\n' };
const OTHER: VbaModule = { name: 'modOther', type: 1, code: 'Public Sub 集計()\r\nEnd Sub\r\n' };

describe('listMacros', () => {
  const list = listMacros([MAIN, SHEET, OTHER]);
  const by = (module: string, name: string) => list.find((m) => m.module === module && m.name === name)!;

  it('引数なしの Public Sub（標準モジュール）を割り当てられるものにする', () => {
    expect(by('modMain', 'CSV出力').assignable).toBe(true);
    // Public を省いた Sub は Public になる
    expect(by('modMain', '集計').assignable).toBe(true);
    // 引数がすべて Optional なら、引数なしで呼べる
    expect(by('modMain', '省略可').assignable).toBe(true);
  });

  it('Private・引数あり・Function・標準モジュール以外は、理由つきで割り当てられないものにする', () => {
    expect(by('modMain', '内部')).toMatchObject({ assignable: false, reason: expect.stringContaining('Private') });
    expect(by('modMain', '引数あり')).toMatchObject({ assignable: false, reason: expect.stringContaining('引数') });
    expect(by('modMain', '値を返す')).toMatchObject({ assignable: false, reason: expect.stringContaining('Function') });
    expect(by('Sheet1', 'シート操作')).toMatchObject({ assignable: false, reason: expect.stringContaining('標準モジュール') });
  });

  it('リボンのコールバック（IRibbonControl を受けるもの）は候補に出さない', () => {
    expect(list.some((m) => m.name === 'Ribbon_btnA_onAction')).toBe(false);
  });

  it('標準モジュールの Sub は「モジュール名.Sub 名」で呼び、同じ名前が別にあれば印を付ける', () => {
    expect(by('modMain', 'CSV出力').qualified).toBe('modMain.CSV出力');
    expect(by('modMain', '集計').duplicated).toBe(true);
    expect(by('modOther', '集計').duplicated).toBe(true);
    expect(by('modMain', 'CSV出力').duplicated).toBe(false);
  });

  it('VBA を読めていない（null）ときは空', () => {
    expect(listMacros(null)).toEqual([]);
  });
});

describe('manualMacro', () => {
  it('Sub 名と「モジュール名.Sub 名」を受け、使えない名前は断る', () => {
    expect(manualMacro('集計')).toMatchObject({ name: '集計', qualified: '集計', module: '' });
    expect(manualMacro(' modMain.CSV出力 ')).toMatchObject({ name: 'CSV出力', module: 'modMain', qualified: 'modMain.CSV出力' });
    expect(manualMacro('1abc')).toBeNull();
    expect(manualMacro('a b')).toBeNull();
    expect(manualMacro('')).toBeNull();
    expect(manualMacro('x.y.z')).toBeNull();
  });
});

describe('generateWrapper', () => {
  const macro = toMacroEntry(parseProcedures(MAIN)[0]!, 1, false);

  it('button の onAction は IRibbonControl だけを受け、マクロを Call で呼ぶ', () => {
    expect(generateWrapper('Ribbon_btnCsv_onAction', 'onAction', 'button', macro)).toBe(
      ["Public Sub Ribbon_btnCsv_onAction(control As IRibbonControl)", "    ' リボンから「CSV出力」を呼び出す（Sash が生成）", '    Call modMain.CSV出力', 'End Sub', ''].join('\r\n'));
  });

  it('toggleButton は pressed を受け、使わないことをコメントに書く', () => {
    const code = generateWrapper('Ribbon_tgl_onAction', 'onAction', 'toggleButton', macro);
    expect(code).toContain('Public Sub Ribbon_tgl_onAction(control As IRibbonControl, pressed As Boolean)');
    expect(code).toContain("' pressed は使わずに呼びます");
    expect(code).toContain('Call modMain.CSV出力');
  });

  it('dropDown は id と index を受ける', () => {
    expect(generateWrapper('Ribbon_dd_onAction', 'onAction', 'dropDown', macro)).toContain('(control As IRibbonControl, id As String, index As Integer)');
  });

  it('生成した Sub は、その属性の期待する引数と一致する（照合で implemented になる）', () => {
    const code = generateWrapper('Ribbon_btnCsv_onAction', 'onAction', 'button', macro);
    const doc = new DOMParser().parseFromString('<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui"><ribbon><tabs><tab id="t"><group id="g"><button id="b" onAction="Ribbon_btnCsv_onAction"/></group></tab></tabs></ribbon></customUI>', 'application/xml');
    const st = matchCallbacks(doc, [{ name: 'modRibbon', type: 1, code }]);
    expect(st[0]!.state).toBe('implemented');
  });
});

describe('canWrapAttr', () => {
  it('戻り値を返す引数のあるもの・onLoad・get 系には作らない', () => {
    expect(canWrapAttr('onAction', 'button')).toBe(true);
    expect(canWrapAttr('onChange', 'editBox')).toBe(true);
    expect(canWrapAttr('onAction', 'command')).toBe(false);
    expect(canWrapAttr('onLoad', 'customUI')).toBe(false);
    expect(canWrapAttr('getLabel', 'button')).toBe(false);
  });
});

describe('planWrappers', () => {
  const macro = manualMacro('modMain.CSV出力')!;
  const target = (id: string, baseName: string, tag = 'button') => ({ path: [0, 0, 0, Number(id)], attr: 'onAction', tag, baseName });

  it('すでにある名前（大文字小文字を区別しない）と重なれば番号を付けて避ける', () => {
    const plan = planWrappers([target('0', 'Ribbon_a_onAction')], macro, new Set(['ribbon_a_onaction']));
    expect(plan.assignments[0]!.name).toBe('Ribbon_a_onAction2');
    expect(plan.renamed).toEqual([['Ribbon_a_onAction', 'Ribbon_a_onAction2']]);
  });

  it('同じ案で引数の形も同じものは 1 つの Sub を共有し、引数の形が違えば別の Sub にする', () => {
    const plan = planWrappers([target('0', 'Ribbon_onAction'), target('1', 'Ribbon_onAction'), target('2', 'Ribbon_onAction', 'toggleButton')], macro, new Set());
    expect(plan.wrappers.map((w) => w.name)).toEqual(['Ribbon_onAction', 'Ribbon_onAction2']);
    expect(plan.assignments.map((a) => a.name)).toEqual(['Ribbon_onAction', 'Ribbon_onAction', 'Ribbon_onAction2']);
  });

  it('計画の中で作る名前どうしも重ならない', () => {
    const plan = planWrappers([target('0', 'X_onAction'), target('1', 'x_onaction', 'toggleButton')], macro, new Set());
    expect(new Set(plan.wrappers.map((w) => w.name.toLowerCase())).size).toBe(2);
  });
});

describe('fixableMacro（引数の不一致の直し方）', () => {
  const doc = (name: string) => new DOMParser().parseFromString(`<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui"><ribbon><tabs><tab id="t"><group id="g"><button id="b" onAction="${name}"/></group></tab></tabs></ribbon></customUI>`, 'application/xml');
  const moduleType = (name: string) => [MAIN, SHEET, OTHER].find((m) => m.name === name)?.type ?? 1;

  it('onAction に引数なしの Public Sub の名前が直接書かれているとき、候補を返す', () => {
    const [st] = matchCallbacks(doc('CSV出力'), [MAIN]);
    expect(st!.state).toBe('mismatch');
    expect(fixableMacro(st!, moduleType)).toMatchObject({ qualified: 'modMain.CSV出力' });
  });

  it('Private の Sub・標準モジュール以外の Sub・引数のある Sub は直せない', () => {
    for (const name of ['内部', '引数あり', 'シート操作']) {
      const [st] = matchCallbacks(doc(name), [MAIN, SHEET]);
      expect(st!.state).toBe('mismatch');
      expect(fixableMacro(st!, moduleType)).toBeNull();
    }
  });

  it('実装済み・未実装のものは対象外', () => {
    const [missing] = matchCallbacks(doc('CSV出力'), []);
    expect(missing!.state).toBe('missing');
    expect(fixableMacro(missing!, moduleType)).toBeNull();
  });
});

describe('filterMacros', () => {
  it('モジュール名・Sub 名のどちらにも、大文字小文字を区別せず一致する', () => {
    const list = listMacros([MAIN, OTHER]);
    expect(filterMacros(list, 'csv').map((m) => m.name)).toEqual(['CSV出力']);
    expect(filterMacros(list, 'MODOTHER').map((m) => m.name)).toEqual(['集計']);
    expect(filterMacros(list, '').length).toBe(list.length);
  });
});

// ---- 割り当ての実行（ホストとの通信は差し替える） ----

const invoke = vi.fn();
vi.mock('../src/bridge', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

describe('assignMacro', () => {
  const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
  const XML = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="btnCsv" label="CSV" onAction="CSV出力"/><toggleButton id="tgl" label="切替"/></group></tab></tabs></ribbon></customUI>`;
  let app: typeof import('../src/app').app;
  let cb: typeof import('../src/callbacks');

  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockImplementation(async (type: string) => (type === 'vba.read' ? { status: 'ok', modules: [MAIN] } : true));
    ({ app } = await import('../src/app'));
    cb = await import('../src/callbacks');
    app.open({ path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }] } as never);
    cb.vba.status = 'ok';
    cb.vba.modules = [MAIN];
  });

  it('呼び出し用の Sub を設定のモジュールへ挿入してから、属性を付け替える', async () => {
    const macro = listMacros([MAIN]).find((m) => m.name === 'CSV出力')!;
    const msg = await cb.assignMacro([{ path: [0, 0, 0, 0, 0], attr: 'onAction' }], macro);
    const ins = invoke.mock.calls.find((c) => c[0] === 'vba.insert')!;
    expect(ins[1]).toMatchObject({ path: 'C:\\book.xlsm', module: 'modRibbon', documentModule: false });
    expect((ins[1] as { code: string }).code).toContain('Call modMain.CSV出力');
    const name = app.store!.doc.querySelector('[id="btnCsv"]')!.getAttribute('onAction')!;
    expect(name).toBe('Ribbon_btnCsv_onAction');
    expect(msg).toContain(name);
    // 元に戻すで属性は戻る（VBA に入れた Sub はそのまま）
    app.store!.undo();
    expect(app.store!.doc.querySelector('[id="btnCsv"]')!.getAttribute('onAction')).toBe('CSV出力');
  });

  it('VBA に同じ名前の Sub がすでにあれば、番号を付けて避ける', async () => {
    cb.vba.modules = [MAIN, { name: 'modRibbon', type: 1, code: 'Public Sub Ribbon_btnCsv_onAction(control As IRibbonControl)\r\nEnd Sub\r\n' }];
    const macro = listMacros([MAIN]).find((m) => m.name === 'CSV出力')!;
    await cb.assignMacro([{ path: [0, 0, 0, 0, 0], attr: 'onAction' }], macro);
    expect(app.store!.doc.querySelector('[id="btnCsv"]')!.getAttribute('onAction')).toBe('Ribbon_btnCsv_onAction2');
  });

  it('VBA への挿入に失敗したら XML には触らない', async () => {
    invoke.mockImplementation(async (type: string) => {
      if (type === 'vba.insert') throw new Error('挿入できません');
      return { status: 'ok', modules: [] };
    });
    const macro = listMacros([MAIN]).find((m) => m.name === 'CSV出力')!;
    await expect(cb.assignMacro([{ path: [0, 0, 0, 0, 0], attr: 'onAction' }], macro)).rejects.toThrow('挿入できません');
    expect(app.store!.doc.querySelector('[id="btnCsv"]')!.getAttribute('onAction')).toBe('CSV出力');
  });

  it('VBA を読めないとき（Excel で開いていない）は、挿入せずコードをクリップボードへ', async () => {
    cb.vba.status = 'notOpen';
    cb.vba.modules = null;
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    const msg = await cb.assignMacro([{ path: [0, 0, 0, 0, 0], attr: 'onAction' }], manualMacro('modMain.CSV出力')!);
    expect(invoke.mock.calls.some((c) => c[0] === 'vba.insert')).toBe(false);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Call modMain.CSV出力'));
    expect(msg).toContain('クリップボード');
    expect(app.store!.doc.querySelector('[id="btnCsv"]')!.getAttribute('onAction')).toBe('Ribbon_btnCsv_onAction');
  });

  it('属性にすでに同じ名前が入っていても（名前だけ追加してあった）、VBA に Sub を入れて成功にする', async () => {
    app.store!.edit('inspector', (doc) => { doc.querySelector('[id="btnCsv"]')!.setAttribute('onAction', 'Ribbon_btnCsv_onAction'); return undefined; });
    const macro = listMacros([MAIN]).find((m) => m.name === 'CSV出力')!;
    await expect(cb.assignMacro([{ path: [0, 0, 0, 0, 0], attr: 'onAction' }], macro)).resolves.toContain('Ribbon_btnCsv_onAction');
    expect(invoke.mock.calls.some((c) => c[0] === 'vba.insert')).toBe(true);
  });

  it('引数の不一致を、呼び出し用の Sub を作って直す', async () => {
    const st = cb.vba.statuses().find((x) => x.name === 'CSV出力')!;
    expect(st.state).toBe('mismatch');
    expect(cb.fixableMacroOf(st)?.qualified).toBe('modMain.CSV出力');
    await cb.fixWithWrapper(st);
    expect(app.store!.doc.querySelector('[id="btnCsv"]')!.getAttribute('onAction')).toBe('Ribbon_btnCsv_onAction');
  });

  it('assignableAttr：ボタンは onAction、グループは割り当てられない', () => {
    const doc = app.store!.doc;
    expect(cb.assignableAttr(doc.querySelector('[id="btnCsv"]'))).toBe('onAction');
    expect(cb.assignableAttr(doc.querySelector('[id="g"]'))).toBeNull();
    expect(cb.assignableAttr(null)).toBeNull();
  });
});
