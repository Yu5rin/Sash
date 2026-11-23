import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, IconPrefetchStatus } from '../src/bridge';

// ホストとのやり取りを差し替える。モジュールの状態をテストごとに作り直すので、毎回読み込み直す
const { invoke, hostListeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  hostListeners: [] as ((e: HostEvent) => void)[],
}));

vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  onHostEvent: (l: (e: HostEvent) => void) => hostListeners.push(l),
}));

async function load(): Promise<typeof import('../src/msoIcons')> {
  vi.resetModules();
  hostListeners.length = 0;
  return import('../src/msoIcons');
}

const status = (patch: Partial<IconPrefetchStatus>): IconPrefetchStatus => ({ state: 'none', done: 0, total: 0, size: 32, cached: 0, excelInstalled: true, ...patch });

const emit = (e: HostEvent) => {
  for (const l of hostListeners) l(e);
};

const toastText = () => Array.from(document.querySelectorAll('.toast-message')).map((x) => x.textContent ?? '');

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('msoIcon の取得', () => {
  it('無効なら取りに行かず null', async () => {
    const m = await load();
    expect(m.msoIcon('AutoSum')).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('明示的な null だけを「存在しない」とし、含まれない名前はしばらく後に取り直す', async () => {
    const m = await load();
    m.enableMsoIcons(true);
    const loaded = vi.fn();
    m.onMsoIconsLoaded(loaded);
    invoke.mockResolvedValueOnce({ AutoSum: 'AAAA', Nope: null });

    expect(m.msoIcon('AutoSum')).toBeUndefined();
    m.msoIcon('Nope');
    m.msoIcon('Busy');
    await vi.advanceTimersByTimeAsync(50);

    expect(invoke).toHaveBeenCalledWith('excel.imageMso', { names: ['AutoSum', 'Nope', 'Busy'], size: 32 });
    expect(m.msoIcon('AutoSum')).toBe('data:image/png;base64,AAAA');
    expect(m.msoIcon('Nope')).toBeNull();
    expect([...m.missingImageMso()]).toEqual(['Nope']);
    expect(loaded).toHaveBeenCalledTimes(1);

    // 一時的に取れなかった名前は「存在しない」に入れず、待つ間は null（表示は代わりの印）
    expect(m.msoIcon('Busy')).toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(m.msoIcon('Busy')).toBeUndefined();
  });

  it('ホストへの要求が失敗したら、どれも「存在しない」にはしない', async () => {
    const m = await load();
    m.enableMsoIcons(true);
    invoke.mockRejectedValueOnce(new Error('busy'));
    m.msoIcon('AutoSum');
    await vi.advanceTimersByTimeAsync(50);

    expect(m.missingImageMso().size).toBe(0);
    expect(m.msoIcon('AutoSum')).toBeNull();
  });

  it('refreshMsoIcons は覚えたものと待ちを捨てて描き直させる', async () => {
    const m = await load();
    m.enableMsoIcons(true);
    invoke.mockResolvedValueOnce({ Nope: null });
    m.msoIcon('Nope');
    m.msoIcon('Busy');
    await vi.advanceTimersByTimeAsync(50);
    const loaded = vi.fn();
    m.onMsoIconsLoaded(loaded);

    m.refreshMsoIcons();

    expect(loaded).toHaveBeenCalledTimes(1);
    expect(m.missingImageMso().size).toBe(0);
    expect(m.msoIcon('Nope')).toBeUndefined();
    expect(m.msoIcon('Busy')).toBeUndefined();
  });
});

describe('取り込みの判断', () => {
  it('Excel があるか、キャッシュがあればアイコンを出す', async () => {
    const m = await load();
    expect(m.shouldEnableMsoIcons(true, null)).toBe(true);
    expect(m.shouldEnableMsoIcons(false, null)).toBe(false);
    expect(m.shouldEnableMsoIcons(false, status({ state: 'unavailable' }))).toBe(false);
    expect(m.shouldEnableMsoIcons(false, status({ state: 'none', cached: 10 }))).toBe(true);
    expect(m.shouldEnableMsoIcons(false, status({ state: 'done', cached: 0 }))).toBe(true);
  });

  it('自動で始めるのは、Excel があって未取り込みで、中止されていないときだけ', async () => {
    const m = await load();
    expect(m.shouldAutoPrefetch(true, status({ state: 'none' }), false)).toBe(true);
    expect(m.shouldAutoPrefetch(true, status({ state: 'none' }), true)).toBe(false);
    expect(m.shouldAutoPrefetch(true, status({ state: 'done' }), false)).toBe(false);
    expect(m.shouldAutoPrefetch(true, status({ state: 'failed' }), false)).toBe(false);
    expect(m.shouldAutoPrefetch(false, status({ state: 'none' }), false)).toBe(false);
    expect(m.shouldAutoPrefetch(true, null, false)).toBe(false);
  });

  it('状態を文にする', async () => {
    const m = await load();
    expect(m.describePrefetch(status({ state: 'running', done: 1234, total: 4162 }))).toBe('取り込んでいます… 1,234 / 4,162');
    expect(m.describePrefetch(status({ state: 'done', cached: 2081, excelVersion: '16.0.19029', cachedAt: '2026-11-23T01:00:00Z' }))).toContain('取り込み済み：2,081 件（Excel 16.0.19029・');
    expect(m.describePrefetch(status({ state: 'none', cached: 5 }))).toBe('一部だけ取り込み済み：5 件');
    expect(m.describePrefetch(status({ state: 'none' }))).toBe('まだ取り込んでいません');
    expect(m.describePrefetch(status({ state: 'failed', message: '起動できない' }))).toBe('取り込めませんでした：起動できない');
  });
});

describe('起動時と取り込みの流れ', () => {
  it('Excel がなくてもキャッシュがあればアイコンを出し、取り込みは始めない', async () => {
    const m = await load();
    invoke.mockResolvedValueOnce(status({ state: 'none', cached: 300, excelInstalled: false }));
    const loaded = vi.fn();
    m.onMsoIconsLoaded(loaded);

    await m.initMsoIcons(false, 10);
    await vi.advanceTimersByTimeAsync(100);

    expect(m.msoIconsEnabled()).toBe(true);
    expect(loaded).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('icons.prefetchStatus');
  });

  it('初めての起動では少し待ってから取り込みを始め、進み具合と完了を通知する', async () => {
    const m = await load();
    let hostState = status({ state: 'none' });
    invoke.mockImplementation((type: string) => {
      if (type === 'icons.prefetchStatus') return Promise.resolve(hostState);
      if (type === 'icons.prefetchStart') return Promise.resolve(status({ state: 'running', total: 4162 }));
      return Promise.resolve({});
    });

    await m.initMsoIcons(true, 10);
    expect(invoke).not.toHaveBeenCalledWith('icons.prefetchStart', expect.anything());
    await vi.advanceTimersByTimeAsync(20);

    const start = invoke.mock.calls.find((c) => c[0] === 'icons.prefetchStart')!;
    const req = start[1] as { names: string[]; sizes: number[]; force: boolean };
    expect(req.sizes).toEqual([32, 16]);
    expect(req.force).toBe(false);
    expect(req.names.length).toBeGreaterThan(1000);
    expect(req.names).toContain('AutoSum');
    expect(new Set(req.names).size).toBe(req.names.length);

    emit({ event: 'iconPrefetch', state: 'running', done: 1234, total: 4162 });
    expect(toastText()).toContain('Excel のアイコンを取り込んでいます… 1,234 / 4,162');
    expect(document.querySelector('.toast-action')?.textContent).toBe('中止');

    const loaded = vi.fn();
    m.onMsoIconsLoaded(loaded);
    hostState = status({ state: 'done', cached: 2000, excelVersion: '16.0.19029', cachedAt: '2026-11-23T01:00:00Z' });
    emit({ event: 'iconPrefetch', state: 'done', done: 4162, total: 4162, cached: 2000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(toastText().some((x) => x.startsWith('Excel のアイコンを取り込んでいます'))).toBe(false);
    expect(toastText()).toContain('Excel のアイコンを取り込みました（2,000 件）');
    expect(loaded).toHaveBeenCalled();
    // 完了の後は、日時や版を含む状態を取り直す
    expect(m.prefetchStatus()?.excelVersion).toBe('16.0.19029');
  });

  it('利用者が閉じた進み具合の通知は出し直さない', async () => {
    const m = await load();
    invoke.mockResolvedValue(status({ state: 'none' }));
    await m.loadPrefetchStatus();
    emit({ event: 'iconPrefetch', state: 'running', done: 50, total: 100 });
    document.querySelector<HTMLButtonElement>('.toast-close')!.click();
    emit({ event: 'iconPrefetch', state: 'running', done: 100, total: 100 });

    expect(toastText()).toEqual([]);
    expect(m.prefetchStatus()?.done).toBe(100);
  });

  it('中止したら次の起動では自動で始めない', async () => {
    const m = await load();
    invoke.mockResolvedValue(status({ state: 'none', message: 'cancelled' }));
    await m.loadPrefetchStatus();
    emit({ event: 'iconPrefetch', state: 'running', done: 50, total: 100 });

    document.querySelector<HTMLButtonElement>('.toast-action')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith('icons.prefetchCancel');
    expect(toastText()).toContain('アイコンの取り込みを中止しました。設定の「アイコン」からいつでも取り込めます。');

    const again = await load();
    invoke.mockReset();
    invoke.mockResolvedValue(status({ state: 'none' }));
    await again.initMsoIcons(true, 10);
    await vi.advanceTimersByTimeAsync(50);
    expect(invoke).not.toHaveBeenCalledWith('icons.prefetchStart', expect.anything());
  });

  it('取り込みに失敗したらエラーを通知する', async () => {
    const m = await load();
    invoke.mockResolvedValue(status({ state: 'failed', message: 'x' }));
    await m.loadPrefetchStatus();
    emit({ event: 'iconPrefetch', state: 'running', done: 0, total: 100 });
    emit({ event: 'iconPrefetch', state: 'failed', done: 100, total: 100, message: '変換できませんでした' });

    expect(toastText()).toContain('変換できませんでした');
  });
});
