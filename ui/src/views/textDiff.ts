// XML エディタに外からの変更を流し込むときの差分（Monaco に依存しないので、ここだけを単体テストできる）。

/**
 * 外から来た文字列の変更を、差分の部分だけ置き換えて反映する（不具合 3）。
 * 全体を置き換えると、カーソル・選択・スクロール位置が失われ、Monaco の Undo で全体が選択されてしまう。
 */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  return { start, end: endB, text: after.slice(start, endA) };
}
