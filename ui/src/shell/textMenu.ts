// 入力欄の右クリックメニュー（切り取り・コピー・貼り付け・すべて選択）。
// 製品版は WebView2 の既定の右クリックメニューを切っているので（誤って「ページを再読み込み」などが出ないように）、
// 何も出ないと「右クリック → 貼り付け」に慣れた人が VBA の Sub 名などを貼り付けられない（総点検 G-3）。
// XML エディタは Monaco 自身のメニューを使う（views/monacoApi.ts）。ペインの余白など、入力欄以外では何も出さない。

import { t } from '../i18n';
import { openMenu, type MenuItem } from '../views/contextMenu';
import { toast } from './toast';

/** 文字を入れる入力欄か。チェックボックス・色の入力などは除く。 */
export function isTextInput(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return ['text', 'search', 'number', 'url', 'tel', 'email', 'password'].includes(el.type);
}

/** 選択範囲の文字。 */
function selectedText(el: HTMLInputElement | HTMLTextAreaElement): string {
  const s = el.selectionStart ?? 0;
  const e = el.selectionEnd ?? 0;
  return e > s ? el.value.slice(s, e) : '';
}

/** 貼り付けられないとき（権限がない・クリップボードが空など）の案内。 */
function pasteFailed(): void {
  toast({ kind: 'info', message: t('貼り付けできませんでした。Ctrl+V で貼り付けられます') });
}

/** 入力欄での切り取り・コピー・貼り付け。メニューを閉じてフォーカスが入力欄に戻ったあとに呼ぶ。 */
export async function runTextFieldCommand(el: HTMLInputElement | HTMLTextAreaElement, command: 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<void> {
  el.focus();
  if (command === 'selectAll') {
    el.select();
    return;
  }
  if (command !== 'paste') {
    if (!document.execCommand(command)) {
      // execCommand が使えない環境では、クリップボードへ直接書く
      const text = selectedText(el);
      if (text) await navigator.clipboard.writeText(text).catch(() => undefined);
      if (command === 'cut' && text) {
        el.setRangeText('', el.selectionStart ?? 0, el.selectionEnd ?? 0, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return;
  }
  const text = await navigator.clipboard.readText().catch(() => null);
  if (text === null) {
    pasteFailed();
    return;
  }
  // 1 行の入力欄に改行は入れない
  const value = el instanceof HTMLTextAreaElement ? text : text.replace(/\r?\n/g, ' ');
  el.setRangeText(value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** メニューの項目を作る（テストのため分けてある）。 */
export function textMenuItems(el: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  const hasSel = selectedText(el) !== '';
  const editable = !el.readOnly && !el.disabled;
  return [
    { label: t('切り取り'), shortcut: 'Ctrl+X', disabled: !hasSel || !editable || el.type === 'password', run: () => void runTextFieldCommand(el, 'cut') },
    { label: t('コピー'), shortcut: 'Ctrl+C', disabled: !hasSel || el.type === 'password', run: () => void runTextFieldCommand(el, 'copy') },
    { label: t('貼り付け'), shortcut: 'Ctrl+V', disabled: !editable, run: () => void runTextFieldCommand(el, 'paste') },
    { label: t('すべて選択'), shortcut: 'Ctrl+A', disabled: el.value === '', run: () => void runTextFieldCommand(el, 'selectAll') },
  ];
}

let installed = false;

/** document で右クリックを 1 か所で受ける。2 回呼んでも 1 回だけ登録する。 */
export function installTextFieldMenu(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('contextmenu', (e) => {
    // キャンバス・ツリーが自分のメニューを出したあとは何もしない。Monaco（XML エディタ）も自分のメニューを持つ
    if (e.defaultPrevented) return;
    const target = e.target;
    if (!isTextInput(target) || (target instanceof HTMLElement && target.closest('.monaco-editor'))) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, textMenuItems(target), { restoreFocus: target });
  });
}
