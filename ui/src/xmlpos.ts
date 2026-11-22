// XML テキスト上の要素の位置を調べる。DOM は位置情報を持たないため、
// テキストを軽く走査して「文書順で n 番目の要素」が何文字目から何文字目までかを求める。
// エラー位置の表示（波線）と、カーソル位置と選択の同期に使う。

export interface ElementSpan {
  /** 開始タグの "<" の位置。 */
  start: number;
  /** 開始タグの ">" の直後の位置。 */
  startTagEnd: number;
  /** 要素全体の終わり（終了タグの ">" の直後）。 */
  end: number;
  tag: string;
}

export function scanElements(text: string): ElementSpan[] {
  const spans: ElementSpan[] = [];
  const stack: number[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const close = text.indexOf('>', lt + 2);
      i = close < 0 ? n : close + 1;
      continue;
    }
    const gt = findTagEnd(text, lt + 1);
    if (gt < 0) break;
    if (text[lt + 1] === '/') {
      const idx = stack.pop();
      if (idx !== undefined) spans[idx]!.end = gt + 1;
      i = gt + 1;
      continue;
    }
    const nameMatch = /^[^\s/>]+/.exec(text.slice(lt + 1, gt));
    const tag = (nameMatch?.[0] ?? '').replace(/^.*:/, '');
    const selfClosing = text[gt - 1] === '/';
    spans.push({ start: lt, startTagEnd: gt + 1, end: gt + 1, tag });
    if (!selfClosing) stack.push(spans.length - 1);
    i = gt + 1;
  }
  return spans;
}

/** 引用符の中の ">" を無視してタグの終わりを探す。 */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/** 位置を含む最も内側の要素の番号（文書順）を返す。 */
export function elementIndexAt(spans: readonly ElementSpan[], offset: number): number {
  let found = -1;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (s.start > offset) break;
    if (offset >= s.start && offset < s.end) found = i;
  }
  return found;
}

/** 開始タグの中で、属性名が何文字目にあるかを返す（見つからなければ null）。 */
export function attrRange(text: string, span: ElementSpan, attr: string): { start: number; end: number } | null {
  const tagText = text.slice(span.start, span.startTagEnd);
  const re = new RegExp(`\\s(${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*=\\s*("[^"]*"|'[^']*')`);
  const m = re.exec(tagText);
  if (!m) return null;
  const start = span.start + m.index + 1;
  return { start, end: start + m[0].length - 1 };
}
