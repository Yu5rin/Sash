import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCommandPalette, rankCommands, type Command } from '../src/dialogs/commandPalette';
import { mountMenubar, type MenuDef } from '../src/shell/menubar';

const key = (el: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

describe('メニュー項目のアクセスキー（総点検 G-4）', () => {
  const save = vi.fn();
  const saveAs = vi.fn();
  const close = vi.fn();
  const disabled = vi.fn();

  // メニューバーは window にキー入力の受け口を足すので、1 回だけ作って使い回す
  beforeAll(() => {
    document.body.innerHTML = '<div id="menubar"></div><button id="x">x</button>';
    const menus: MenuDef[] = [{
      id: 'file', label: 'ファイル', mnemonic: 'F', items: () => [
        { label: '保存', mnemonic: 'S', run: save },
        { label: '別名で保存', mnemonic: 'A', run: saveAs },
        { label: '閉じる', mnemonic: 'C', run: close },
        { label: '無効な項目', mnemonic: 'D', enabled: false, run: disabled },
      ],
    }];
    mountMenubar(document.getElementById('menubar')!, menus);
  });
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => key(document.querySelector('.menu-popup') ?? document.body, 'Escape'));

  const openFile = () => key(window, 'KeyF', { altKey: true, code: 'KeyF' } as KeyboardEventInit);
  const popup = () => document.querySelector('.menu-popup') as HTMLElement;

  it('項目に「保存(S)」の形でアクセスキーを出す', () => {
    openFile();
    const labels = Array.from(popup().querySelectorAll('.mi-label')).map((e) => e.textContent);
    expect(labels).toEqual(['保存(S)', '別名で保存(A)', '閉じる(C)', '無効な項目(D)']);
  });

  it('Alt+F のあと S を押すと「保存」が実行され、メニューが閉じる', () => {
    openFile();
    key(popup(), 'S');
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.menu-popup')).toBeNull();
  });

  it('大文字・小文字を区別しない。別の項目は実行しない', () => {
    openFile();
    key(popup(), 'c');
    expect(close).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('無効な項目のアクセスキーは何もしない', () => {
    openFile();
    key(popup(), 'd');
    expect(disabled).not.toHaveBeenCalled();
  });
});

describe('コマンドパレットは、使えないコマンドも理由つきで出す（総点検 D-11）', () => {
  const cmd = (id: string, title: string, enabled: boolean, run = vi.fn(), disabledReason?: () => string | undefined): Command =>
    ({ id, title, group: '編集', enabled: () => enabled, run, disabledReason });

  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollIntoView = () => undefined;
  });

  it('並びは使えるものが先。使えないものは後ろ', () => {
    const ranked = rankCommands([cmd('a', '履歴を見る', false), cmd('b', '履歴を消す', true)], '履歴');
    expect(ranked.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('何も打っていないときは使えるものだけ。探すと薄く出て、理由を添える', () => {
    const run = vi.fn();
    const commands = [cmd('open', '開く', true), cmd('history', '操作の履歴…', false, run, () => '操作の履歴がありません')];
    openCommandPalette(() => commands);
    const input = document.querySelector<HTMLInputElement>('.command-palette input')!;
    expect(Array.from(document.querySelectorAll('.palette-results li[role="option"]')).map((e) => e.querySelector('.cmd-title')!.textContent)).toEqual(['開く']);
    input.value = '履歴';
    input.dispatchEvent(new Event('input'));
    const rows = Array.from(document.querySelectorAll('.palette-results li[role="option"]'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classList.contains('disabled')).toBe(true);
    expect(rows[0]!.getAttribute('aria-disabled')).toBe('true');
    expect(rows[0]!.querySelector('.cmd-reason')!.textContent).toBe('操作の履歴がありません');
    // Enter では実行せず、理由を読み上げる
    key(input, 'Enter');
    expect(run).not.toHaveBeenCalled();
    expect(document.querySelector('.command-palette [role="status"]')!.textContent).toContain('操作の履歴がありません');
    expect(document.querySelector('.command-palette')).not.toBeNull();
    key(document, 'Escape');
  });
});
