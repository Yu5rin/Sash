// 編集メニューの「切り取り・コピー・貼り付け・複製・削除」の行き先を決める。
// - 入力欄（XML エディタを含む）にフォーカスがあれば、文字の操作として行う
// - それ以外は、要素の操作として clipboard.ts（キャンバス・ツリーと共通）に任せる
// キャンバスとツリーは自分でキー（Ctrl+X など）を受けて伝播を止めるので、ここが受けるのはそれ以外の場所のキーだけ。

import { runCommand, type EditCommand } from '../clipboard';

export type { EditCommand };

/** 入力欄（XML エディタを含む）にフォーカスがあるか。 */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.closest('#xml-editor, .monaco-editor') !== null || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** 入力欄の中での切り取り・コピー・貼り付け。 */
async function textFieldCommand(command: 'cut' | 'copy' | 'paste'): Promise<boolean> {
  const el = document.activeElement as HTMLElement | null;
  if (command !== 'paste') return document.execCommand(command);
  // 貼り付けは execCommand では動かないので、クリップボードを読んで差し込む
  const text = await navigator.clipboard.readText().catch(() => null);
  if (text === null) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return document.execCommand('insertText', false, text);
}

/** メニュー・ショートカット・コマンドパレットからの編集操作。 */
export function runEditCommand(command: EditCommand): void {
  if (inTextField(document.activeElement) && (command === 'cut' || command === 'copy' || command === 'paste')) {
    void textFieldCommand(command);
    return;
  }
  runCommand(command, 'other');
}
