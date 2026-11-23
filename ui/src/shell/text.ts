// 検索とショートカットのための小さな文字列処理。DOM に依存しないのでテストしやすい。

/**
 * 検索用に文字列をそろえる。
 * - NFKC で全角英数・半角カナをそろえる（「ＸＭＬ」「ｴｸｾﾙ」でも引けるように）
 * - 大文字小文字を区別しない
 * - カタカナをひらがなにする（「ぼたん」で「ボタン」を引けるように）
 */
export function normalizeForSearch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** "Ctrl+Shift+K" のような表記を、押されたキーと突き合わせる。 */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchShortcut(e: KeyLike, shortcut: string): boolean {
  const parts = shortcut.split('+').map((p) => p.trim());
  const keyName = parts.pop()!;
  const want = { ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt') };
  const ctrl = e.ctrlKey || (e.metaKey ?? false);
  if (ctrl !== want.ctrl || e.altKey !== want.alt) return false;
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const expected = keyName === 'Del' ? 'Delete' : keyName === 'Esc' ? 'Escape' : keyName.length === 1 ? keyName.toUpperCase() : keyName;
  if (e.shiftKey !== want.shift) return false;
  return key === expected;
}

/** バイト数を読みやすくする（バックアップの一覧など）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** パスからファイル名とフォルダを分ける。Windows と / の両方の区切りに対応する。 */
export function splitPath(path: string): { name: string; folder: string } {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i < 0 ? { name: path, folder: '' } : { name: path.slice(i + 1), folder: path.slice(0, i) };
}
