import { afterEach, describe, expect, it } from 'vitest';
import { confirmOpenDialogs, openModal } from '../src/dialogs/modal';
import { h } from '../src/dom';

// beforeClose：×・Esc・背景のクリックで閉じる前に確かめる（描いた内容を、確かめずに捨てないため）。渡さないダイアログは今までどおり。

const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('モーダルの beforeClose', () => {
  it('false を返すと、Esc・×・背景のクリックで閉じない', async () => {
    let asked = 0;
    const m = openModal('t', h('div'), { beforeClose: () => (asked++, false) });
    esc();
    await flush();
    m.root.querySelector<HTMLButtonElement>('.modal-close')!.click();
    await flush();
    const backdrop = m.root.parentElement!;
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    expect(asked).toBe(3);
    expect(document.contains(m.root)).toBe(true);
    m.close();
  });

  it('true（Promise でも）を返すと閉じる', async () => {
    let closed = 0;
    const m = openModal('t', h('div'), { beforeClose: async () => true, onClose: () => closed++ });
    esc();
    await flush();
    await flush();
    expect(closed).toBe(1);
    expect(document.contains(m.root)).toBe(false);
  });

  it('確認の途中の Esc は、確認を二重に出さない', async () => {
    let asked = 0;
    let release: (v: boolean) => void = () => undefined;
    const m = openModal('t', h('div'), { beforeClose: () => (asked++, new Promise<boolean>((r) => (release = r))) });
    esc();
    esc();
    await flush();
    expect(asked).toBe(1);
    release(false);
    await flush();
    esc();
    await flush();
    expect(asked).toBe(2);
    m.close();
  });

  it('close() は確かめずに閉じる（［完了］など、プログラムから閉じるとき）', () => {
    let asked = 0;
    const m = openModal('t', h('div'), { beforeClose: () => (asked++, false) });
    m.close();
    expect(asked).toBe(0);
    expect(document.contains(m.root)).toBe(false);
  });

  it('確かめる処理が失敗しても、閉じられなくならない', async () => {
    const m = openModal('t', h('div'), { beforeClose: () => Promise.reject(new Error('x')) });
    esc();
    await flush();
    await flush();
    expect(document.contains(m.root)).toBe(false);
  });

  it('beforeClose を渡さないダイアログは、今までどおり Esc ですぐ閉じる', () => {
    const m = openModal('t', h('div'));
    esc();
    expect(document.contains(m.root)).toBe(false);
  });

  it('xl の大きさの印が付く', () => {
    const m = openModal('t', h('div'), { size: 'xl' });
    expect(m.root.classList.contains('size-xl')).toBe(true);
    m.close();
  });

  it('confirmOpenDialogs：確認を持つダイアログが断れば false（ウィンドウの × で終わる前の確認）', async () => {
    const plain = openModal('a', h('div'));
    const guarded = openModal('b', h('div'), { beforeClose: () => false });
    expect(await confirmOpenDialogs()).toBe(false);
    guarded.close();
    expect(await confirmOpenDialogs()).toBe(true);
    plain.close();
  });

  it('submitOnEnter: false のダイアログは、Enter で主ボタンを押さない', () => {
    let clicked = 0;
    const primary = h('button', { type: 'button', class: 'primary', onclick: () => clicked++ }, 'ok');
    const input = h('input', { type: 'checkbox' });
    const m = openModal('t', h('div', null, input), { footer: [primary], submitOnEnter: false });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(clicked).toBe(0);
    m.close();
    const m2 = openModal('t', h('div', null, h('input', { type: 'checkbox' })), { footer: [primary] });
    m2.root.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(clicked).toBe(1);
    m2.close();
  });
});
