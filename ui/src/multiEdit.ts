// 複数の要素をまとめて編集する操作（仕様書 §19）。削除・複製・上下の移動・ドロップでの移動・新しいグループへの移動。
// ここは文書（DOM）とパスだけを扱い、ストアやビューには依存しない（テストしやすくするため）。
// どの関数も store.edit の中で呼ぶ前提で、文書を書き換える。置けないと分かったら、書き換えずに理由を返すか、
// 書き換えたあとで並び順を確かめて理由を返す（呼び出し側は ABORT を返して、ストアに文書を戻してもらう）。

import {
  allowedInsertIndex, canDuplicate, comparePaths, createElement, elementAt, insertAt, isAncestorPath, pathOf, renameDuplicateIds, samePath, usedIds, type Path,
} from './model';
import { canContainEl, inBackstage, titleOf } from './schema';
import { t } from './i18n';

export type MultiResult = { paths: Path[] } | { error: string };

/** 重なりを外して文書の順に並べ、祖先と一緒に選ばれている子孫を外す（祖先を動かせば子孫も一緒に動くため）。 */
export function topLevelPaths(paths: readonly Path[]): Path[] {
  const sorted: Path[] = [];
  for (const p of [...paths].sort(comparePaths)) if (!sorted.some((q) => samePath(p, q))) sorted.push(p);
  return sorted.filter((p) => !sorted.some((q) => isAncestorPath(q, p)));
}

/** パスの要素（文書の順、祖先と一緒に選ばれた子孫は除く）。指せないパスは飛ばす。 */
export function elementsAt(doc: Document, paths: readonly Path[]): Element[] {
  return topLevelPaths(paths).map((p) => elementAt(doc, p)).filter((e): e is Element => e !== null);
}

/** すべて同じ親の子なら、その親。 */
export function commonParent(els: readonly Element[]): Element | null {
  const parent = els[0]?.parentElement ?? null;
  return parent && els.every((e) => e.parentElement === parent) ? parent : null;
}

/** 表示用の名前（ラベル、なければ id）。 */
function nameOf(el: Element): string {
  return el.getAttribute('label') ?? el.getAttribute('id') ?? el.getAttribute('idMso') ?? titleOf(el.localName);
}

/**
 * 親の子要素の並びが、並び順と個数の決まりに合っているか。合わなければ、合わない要素を返す。
 * 移動・複製のあとに確かめる（1つずつ置き場所を計算するより、置いてから確かめるほうが取りこぼしがないため）。
 */
export function orderViolation(parent: Element): Element | null {
  const kids = Array.from(parent.children);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!;
    if (!canContainEl(parent, c.localName)) return c;
    if (allowedInsertIndex(parent, c.localName, i, c) !== i) return c;
  }
  return null;
}

function violationMessage(parent: Element, el: Element): string {
  return t('<{tag}> は <{parent}> のその位置に置けません（並び順か個数の決まりがあります）', { tag: el.localName, parent: parent.localName });
}

/**
 * 写しの文書で試して、できるかどうかと理由を調べる（メニューの有効・無効と、その理由に使う）。
 * 本物の文書は書き換えない。
 */
