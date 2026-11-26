import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeMenu } from '../src/views/contextMenu';
import { installTextFieldMenu, isTextInput, runTextFieldCommand, textMenuItems } from '../src/shell/textMenu';

const menuLabels = () => Array.from(document.querySelectorAll('.ctx-menu .ctx-item')).map((e) => e.querySelector('.ctx-label')?.textContent);
const right = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));

describe('入力欄の右クリックメニュー（総点検 G-3）', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="a" type="text"><input id="c" type="checkbox"><textarea id="t"></textarea><div id="pane">余白</div>';
    installTextFieldMenu();
  });
  afterEach(() => closeMenu());

  it('文字を入れる入力欄だけを対象にする', () => {
    expect(isTextInput(document.getElementById('a'))).toBe(true);
    expect(isTextInput(document.getElementById('t'))).toBe(true);
    expect(isTextInput(document.getElementById('c'))).toBe(false);
    expect(isTextInput(document.getElementById('pane'))).toBe(false);
  });

  it('入力欄で右クリックすると、切り取り・コピー・貼り付け・すべて選択が出る', () => {
    const input = document.getElementById('a') as HTMLInputElement;
    right(input);
    expect(menuLabels()).toEqual(['切り取り', 'コピー', '貼り付け', 'すべて選択']);
  });

  it('余白とチェックボックスでは何も出さない', () => {
    right(document.getElementById('pane')!);
    right(document.getElementById('c')!);
    expect(document.querySelector('.ctx-menu')).toBeNull();
  });

  it('選択がなければ切り取り・コピーは無効。読み取り専用なら貼り付けも無効', () => {
    const input = document.getElementById('a') as HTMLInputElement;
    input.value = 'abc';
    input.setSelectionRange(0, 0);
    let items = textMenuItems(input);
    expect(items.map((i) => !!i.disabled)).toEqual([true, true, false, false]);
    input.setSelectionRange(0, 2);
    items = textMenuItems(input);
    expect(items.map((i) => !!i.disabled)).toEqual([false, false, false, false]);
    input.readOnly = true;
    expect(textMenuItems(input).map((i) => !!i.disabled)).toEqual([true, false, true, false]);
  });

  it('貼り付けは、クリップボードの文字を選択範囲に入れて input を知らせる。改行は空白にする', async () => {
    const input = document.getElementById('a') as HTMLInputElement;
    input.value = 'ab';
    input.setSelectionRange(1, 1);
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn().mockResolvedValue('X\nY'), writeText: vi.fn() }, configurable: true });
    const onInput = vi.fn();
    input.addEventListener('input', onInput);
    textMenuItems(input)[2]!.run!();
    await new Promise((r) => setTimeout(r, 0));
    expect(input.value).toBe('aX Yb');
    expect(onInput).toHaveBeenCalled();
  });

  it('すでにほかのメニューが出ている（defaultPrevented）ときは重ねない', () => {
    const input = document.getElementById('a')!;
    input.addEventListener('contextmenu', (e) => e.preventDefault());
    right(input);
    expect(document.querySelector('.ctx-menu')).toBeNull();
  });

  const clip = (text: string) =>
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn().mockResolvedValue(text), writeText: vi.fn() }, configurable: true });

  it('貼り付けのあと change も出るので、change で確定する入力欄（インスペクタ）が値を受け取る（見直し 高1）', async () => {
    const input = document.getElementById('a') as HTMLInputElement;
    input.value = '';
    clip('Macro1');
    const onChange = vi.fn();
    input.addEventListener('change', () => onChange(input.value));
    await runTextFieldCommand(input, 'paste');
    expect(onChange).toHaveBeenCalledWith('Macro1');
  });

  it('execCommand が使えるなら、それで入れる（change はブラウザが blur 時に出す）', async () => {
    const input = document.getElementById('a') as HTMLInputElement;
    input.value = '';
    clip('abc');
    const exec = vi.fn((_c: string, _u?: boolean, v?: string) => {
      input.value += v ?? '';
      return true;
    });
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    try {
      await runTextFieldCommand(input, 'paste');
      expect(exec).toHaveBeenCalledWith('insertText', false, 'abc');
      expect(input.value).toBe('abc');
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
  });

  it('type=number・email でも例外にならず、値全体を置き換えて change を出す（見直し 高2）', async () => {
    for (const type of ['number', 'email']) {
      const input = document.createElement('input');
      input.type = type;
      document.body.append(input);
      clip(type === 'number' ? '42' : 'a@b.c');
      const onChange = vi.fn();
      input.addEventListener('change', onChange);
      await expect(runTextFieldCommand(input, 'paste')).resolves.toBeUndefined();
      expect(input.value).toBe(type === 'number' ? '42' : 'a@b.c');
      expect(onChange).toHaveBeenCalled();
      // すべて選択も落ちない
      await expect(runTextFieldCommand(input, 'selectAll')).resolves.toBeUndefined();
    }
  });

  it('失敗しても自分で受け、案内の通知にする（例外を外へ出さない）', async () => {
    const input = document.getElementById('a') as HTMLInputElement;
    clip('x');
    input.setRangeText = () => {
      throw new DOMException('x', 'InvalidStateError');
    };
    await expect(runTextFieldCommand(input, 'paste')).resolves.toBeUndefined();
    expect(document.querySelector('.toast')).not.toBeNull();
  });
});
