import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 未保存の編集の自動退避と復旧（仕様書 §23.2）。ホストとの通信と確認ダイアログは差し替える

const invoke = vi.fn();
const askRecovery = vi.fn();
vi.mock('../src/bridge', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../src/dialogs/recoveryDialog', () => ({ askRecovery: (...a: unknown[]) => askRecovery(...a), formatWhen: (s: string) => s, openRecoveryDiff: vi.fn() }));

const { app } = await import('../src/app');
const rec = await import('../src/recovery');
const { openFile } = await import('../src/shell/fileOps');
const { clearToasts } = await import('../src/shell/toast');

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a" label="A"/></group></tab></tabs></ribbon></customUI>`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function openDoc(path = 'C:\\book.xlsm', images: { id: string; contentType: string; base64: string }[] = []): void {
  app.open({ path, parts: [{ version: 'office2010', xml: XML, images }] } as never);
}

function edit(label = 'B'): void {
  app.store!.edit('inspector', (doc) => {
    doc.querySelector('[id="a"]')!.setAttribute('label', label);
    return undefined;
  }, '編集');
}

const calls = (type: string) => invoke.mock.calls.filter((c) => c[0] === type);

describe('createDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('最後の呼び出しから delay たったら 1 回だけ run する', () => {
    const run = vi.fn();
    const d = rec.createDebouncer(run, { delay: 3000, maxWait: 15000 });
    d.trigger();
    vi.advanceTimersByTime(2000);
    d.trigger();
    vi.advanceTimersByTime(2000);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('呼び出しが続いても、最初の呼び出しから maxWait たてば run する（間引き）', () => {
    const run = vi.fn();
    const d = rec.createDebouncer(run, { delay: 3000, maxWait: 10000 });
    for (let i = 0; i < 20; i++) {
      d.trigger();
      vi.advanceTimersByTime(1000);
    }
    // 20 秒のあいだ 1 秒おきに呼んでも、10 秒ごとには書かれる
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('cancel で予約を取り消す', () => {
    const run = vi.fn();
    const d = rec.createDebouncer(run, { delay: 3000, maxWait: 15000 });
    d.trigger();
    d.cancel();
    vi.advanceTimersByTime(20000);
    expect(run).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });
});

describe('recoveryPayload', () => {
  beforeEach(() => {
    invoke.mockReset();
    openDoc('C:\\book.xlsm', [{ id: 'old', contentType: 'image/png', base64: 'AAAA' }, { id: 'keep', contentType: 'image/png', base64: 'BBBB' }]);
  });

  it('編集がなければ null', () => {
    expect(rec.recoveryPayload(app.session!)).toBeNull();
  });

  it('編集した XML と、画像の差分（足した・消した）だけを持つ', () => {
    app.store!.addImageAndApply({ id: 'new1', dataUrl: PNG, isNew: true }, () => undefined, '画像');
    app.store!.replaceAll(app.store!.text, [...app.store!.images.values()].filter((i) => i.id !== 'old'));
    const payload = rec.recoveryPayload(app.session!)!;
    expect(payload.parts).toHaveLength(1);
    expect(payload.parts[0]).toMatchObject({ version: 'office2010', addImages: [{ id: 'new1', dataUrl: PNG }], removeImages: ['old'] });
    expect(payload.editCount).toBeGreaterThanOrEqual(1);
  });
});

describe('自動退避', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    rec.startRecovery();
    app.close();
    // 閉じたことによる退避の削除（非同期の待ち行列）を流し切ってから数え始める
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockReset();
    invoke.mockResolvedValue(null);
    app.settings.autoRecovery = true;
    openDoc();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearToasts();
  });

  it('編集して数秒たつと、ホストへ書く', async () => {
    edit();
    expect(calls('recovery.write')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    const w = calls('recovery.write');
    expect(w).toHaveLength(1);
    expect(w[0]![1]).toMatchObject({ path: 'C:\\book.xlsm', parts: [{ version: 'office2010' }] });
    expect((w[0]![1] as { parts: { xml: string }[] }).parts[0]!.xml).toContain('label="B"');
  });

  it('続けて編集しても、書き込みは間引かれて 1 回にまとまる', async () => {
    for (let i = 0; i < 5; i++) {
      edit(`L${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(calls('recovery.write')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS);
    expect(calls('recovery.write')).toHaveLength(1);
  });

  it('保存したら消す', async () => {
    edit();
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    app.store!.markSaved();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls('recovery.delete').at(-1)![1]).toEqual({ path: 'C:\\book.xlsm' });
  });

  it('元に戻して保存済みと同じになったら消す', async () => {
    edit();
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    app.store!.undo();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls('recovery.delete')).toHaveLength(1);
  });

  it('ファイルを閉じたら（未保存の確認のあと）消し、書く予約も取り消す', async () => {
    edit();
    app.close();
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    expect(calls('recovery.write')).toHaveLength(0);
    expect(calls('recovery.delete').at(-1)![1]).toEqual({ path: 'C:\\book.xlsm' });
  });

  it('選択だけの変更では書かない', async () => {
    app.store!.select([0, 0, 0, 0], 'other');
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    expect(calls('recovery.write')).toHaveLength(0);
  });

  it('設定で切っていれば書かない', async () => {
    app.settings.autoRecovery = false;
    edit();
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    expect(calls('recovery.write')).toHaveLength(0);
  });

  it('パスのないセッション（サンプル）は書かない', async () => {
    app.close();
    openDoc('');
    edit();
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    expect(calls('recovery.write')).toHaveLength(0);
  });

  it('書き込みに失敗しても編集は止めず、続けて失敗したときだけ 1 度知らせる', async () => {
    invoke.mockImplementation(async (type: string) => {
      if (type === 'recovery.write') throw new Error('ディスクがいっぱいです');
      return null;
    });
    for (let i = 0; i < 4; i++) {
      edit(`X${i}`);
      await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    }
    // 編集そのものは通っている
    expect(app.store!.text).toContain('label="X3"');
    expect(document.querySelectorAll('.toast.warning')).toHaveLength(1);
    expect(calls('app.log').length).toBeGreaterThanOrEqual(3);
  });
});

describe('applyRecovery', () => {
  beforeEach(() => {
    invoke.mockReset();
    openDoc('C:\\book.xlsm', [{ id: 'old', contentType: 'image/png', base64: 'AAAA' }]);
  });

  it('XML と画像の差分を適用し、元に戻す 1 回で開いた直後に戻れる', () => {
    const edited = XML.replace('label="A"', 'label="復旧後"');
    const r = rec.applyRecovery({ path: 'C:\\book.xlsm', savedAt: '2026-11-26T05:00:00Z', editCount: 3, parts: [{ version: 'office2010', xml: edited, addImages: [{ id: 'new1', dataUrl: PNG }], removeImages: ['old'] }] });
    expect(r).toEqual({ applied: ['office2010'], missing: [] });
    const store = app.store!;
    expect(store.text).toBe(edited);
    expect([...store.images.keys()]).toEqual(['new1']);
    expect(store.dirty).toBe(true);
    store.undo();
    expect(store.text).toBe(XML);
    expect([...store.images.keys()]).toEqual(['old']);
    expect(store.dirty).toBe(false);
  });

  it('いまのファイルにないパーツは適用せず、missing に挙げる', () => {
    const r = rec.applyRecovery({ path: 'C:\\book.xlsm', savedAt: 'x', editCount: 1, parts: [{ version: 'office2007', xml: '<customUI/>', addImages: [], removeImages: [] }] });
    expect(r).toEqual({ applied: [], missing: ['office2007'] });
    expect(app.store!.text).toBe(XML);
  });
});

describe('ファイルを開いたときの復旧の確認', () => {
  const entry = { path: 'C:\\book.xlsm', savedAt: '2026-11-26T05:00:00Z', editCount: 4, fileNewer: false, parts: [{ version: 'office2010', xml: XML.replace('label="A"', 'label="退避"'), addImages: [], removeImages: [] }] };

  beforeEach(async () => {
    rec.startRecovery();
    app.close();
    await new Promise((r) => setTimeout(r, 0));
    invoke.mockReset();
    askRecovery.mockReset();
    invoke.mockImplementation(async (type: string) => {
      if (type === 'file.open') return { path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }] };
      if (type === 'recovery.read') return entry;
      return null;
    });
  });
  afterEach(() => clearToasts());

  it('復旧を選ぶと、退避した内容が未保存の状態で開く', async () => {
    askRecovery.mockResolvedValue('restore');
    await openFile('C:\\book.xlsm', { force: true });
    expect(app.store!.text).toContain('label="退避"');
    expect(app.dirty).toBe(true);
  });

  it('捨てるを選ぶと、退避を消してファイルの内容のまま開く', async () => {
    askRecovery.mockResolvedValue('discard');
    await openFile('C:\\book.xlsm', { force: true });
    expect(app.store!.text).toBe(XML);
    expect(calls('recovery.delete')).toHaveLength(1);
  });

  it('退避がなければ何も聞かない', async () => {
    invoke.mockImplementation(async (type: string) => (type === 'file.open' ? { path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }] } : null));
    await openFile('C:\\book.xlsm', { force: true });
    expect(askRecovery).not.toHaveBeenCalled();
  });

  it('退避を読めなくても、ファイルは開く', async () => {
    invoke.mockImplementation(async (type: string) => {
      if (type === 'file.open') return { path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }] };
      throw new Error('読めません');
    });
    await expect(openFile('C:\\book.xlsm', { force: true })).resolves.toBe(true);
    expect(app.session).not.toBeNull();
  });
});
