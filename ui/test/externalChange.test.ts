import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ほかで書き換えられたファイルの検知（仕様書 §23.4）。ホストとの通信と確認ダイアログは差し替える

const invoke = vi.fn();
const askExternalChange = vi.fn();
vi.mock('../src/bridge', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../src/dialogs/externalChangeDialog', () => ({ askExternalChange: (...a: unknown[]) => askExternalChange(...a), openExternalDiff: vi.fn() }));
vi.mock('../src/dialogs/recoveryDialog', () => ({ askRecovery: vi.fn(), formatWhen: (s: string) => s, openRecoveryDiff: vi.fn() }));

const { app } = await import('../src/app');
const { sameFingerprint, isWatchable, checkExternalChange } = await import('../src/externalChange');
const { save, applyToExcel } = await import('../src/shell/fileOps');
const { createExternalWatcher } = await import('../src/shell/externalWatch');
const { clearToasts } = await import('../src/shell/toast');

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a" label="A"/></group></tab></tabs></ribbon></customUI>`;

function openDoc(fingerprint: Record<string, string> | null = { office2010: 'base' }): void {
  app.open({ path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }], fingerprint } as never);
}

function edit(): void {
  app.store!.edit('inspector', (doc) => {
    doc.querySelector('[id="a"]')!.setAttribute('label', '編集');
    return undefined;
  }, '編集');
}

/** ディスクの照合値を differs にしたホストの応答。 */
function host(disk: Record<string, string> | null, extra: Record<string, unknown> = {}): void {
  invoke.mockImplementation(async (type: string) => {
    if (type === 'file.fingerprint') return { fingerprint: disk };
    if (type === 'file.save') return { backup: 'C:\\backup\\book.xlsm', fingerprint: { office2010: 'saved' } };
    if (type === 'file.open') return { path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML.replace('label="A"', 'label="ほかの人"'), images: [] }], fingerprint: disk };
    if (type === 'excel.apply') return { status: 'applied', message: '反映しました' };
    if (type in extra) return extra[type];
    return null;
  });
}

const calls = (type: string) => invoke.mock.calls.filter((c) => c[0] === type);

beforeEach(() => {
  invoke.mockReset();
  askExternalChange.mockReset();
  app.settings.detectExternalChanges = true;
  app.settings.autoRecovery = false;
  app.close();
});
afterEach(() => clearToasts());

describe('sameFingerprint', () => {
  it('パーツの種類も照合値も同じときだけ同じ', () => {
    expect(sameFingerprint({ office2010: 'a' }, { office2010: 'a' })).toBe(true);
    expect(sameFingerprint({ office2010: 'a' }, { office2010: 'b' })).toBe(false);
    expect(sameFingerprint({ office2010: 'a' }, { office2007: 'a' })).toBe(false);
    expect(sameFingerprint({ office2010: 'a' }, { office2010: 'a', office2007: 'b' })).toBe(false);
    expect(sameFingerprint(null, { office2010: 'a' })).toBe(false);
    expect(sameFingerprint({}, {})).toBe(true);
  });
});

describe('検知の対象', () => {
  it('基準があり、設定が入で、ファイルのあるセッションだけ', () => {
    openDoc();
    expect(isWatchable(app.session)).toBe(true);
    app.settings.detectExternalChanges = false;
    expect(isWatchable(app.session)).toBe(false);
    app.settings.detectExternalChanges = true;
    app.session!.fingerprint = null;
    expect(isWatchable(app.session)).toBe(false);
    expect(isWatchable(null)).toBe(false);
  });

  it('checkExternalChange：同じなら same、違えば changed、読めなければ unknown（失敗にしない）', async () => {
    openDoc();
    host({ office2010: 'base' });
    expect((await checkExternalChange(app.session!)).state).toBe('same');
    host({ office2010: 'other' });
    expect((await checkExternalChange(app.session!)).state).toBe('changed');
    host(null);
    expect((await checkExternalChange(app.session!)).state).toBe('unknown');
    invoke.mockRejectedValue(new Error('x'));
    expect((await checkExternalChange(app.session!)).state).toBe('unknown');
  });
});

