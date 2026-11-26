import { describe, expect, it, vi } from 'vitest';
import { createPollGate } from '../src/shell/pollGate';

describe('問い合わせの門番（見直し 中4）', () => {
  it('問い合わせ中は重ねない', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    const gate = createPollGate(run, { minIntervalMs: 0, busy: () => false });
    void gate();
    void gate();
    expect(run).toHaveBeenCalledTimes(1);
    release();
  });

  it('間隔が空くまで、強制でない呼び出しは見送る。強制は間引きだけ飛ばす', async () => {
    let t = 0;
    const run = vi.fn(async () => undefined);
    const gate = createPollGate(run, { minIntervalMs: 30_000, busy: () => false, now: () => t });
    await gate();
    t = 10_000;
    await gate();
    expect(run).toHaveBeenCalledTimes(1);
    await gate(true);
    expect(run).toHaveBeenCalledTimes(2);
    t = 50_000;
    await gate();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('busy の間は強制でも送らない', async () => {
    let b = true;
    const run = vi.fn(async () => undefined);
    const gate = createPollGate(run, { minIntervalMs: 0, busy: () => b });
    await gate(true);
    expect(run).not.toHaveBeenCalled();
    b = false;
    await gate(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('問い合わせ中に強制が来たら、終わってから 1 回だけ取り直す', async () => {
    const releases: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((r) => releases.push(r)));
    const gate = createPollGate(run, { minIntervalMs: 0, busy: () => false });
    const p = gate();
    void gate(true);
    void gate(true);
    releases[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(2);
    releases[1]!();
    await p;
  });

  it('run が失敗しても次を受け付ける', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const gate = createPollGate(run, { minIntervalMs: 0, busy: () => false });
    await expect(gate()).rejects.toThrow();
    await gate();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