export function dryRun(doc: Document, op: (copy: Document) => MultiResult | Path | null): string | null {
  const copy = doc.cloneNode(true) as Document;
  try {
    const r = op(copy);
    return r !== null && typeof r === 'object' && 'error' in r ? r.error : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---- 削除 ----

/**
 * まとめて削除する。削除のあとに選ぶ要素のパスを返す：最後に消した要素の後ろの（消さない）兄弟、
 * なければその前の（消さない）兄弟、なければその親（1つだけ消すときと同じ決まり）。customUI（ルート）は消さない。
 */
export function deleteMany(doc: Document, paths: readonly Path[]): Path | null {
  const els = elementsAt(doc, paths).filter((e) => e !== doc.documentElement);
  if (els.length === 0) return null;
  const set = new Set(els);
  const last = els.at(-1)!;
  let next: Element | null = last.nextElementSibling;
  while (next && set.has(next)) next = next.nextElementSibling;
  let prev: Element | null = last.previousElementSibling;
  while (prev && set.has(prev)) prev = prev.previousElementSibling;
  // 親も消す要素の子孫ではない（topLevelPaths で外している）ので、親は残る
  const fallback = next ?? prev ?? last.parentElement;
  for (const e of els) e.remove();
  return fallback ? pathOf(fallback) : null;
}

// ---- 複製 ----

/**
 * まとめて複製する。親ごとに、複製したものを**その親の中で選んだ要素の最後の後ろ**に、元の順で並べる
 * （A B C → A B C A' B' C'）。1つずつ自分の後ろに置く（A A' B B' C C'）と、複製した組がばらばらになり、
 * そのまま別の場所へ動かしにくいため。id は貼り付けと同じく番号を進めて振り直す。
 */
export function duplicateMany(doc: Document, paths: readonly Path[]): MultiResult {
  const els = elementsAt(doc, paths);
  for (const e of els) {
    if (e === doc.documentElement || !canDuplicate(e)) return { error: t('「{name}」（<{tag}>）は複製できません', { name: nameOf(e), tag: e.localName }) };
  }
  const used = usedIds(doc);
  const byParent = new Map<Element, Element[]>();
  for (const e of els) {
    const list = byParent.get(e.parentElement!) ?? [];
    list.push(e);
    byParent.set(e.parentElement!, list);
  }
  const copies: Element[] = [];
  for (const [parent, list] of byParent) {
    let ref: Element | null = list.at(-1)!.nextElementSibling;
    for (const e of list) {
      const c = e.cloneNode(true) as Element;
      renameDuplicateIds(c, used);
      parent.insertBefore(c, ref);
      copies.push(c);
    }
    const bad = orderViolation(parent);
    if (bad) return { error: violationMessage(parent, bad) };
  }
  return { paths: copies.map((c) => pathOf(c)) };
}

// ---- 上下の移動 ----

/**
 * まとめて1つ上（-1）・下（1）へ動かせないときの理由。動かせるなら null。
 * 親が違う要素は、どの並びの中で動かすのかが決まらないので動かさない。
 */
export function moveBlockReason(doc: Document, paths: readonly Path[], delta: -1 | 1): string | null {
  const els = elementsAt(doc, paths);
  if (els.length === 0) return t('動かす要素を選択してください');
  const parent = commonParent(els);
  if (!parent) return t('親の違う要素はまとめて上下に動かせません');
  const kids = Array.from(parent.children);
  const idx = els.map((e) => kids.indexOf(e));
  if (delta < 0 ? Math.min(...idx) === 0 : Math.max(...idx) === kids.length - 1) return delta < 0 ? t('これより上には動かせません') : t('これより下には動かせません');
  return dryRun(doc, (copy) => moveBlock(copy, paths, delta));
}

/**
 * まとめて1つ上・下へ動かす。選んだ要素はそれぞれ、隣の（選んでいない）兄弟と入れ替わる。
 * 選んだ要素どうしの並びは変わらない。並び順の決まりに合わなければ理由を返す。
 */
export function moveBlock(doc: Document, paths: readonly Path[], delta: -1 | 1): MultiResult {
  const els = elementsAt(doc, paths);
  const parent = commonParent(els);
  if (!parent || els.length === 0) return { error: t('親の違う要素はまとめて上下に動かせません') };
  const set = new Set(els);
  const order = delta < 0 ? els : [...els].reverse();
  for (const e of order) {
    if (delta < 0) {
      const prev = e.previousElementSibling;
      if (!prev) return { error: t('これより上には動かせません') };
      if (!set.has(prev)) parent.insertBefore(e, prev);
    } else {
      const next = e.nextElementSibling;
      if (!next) return { error: t('これより下には動かせません') };
      if (!set.has(next)) parent.insertBefore(e, next.nextElementSibling);
    }
  }
  const bad = orderViolation(parent);
  if (bad) return { error: violationMessage(parent, bad) };
  return { paths: els.map((e) => pathOf(e)) };
}

// ---- まとめて別の場所へ移す（ドラッグ＆ドロップ） ----

/**
 * まとめて parent の index 番目（移動前の並びでの位置）に、元の順で移す。
 * 1つでも置けないもの（入れられない親、並び順・個数の決まり）があれば、何も動かさないよう理由を返す
 * （一部だけ動くと、どれが動いたのか分かりにくいため）。
 */
export function moveManyTo(doc: Document, paths: readonly Path[], parent: Element, index: number): MultiResult {
  const els = elementsAt(doc, paths);
  if (els.length === 0) return { error: t('動かす要素を選択してください') };
  for (const e of els) {
    if (e === doc.documentElement) return { error: t('customUI は動かせません') };
    if (e === parent || e.contains(parent)) return { error: t('動かす要素の中には動かせません') };
    if (!canContainEl(parent, e.localName)) return { error: t('<{parent}> の中に {name} は置けません', { parent: parent.localName, name: titleOf(e.localName) }) };
  }
  // まだ置いていない要素。置く位置の目印（ref）が、これから動かす要素にならないようにする
  const pending = new Set(els);
  let ref: Element | null = parent.children[index] ?? null;
  while (ref && pending.has(ref)) ref = ref.nextElementSibling;
  for (const e of els) {
    pending.delete(e);
    // 1つずつ、並び順の決まりで置ける位置に収める（グループの末尾に落としても、ダイアログ起動ツールの前に入るように）
    const want = ref ? Array.prototype.indexOf.call(parent.children, ref) as number : parent.children.length;
    const at = allowedInsertIndex(parent, e.localName, want, e);
    if (at === null) return { error: t('<{parent}> の中に {name} はこれ以上置けません', { parent: parent.localName, name: titleOf(e.localName) }) };
    insertAt(parent, e, at);
    ref = e.nextElementSibling;
    while (ref && pending.has(ref)) ref = ref.nextElementSibling;
  }
  const bad = orderViolation(parent);
  if (bad) return { error: violationMessage(parent, bad) };
  return { paths: els.map((e) => pathOf(e)) };
}

/** まとめて移せないときの理由（写しの文書で試す）。移せるなら null。 */
export function moveManyReason(doc: Document, paths: readonly Path[], parentPath: Path, index: number): string | null {
  return dryRun(doc, (copy) => {
    const parent = elementAt(copy, parentPath);
    return parent ? moveManyTo(copy, paths, parent, index) : { error: t('移動先が見つかりません') };
  });
}

// ---- 新しいグループに移す ----

/** リボンのグループ（Backstage のグループではない）。 */
function isRibbonGroup(el: Element | null): el is Element {
  return el !== null && el.localName === 'group' && el.parentElement?.localName === 'tab' && !inBackstage(el);
}

/** 新しいグループに移せないときの理由。移せるなら null。 */
export function newGroupReason(doc: Document, paths: readonly Path[]): string | null {
  const els = elementsAt(doc, paths);
  if (els.length === 0) return t('動かす要素を選択してください');
  if (!els.every((e) => isRibbonGroup(e.parentElement))) return t('リボンのグループの中のコントロールを選ぶと使えます');
  const tab = els[0]!.parentElement!.parentElement;
  if (!els.every((e) => e.parentElement!.parentElement === tab)) return t('同じタブの中のコントロールを選ぶと使えます');
  return dryRun(doc, (copy) => moveToNewGroup(copy, paths));
}

/**
 * 選んだコントロールを、新しいグループに移す（リボンの幅を詰めるときに、グループを分けるため）。
 * 新しいグループは、選んだ要素のうち最後のものがあるグループのすぐ後ろ（同じタブ）に作る。
 * 移したあとで元のグループが空になっても、消さずに残す（ラベルや id、コールバックを持っていることがあるため）。
 */
export function moveToNewGroup(doc: Document, paths: readonly Path[]): { group: Path; paths: Path[] } | { error: string } {
  const els = elementsAt(doc, paths);
  if (els.length === 0) return { error: t('動かす要素を選択してください') };
  if (!els.every((e) => isRibbonGroup(e.parentElement))) return { error: t('リボンのグループの中のコントロールを選ぶと使えます') };
  const lastGroup = els.at(-1)!.parentElement!;
  const tab = lastGroup.parentElement!;
  if (!els.every((e) => e.parentElement!.parentElement === tab)) return { error: t('同じタブの中のコントロールを選ぶと使えます') };
  const group = createElement(doc, 'group', tab);
  const at = allowedInsertIndex(tab, 'group', Array.prototype.indexOf.call(tab.children, lastGroup) + 1);
  if (at === null) return { error: t('このタブにはグループをこれ以上置けません') };
  tab.insertBefore(group, tab.children[at] ?? null);
  for (const e of els) group.append(e);
  const bad = orderViolation(group);
  if (bad) return { error: violationMessage(group, bad) };
  return { group: pathOf(group), paths: els.map((e) => pathOf(e)) };
}
