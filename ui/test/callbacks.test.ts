import { beforeEach, describe, expect, it, vi } from 'vitest';

// ホストとの通信と確認ダイアログは差し替える（WebView2 の外で動かすため）
const invoke = vi.fn();
const ask = vi.fn();
vi.mock('../src/bridge', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../src/dialogs/modal', () => ({ ask: (...a: unknown[]) => ask(...a) }));

const { app } = await import('../src/app');
const { renameCallback, vba, setupRibbonHolder } = await import('../src/callbacks');
const { setEditRefusedHandler } = await import('../src/store');
const { RIBBON_HOLDER_MODULE_NAME } = await import('../src/vba');

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a" label="Ribbon_old" tag="Ribbon_old" onAction="Ribbon_old"/><button id="b" onAction="Ribbon_old"/></group></tab></tabs></ribbon></customUI>`;
const CODE = 'Public Sub Ribbon_old(control As IRibbonControl)\r\nEnd Sub\r\n';

function openDoc(xml = XML): void {
  app.open({ path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml, images: [] }] } as never);
}

beforeEach(() => {
  invoke.mockReset();
  ask.mockReset();
  openDoc();
  vba.status = 'ok';
  vba.modules = [{ name: 'modRibbon', type: 1, code: CODE }];
});

describe('renameCallback', () => {
  it('コールバック属性だけをそろえ、label や tag は書き換えない', async () => {
    ask.mockResolvedValue('both');
    invoke.mockImplementation(async (type: string) => (type === 'vba.read' ? { status: 'ok', modules: [] } : true));
    expect(await renameCallback([0, 0, 0, 0, 0], 'onAction', 'Ribbon_old', 'Ribbon_new')).toBe(true);
    const doc = app.store!.doc;
    const a = doc.querySelector('[id="a"]')!;
    expect(a.getAttribute('onAction')).toBe('Ribbon_new');
    expect(a.getAttribute('label')).toBe('Ribbon_old');
    expect(a.getAttribute('tag')).toBe('Ribbon_old');
    expect(doc.querySelector('[id="b"]')!.getAttribute('onAction')).toBe('Ribbon_new');
    const call = invoke.mock.calls.find((c) => c[0] === 'vba.replaceLine')!;
    expect((call[1] as { replacement: string }).replacement).toBe('Public Sub Ribbon_new(control As IRibbonControl)');
  });

  it('修飾つきの名前は、VBA には Sub 名の部分だけを渡す', async () => {
    ask.mockResolvedValue('both');
    invoke.mockImplementation(async (type: string) => (type === 'vba.read' ? { status: 'ok', modules: [] } : true));
    await renameCallback([0, 0, 0, 0, 0], 'onAction', 'Ribbon_old', 'modRibbon.Ribbon_new');
    const call = invoke.mock.calls.find((c) => c[0] === 'vba.replaceLine')!;
    expect((call[1] as { replacement: string }).replacement).toBe('Public Sub Ribbon_new(control As IRibbonControl)');
    expect(app.store!.doc.querySelector('[id="a"]')!.getAttribute('onAction')).toBe('modRibbon.Ribbon_new');
  });

  it('VBA の書き換えに失敗したら XML も変えず、理由を知らせる', async () => {
    const refused = vi.fn();
    setEditRefusedHandler(refused);
    ask.mockResolvedValue('both');
    invoke.mockImplementation(async (type: string) => (type === 'vba.read' ? { status: 'ok', modules: [] } : false));
    expect(await renameCallback([0, 0, 0, 0, 0], 'onAction', 'Ribbon_old', 'Ribbon_new')).toBe(false);
    expect(app.store!.doc.querySelector('[id="a"]')!.getAttribute('onAction')).toBe('Ribbon_old');
    expect(app.store!.canUndo).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('ホストの呼び出しが例外になっても、例外を外に出さずに知らせる', async () => {
    const refused = vi.fn();
    setEditRefusedHandler(refused);
    ask.mockResolvedValue('both');
    invoke.mockRejectedValue(new Error('COM エラー'));
    await expect(renameCallback([0, 0, 0, 0, 0], 'onAction', 'Ribbon_old', 'Ribbon_new')).resolves.toBe(false);
    expect(refused.mock.calls[0]![0]).toContain('COM エラー');
  });

  it('VBA の Sub 名として使えない名前は断る', async () => {
    const refused = vi.fn();
    setEditRefusedHandler(refused);
    expect(await renameCallback([0, 0, 0, 0, 0], 'onAction', 'Ribbon_old', 'Ribbon new')).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalled();
  });
});

describe('vba.statuses', () => {
  it('文書と VBA が変わらない間は同じ結果を返す', () => {
    const first = vba.statuses();
    expect(vba.statuses()).toBe(first);
    app.store!.edit('canvas', (doc) => {
      doc.querySelector('[id="b"]')!.setAttribute('onAction', 'Ribbon_other');
      return undefined;
    });
    expect(vba.statuses()).not.toBe(first);
  });
});

describe('setupRibbonHolder', () => {
  it('onLoad の Sub がすでにあっても、共通コードがなければ入れる', async () => {
    openDoc(`<customUI xmlns="${NS}" onLoad="Ribbon_onLoad"><ribbon/></customUI>`);
    vba.status = 'ok';
    vba.modules = [{ name: 'modRibbon', type: 1, code: 'Public Sub Ribbon_onLoad(ribbon As IRibbonUI)\r\nEnd Sub\r\n' }];
    invoke.mockImplementation(async (type: string) => (type === 'vba.read' ? { status: 'ok', modules: [] } : true));
    await setupRibbonHolder();
    expect(invoke.mock.calls.some((c) => c[0] === 'vba.insert' && (c[1] as { module: string }).module === RIBBON_HOLDER_MODULE_NAME)).toBe(true);
  });
});
