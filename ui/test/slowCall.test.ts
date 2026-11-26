import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyIfSlow, SLOW_AFTER_MS, STOPPED_WAITING, waitStoppable } from '../src/shell/slowCall';
import { clearToasts } from '../src/shell/toast';

const toasts = () => Array.from(document.querySelectorAll('.toast')).map((e) => e.textContent ?? '');

describe('Excel が応答しないときの待ち（総点検 W-5）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });
  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it('15 秒以内に終われば、通知を出さずにそのまま結果を返す', async () => {
    const onSlow = vi.fn();
    const p = waitStoppable(Promise.resolve('ok'), { onSlow, onLate: vi.fn() });
    await expect(p).resolves.toBe('ok');
    vi.advanceTimersByTime(SLOW_AFTER_MS + 1);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('15 秒を超えたら onSlow に stop を渡す。stop すると先に戻り、後から届いた結果は onLate に渡す', async () => {
    let finish!: (v: string) => void;
    const call = new Promise<string>((r) => (finish = r));
    const onLate = vi.fn();
    let stop = () => undefined as void;
    const p = waitStoppable(call, { onSlow: (s) => (stop = s), onLate });
    vi.advanceTimersByTime(SLOW_AFTER_MS + 1);
    stop();
    await expect(p).resolves.toBe(STOPPED_WAITING);
    finish('late');
    await Promise.resolve();
    await Promise.resolve();
    expect(onLate).toHaveBeenCalledWith({ value: 'late' });
  });

  it('待つのをやめたあとの失敗も onLate に渡す（握りつぶさない）', async () => {
    let fail!: (e: Error) => void;
    const call = new Promise<string>((_, r) => (fail = r));
    const onLate = vi.fn();
    let stop = () => undefined as void;
    const p = waitStoppable(call, { onSlow: (s) => (stop = s), onLate });
    vi.advanceTimersByTime(SLOW_AFTER_MS + 1);
    stop();
    await p;
    fail(new Error('壊れた'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onLate).toHaveBeenCalledWith({ error: expect.objectContaining({ message: '壊れた' }) });
  });

  it('stop しなければ、遅くても最後は結果が返る', async () => {
    let finish!: (v: number) => void;
    const p = waitStoppable(new Promise<number>((r) => (finish = r)), { onSlow: vi.fn(), onLate: vi.fn() });
    vi.advanceTimersByTime(SLOW_AFTER_MS + 1);
    finish(3);
    await expect(p).resolves.toBe(3);
  });

  it('notifyIfSlow は遅いときだけ通知を出し、終わったら閉じる', async () => {
    let finish!: () => void;
    const call = notifyIfSlow(new Promise<void>((r) => (finish = r)));
    vi.advanceTimersByTime(SLOW_AFTER_MS - 1);
    expect(toasts()).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(toasts().some((x) => x.includes('Excel の応答を待っています'))).toBe(true);
    finish();
    await call;
    await Promise.resolve();
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
  });
});
