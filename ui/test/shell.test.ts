import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSize, matchShortcut, normalizeForSearch, splitPath } from '../src/shell/text';
import { ask, isModalOpen, openModal, openOnce } from '../src/dialogs/modal';
import { clearToasts, toast } from '../src/shell/toast';
import { rankCommands, type Command } from '../src/dialogs/commandPalette';

const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({ key: k, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt });

describe('normalizeForSearch', () => {
  it('ひらがなとカタカナ、全角と半角、大文字と小文字をそろえる', () => {
    expect(normalizeForSearch('ボタン')).toBe(normalizeForSearch('ぼたん'));
    expect(normalizeForSearch('ＸＭＬ')).toBe('xml');
    expect(normalizeForSearch('ｴｸｾﾙ')).toBe(normalizeForSearch('エクセル'));
  });
});

describe('matchShortcut', () => {
  it('修飾キーまで一致したときだけ当たる', () => {
    expect(matchShortcut(key('s', { ctrl: true }), 'Ctrl+S')).toBe(true);
    expect(matchShortcut(key('S', { ctrl: true, shift: true }), 'Ctrl+S')).toBe(false);
    expect(matchShortcut(key('F', { shift: true, alt: true }), 'Shift+Alt+F')).toBe(true);
    expect(matchShortcut(key('Delete'), 'Del')).toBe(true);
    expect(matchShortcut(key('F6', { shift: true }), 'F6')).toBe(false);
    expect(matchShortcut(key('1', { ctrl: true }), 'Ctrl+1')).toBe(true);
  });
});

describe('小さな整形', () => {
  it('サイズとパス', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(splitPath('C:\\a\\b.xlam')).toEqual({ name: 'b.xlam', folder: 'C:\\a' });
  });
});

describe('コマンドパレットの並び', () => {
  const cmd = (id: string, title: string): Command => ({ id, title, group: 'G', run: () => undefined });
  it('カタカナの名前をひらがなで探せる', () => {
    expect(rankCommands([cmd('a', '保存'), cmd('b', 'ボタンを追加')], 'ぼたん').map((c) => c.id)).toEqual(['b']);
  });
});

describe('ダイアログの重なり', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('Esc は一番上のダイアログだけを閉じ、背景を inert にする', () => {
    document.body.append(Object.assign(document.createElement('div'), { id: 'app' }));
    const a = openModal('A', document.createElement('div'));
    const b = openModal('B', document.createElement('div'));
    expect(document.getElementById('app')!.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(b.root.isConnected).toBe(false);
    expect(a.root.isConnected).toBe(true);
    a.close();
    expect(isModalOpen()).toBe(false);
    expect(document.getElementById('app')!.inert).toBe(false);
  });

  it('closable: false なら Esc で閉じない', () => {
    const m = openModal('更新中', document.createElement('div'), { closable: false });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(m.root.isConnected).toBe(true);
    m.close();
  });

  it('同じ key のダイアログは二重に開かない', async () => {
    const fn = vi.fn(() => openModal('S', document.createElement('div')));
    await openOnce('settings', fn);
    await openOnce('settings', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.modal').length).toBe(1);
  });

  it('ask は主ボタンを右端に置き、閉じたら null を返す', async () => {
    const p = ask('t', 'm', [{ value: 'save', label: '保存', primary: true }, { value: 'no', label: 'しない' }]);
    const buttons = Array.from(document.querySelectorAll('.modal footer button'));
    expect(buttons.at(-1)!.textContent).toBe('保存');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p).toBeNull();
  });
});

describe('通知', () => {
  afterEach(() => clearToasts());

  it('最大 3 件まで。エラーは閉じるまで残し role=alert にする', () => {
    vi.useFakeTimers();
    toast({ kind: 'error', message: 'e' });
    toast({ kind: 'info', message: '1' });
    toast({ kind: 'info', message: '2' });
    toast({ kind: 'success', message: '3' });
    const els = Array.from(document.querySelectorAll('.toast'));
    expect(els.length).toBe(3);
    expect(els[0]!.getAttribute('role')).toBe('alert');
    vi.advanceTimersByTime(10000);
    expect(Array.from(document.querySelectorAll('.toast')).map((e) => e.querySelector('.toast-message')!.textContent)).toEqual(['e']);
    vi.useRealTimers();
  });

  it('エラーが 3 件残っていても、新しい通知はすぐには消えず、いちばん古いエラーが閉じる', () => {
    const texts = () => Array.from(document.querySelectorAll('.toast')).map((e) => e.querySelector('.toast-message')!.textContent);
    toast({ kind: 'error', message: 'e1' });
    toast({ kind: 'error', message: 'e2' });
    toast({ kind: 'error', message: 'e3' });
    toast({ kind: 'success', message: '保存しました' });
    expect(texts()).toEqual(['e2', 'e3', '保存しました']);
    toast({ kind: 'error', message: 'e4' });
    // 古いほうのエラーより、エラーでない通知を先に閉じる
    expect(texts()).toEqual(['e2', 'e3', 'e4']);
  });
});