describe('保存の前の確認', () => {
  beforeEach(() => {
    openDoc();
    edit();
  });

  it('変わっていなければ、確認せずに保存し、保存した内容を基準にする', async () => {
    host({ office2010: 'base' });
    expect(await save()).toBe(true);
    expect(askExternalChange).not.toHaveBeenCalled();
    expect(calls('file.save')).toHaveLength(1);
    expect(app.session!.fingerprint).toEqual({ office2010: 'saved' });
  });

  it('ほかで変わっていれば確認し、［自分の編集で上書き］なら保存する', async () => {
    host({ office2010: 'other' });
    askExternalChange.mockResolvedValue('overwrite');
    expect(await save()).toBe(true);
    expect(askExternalChange).toHaveBeenCalledWith(app.session, 'save');
    expect(calls('file.save')).toHaveLength(1);
  });

  it('［キャンセル］なら保存せず、編集も残る', async () => {
    host({ office2010: 'other' });
    askExternalChange.mockResolvedValue('cancel');
    expect(await save()).toBe(false);
    expect(calls('file.save')).toHaveLength(0);
    expect(app.dirty).toBe(true);
  });

  it('［ほかの変更を読み込む］なら、保存せずに読み直す（自分の編集は捨てる）', async () => {
    host({ office2010: 'other' });
    askExternalChange.mockResolvedValue('reload');
    expect(await save()).toBe(false);
    expect(calls('file.save')).toHaveLength(0);
    expect(calls('file.open')).toHaveLength(1);
    expect(app.store!.text).toContain('label="ほかの人"');
    expect(app.dirty).toBe(false);
    expect(app.session!.fingerprint).toEqual({ office2010: 'other' });
  });

  it('調べられないとき（基準がない・ファイルが読めない）は、確認せずに保存する', async () => {
    host(null);
    expect(await save()).toBe(true);
    expect(askExternalChange).not.toHaveBeenCalled();
    app.close();
    openDoc(null);
    edit();
    host({ office2010: 'other' });
    expect(await save()).toBe(true);
    expect(askExternalChange).not.toHaveBeenCalled();
  });

  it('設定で切っていれば、ディスクを調べない', async () => {
    app.settings.detectExternalChanges = false;
    host({ office2010: 'other' });
    expect(await save()).toBe(true);
    expect(calls('file.fingerprint')).toHaveLength(0);
  });

  it('リボン以外だけが変わったとき（照合値が同じ）は何も出ない', async () => {
    host({ office2010: 'base' });
    await save();
    expect(askExternalChange).not.toHaveBeenCalled();
  });
});

describe('Excel へ反映の前の確認', () => {
  it('編集があって、ほかで変わっていれば確認する。キャンセルなら反映しない', async () => {
    openDoc();
    edit();
    host({ office2010: 'other' });
    askExternalChange.mockResolvedValue('cancel');
    await applyToExcel();
    expect(askExternalChange).toHaveBeenCalledWith(app.session, 'apply');
    expect(calls('excel.apply')).toHaveLength(0);
  });

  it('上書きを選べば反映し、反映したあとの内容を基準に取り直す', async () => {
    openDoc();
    edit();
    host({ office2010: 'other' });
    askExternalChange.mockResolvedValue('overwrite');
    await applyToExcel();
    expect(calls('excel.apply')).toHaveLength(1);
    await vi.waitFor(() => expect(calls('file.fingerprint').length).toBeGreaterThanOrEqual(2));
  });

  it('編集がなければ（書き換えるものがない）、確認しない', async () => {
    openDoc();
    host({ office2010: 'other' });
    await applyToExcel();
    expect(askExternalChange).not.toHaveBeenCalled();
  });
});

describe('窓に戻ったときの検知', () => {
  it('編集がなければ、黙って読み直して知らせる', async () => {
    openDoc();
    host({ office2010: 'other' });
    const watch = createExternalWatcher(0);
    await watch();
    expect(calls('file.open')).toHaveLength(1);
    expect(app.store!.text).toContain('label="ほかの人"');
    expect(document.querySelector('.toast')?.textContent).toContain('読み直しました');
  });

  it('編集があれば、読み直さず、警告で知らせる（同じ状態では 1 度だけ）', async () => {
    openDoc();
    edit();
    host({ office2010: 'other' });
    const watch = createExternalWatcher(0);
    await watch();
    await watch();
    expect(calls('file.open')).toHaveLength(0);
    expect(app.store!.text).toContain('label="編集"');
    expect(document.querySelectorAll('.toast.warning')).toHaveLength(1);
    // さらに別の変更が入ったら、もう一度知らせる
    host({ office2010: 'other2' });
    await watch();
    expect(document.querySelectorAll('.toast.warning')).toHaveLength(2);
  });

  it('変わっていなければ何もしない', async () => {
    openDoc();
    host({ office2010: 'base' });
    await createExternalWatcher(0)();
    expect(document.querySelector('.toast')).toBeNull();
    expect(calls('file.open')).toHaveLength(0);
  });

  it('間引く：間隔内の 2 回目は調べない', async () => {
    openDoc();
    host({ office2010: 'base' });
    const watch = createExternalWatcher(60000);
    await watch();
    await watch();
    expect(calls('file.fingerprint')).toHaveLength(1);
  });
});
