// 編集メニューの「切り取り・コピー・貼り付け・複製・削除」を、フォーカスのあるビューへ届ける。
//
// ■ 'sash:command' の取り決め（ビューの担当向け）
//   window に CustomEvent('sash:command', { detail: { command, source, target }, cancelable: true }) を送る。
//   - command: 'cut' | 'copy' | 'paste' | 'duplicate' | 'remove'
//   - source:  'menu' | 'keyboard' | 'palette'（どこから呼ばれたか）
//   - target:  送った時点の document.activeElement（どのビューの操作か判断するため）
//   受け取ったビューは、自分が処理したら e.preventDefault() を呼ぶこと。誰も処理しなければ、シェルが従来の動き
//   （複製・削除は選択中の要素に対して、切り取り・コピーは要素の XML をクリップボードへ、入力欄では文字の操作）を行う。
//   Ctrl+X / C / V / D と Delete はシェルが受けてこのイベントにする（入力欄と XML エディタの中を除く）ので、
//   ビューの側で同じキーを window に登録しないこと（二重に動くため）。

export type EditCommand = 'cut' | 'copy' | 'paste' | 'duplicate' | 'remove';

export interface SashCommandDetail {
  command: EditCommand;
  source: 'menu' | 'keyboard' | 'palette';
  target: Element | null;
}

/** イベントを送る。どこかのビューが処理したら true。 */
export function dispatchEditCommand(command: EditCommand, source: SashCommandDetail['source']): boolean {
  const e = new CustomEvent<SashCommandDetail>('sash:command', { detail: { command, source, target: document.activeElement }, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

/** 入力欄（XML エディタを含む）にフォーカスがあるか。 */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.closest('#xml-editor, .monaco-editor') !== null || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** 入力欄の中での切り取り・コピー・貼り付け（メニューから呼ばれたとき）。 */
export async function textFieldCommand(command: 'cut' | 'copy' | 'paste'): Promise<boolean> {
  const el = document.activeElement as HTMLElement | null;
  if (!inTextField(el)) return false;
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
