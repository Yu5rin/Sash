// ツリーの絞り込み（仕様書 §5.3）。DOM の描画から切り離した純粋な判定にして、テストできるようにする。
// 要素が多いファイル（メニューの中身が深いものなど）で、目当ての要素をラベル・id・コールバック名から探せるようにするため。

import { allElements } from './model';
import { attributes } from './schema';

/**
 * 比べる前の正規化。全角・半角をそろえ（NFKC）、小文字にする。
 * 「ＢＴＮ」でも btn に当たり、大文字小文字を気にせず探せるようにするため。
 */
export function normalizeQuery(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

/**
 * 絞り込みの対象にする属性の値。ラベル・id・idMso・idQ・imageMso と、コールバック名（onAction・getLabel など）。
 * 表示中の文字（ラベル）だけでなく、VBA の Sub 名からも要素を探せるようにする（「この Sub はどのボタン？」に答えるため）。
 */
export function searchableValues(el: Element): string[] {
  const out: string[] = [];
  for (const name of ['label', 'id', 'idMso', 'idQ', 'imageMso', 'image']) {
    const v = el.getAttribute(name);
    if (v) out.push(v);
  }
  for (const a of Array.from(el.attributes)) {
    if (a.value && attributes.get(a.name)?.kind === 'callback') out.push(a.value);
  }
  return out;
}

/** 要素が検索語に合うか。空白で区切った語は、すべてがどれかの値に含まれるもの（AND）だけを合うとする。 */
export function elementMatches(el: Element, query: string): boolean {
  const tokens = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const values = searchableValues(el).map(normalizeQuery);
  return tokens.every((tok) => values.some((v) => v.includes(tok)));
}

export interface TreeFilterResult {
  /** 検索語に合った要素。 */
  matches: Set<Element>;
  /** 表示する要素（合った要素とその祖先）。祖先を残すのは、どこに置かれているかが分からなくなるため。 */
  visible: Set<Element>;
}

/** 文書全体を絞り込む。query が空なら null（絞り込まない）。 */
export function filterTree(doc: Document, query: string): TreeFilterResult | null {
  if (!normalizeQuery(query)) return null;
  const matches = new Set<Element>();
  const visible = new Set<Element>();
  for (const el of allElements(doc)) {
    if (!elementMatches(el, query)) continue;
    matches.add(el);
    for (let cur: Element | null = el; cur && !visible.has(cur); cur = cur.parentElement) visible.add(cur);
  }
  return { matches, visible };
}

/**
 * 表示する文字列の中で、検索語に合った部分を [前, 合った部分, 後…] に分ける（強調表示用）。
 * NFKC で文字数が変わる文字（「㍿」など）があると位置がずれるので、正規化しても長さが同じときだけ分ける。
 */
export function splitHighlight(text: string, query: string): { text: string; hit: boolean }[] {
  const tokens = normalizeQuery(query).split(/\s+/).filter(Boolean);
  const norm = text.normalize('NFKC').toLowerCase();
  if (tokens.length === 0 || norm.length !== text.length) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const tok of tokens) {
    for (let i = norm.indexOf(tok); i >= 0; i = norm.indexOf(tok, i + 1)) marks.fill(true, i, i + tok.length);
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: marks[i]! });
  }
  return parts;
}
