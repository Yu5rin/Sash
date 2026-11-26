// ホームのドロップの案内と「はじめての方へ」（総点検 H-1〜H-3）。
import { describe, expect, it, vi } from 'vitest';
import { mountHome } from '../src/views/home';

describe('H-1・H-2 ホームのドロップの案内', () => {
  it('1 行の案内は押せる（押すとファイルの選択を開く）。「はじめての方へ」の 1 番は短い見出し', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const open = vi.fn();
    mountHome(host, open).refresh();
    const note = host.querySelector<HTMLButtonElement>('button.home-drop-note');
    expect(note).not.toBeNull();
    note!.click();
    expect(open).toHaveBeenCalledWith();
    const first = host.querySelector('.onboarding-steps li strong')!;
    expect(first.textContent).toBe('Excel でブックを保存');
    host.remove();
  });
});
