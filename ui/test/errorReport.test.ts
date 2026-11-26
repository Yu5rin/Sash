import { beforeEach, describe, expect, it } from 'vitest';
import { describeUnexpected, installErrorReporting, reportUnexpected, resetErrorReport } from '../src/shell/errorReport';

const toasts = () => Array.from(document.querySelectorAll('.toast')).map((e) => e.textContent ?? '');

describe('想定外の例外の受け皿（総点検 G-5）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetErrorReport();
  });

  it('例外から文とスタックを取り出す。Error 以外の値も読める', () => {
    expect(describeUnexpected(new Error('壊れた')).message).toBe('壊れた');
    expect(describeUnexpected('文字列').message).toBe('文字列');
    expect(describeUnexpected({ a: 1 }).message).toBe('{"a":1}');
    expect(describeUnexpected(undefined).message).toBe('undefined');
  });

  it('通知で知らせ、同じ文言は 1 回だけ出す', () => {
    reportUnexpected(new Error('その場で壊れた'));
    reportUnexpected(new Error('その場で壊れた'));
    reportUnexpected(new Error('別の失敗'));
    const list = toasts();
    expect(list.filter((x) => x.includes('その場で壊れた'))).toHaveLength(1);
    expect(list.some((x) => x.includes('予期しないエラーが起きました：その場で壊れた'))).toBe(true);
    expect(list.some((x) => x.includes('別の失敗'))).toBe(true);
  });

  it('害のないブラウザの通知（ResizeObserver）は出さない', () => {
    reportUnexpected(new Error('ResizeObserver loop completed with undelivered notifications.'));
    expect(toasts()).toHaveLength(0);
  });

  it('window の error と unhandledrejection を拾う', () => {
    installErrorReporting();
    installErrorReporting();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('同期の例外'), message: '同期の例外' }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('非同期の失敗');
    window.dispatchEvent(rejection);
    const list = toasts();
    expect(list.filter((x) => x.includes('同期の例外'))).toHaveLength(1);
    expect(list.some((x) => x.includes('非同期の失敗'))).toBe(true);
  });
});
