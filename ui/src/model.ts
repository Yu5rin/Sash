// customUI の XML から、キャンバスとツリーの表示に使う最小限のノードを作る。
// 第 1 弾で、属性の並び順とコメントを保持する本格的なモデルに置き換える（仕様書 §5.5）。

export interface UINode {
  tag: string;
  id: string | null;
  label: string | null;
  attrs: Record<string, string>;
  children: UINode[];
}

export type ParseResult = { ok: true; root: UINode } | { ok: false; message: string };

export function parseCustomUI(xml: string): ParseResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) return { ok: false, message: error.textContent?.trim() ?? 'XMLの構文エラー' };
  return { ok: true, root: toNode(doc.documentElement) };
}

function toNode(el: Element): UINode {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (a.name !== 'xmlns' && !a.name.startsWith('xmlns:')) attrs[a.name] = a.value;
  }
  return {
    tag: el.localName,
    id: el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ'),
    label: el.getAttribute('label'),
    attrs,
    children: Array.from(el.children).map(toNode),
  };
}

/** タブの一覧（customUI > ribbon > tabs > tab）。 */
export function tabsOf(root: UINode): UINode[] {
  const ribbon = root.children.find((c) => c.tag === 'ribbon');
  const tabs = ribbon?.children.find((c) => c.tag === 'tabs');
  return tabs?.children.filter((c) => c.tag === 'tab') ?? [];
}
