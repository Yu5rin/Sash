// 複数の要素の属性をまとめて変える（インスペクタのまとめて変更。仕様書 §19）。
// ビューに依存しない部分（共通の属性・値のまとめ・書き込み）をここに置き、テストしやすくする。

import { attrsOfEl, defFor, titleOf, type AttrDef } from './schema';
import { lang, t } from './i18n';

/**
 * まとめて変えない属性。id は重なってはいけないので同じ値にできない。idMso・idQ は「どの組み込みを指すか」で、
 * 要素ごとに違うのが普通。image は画像の取り込みと一緒に扱う（imageMso はまとめて変えられる）。
 */
const EXCLUDED = new Set(['id', 'idMso', 'idQ', 'image', 'getImage']);

/**
 * 選んだ要素のすべてで使える属性（1つ目の要素での並び順）。どれかが属性を編集できない要素（opaque）なら空。
 * 静的な値と組になる get 系のコールバック（getLabel など）は出さない。静的な値を入れると外す（下の applyBulkAttr）。
 */
export function commonAttrDefs(els: readonly Element[]): AttrDef[] {
  if (els.length === 0 || els.some((e) => !defFor(e) || defFor(e)!.opaque)) return [];
  const [first, ...rest] = els;
  const others = rest.map((e) => new Set(attrsOfEl(e).map((d) => d.name)));
  return attrsOfEl(first!).filter((d) => !EXCLUDED.has(d.name) && !d.staticOf && others.every((s) => s.has(d.name)));
}

/** 値を入れるときに一緒に外す属性。アイコンは image・imageMso・getImage のどれか1つだけにする（インスペクタと同じ決まり）。 */
const ALSO_CLEAR: Readonly<Record<string, readonly string[]>> = { imageMso: ['image', 'getImage'] };

/** 真偽値の書き方（1 / 0）をそろえる。比べるときと表示のときに使う。 */
function normalize(d: AttrDef | undefined, v: string | null): string {
  if (v === null) return '';
  if (d?.kind === 'bool') return v === '1' ? 'true' : v === '0' ? 'false' : v;
  return v;
}

export type BulkValue =
  /** すべて同じ値（'' は未指定）。 */
  | { mixed: false; value: string }
  /** 値が違う。values は違う値の一覧（'' は未指定）。 */
  | { mixed: true; values: string[] };

/** 選んだ要素の、その属性の値をまとめる。 */
export function bulkValue(els: readonly Element[], d: AttrDef): BulkValue {
  const values = [...new Set(els.map((e) => normalize(d, e.getAttribute(d.name))))];
  return values.length === 1 ? { mixed: false, value: values[0]! } : { mixed: true, values };
}

/**
 * 選んだ要素に、その属性の値をまとめて入れる（null か '' で外す）。store.edit の中で呼ぶこと。
 * 静的な値を入れるときは、組になる get 系のコールバックを外す（両方を指定すると Excel が読み込みを断るため。
 * インスペクタの「固定 | VBA」の切り替えと同じ決まり）。変わった要素の数を返す。
 */
export function applyBulkAttr(els: readonly Element[], d: AttrDef, value: string | null): number {
  let changed = 0;
  for (const e of els) {
    if (!attrsOfEl(e).some((x) => x.name === d.name)) continue;
    const before = e.getAttribute(d.name);
    // 一緒に外す属性：組になる get 系のコールバックと、imageMso なら別の種類のアイコン（image・getImage）
    const clear = value ? [...(d.dynamic ? [d.dynamic] : []), ...(ALSO_CLEAR[d.name] ?? [])].filter((n) => e.hasAttribute(n)) : [];
    if (value === null || value === '') e.removeAttribute(d.name);
    else e.setAttribute(d.name, value);
    for (const n of clear) e.removeAttribute(n);
    if (before !== e.getAttribute(d.name) || clear.length > 0) changed++;
  }
  return changed;
}

/** その属性を持てる要素だけを返す（size の一括変更で、size のないものを飛ばすため）。 */
export function supporting(els: readonly Element[], attr: string): Element[] {
  return els.filter((e) => attrsOfEl(e).some((d) => d.name === attr));
}

/** 選んだ要素の種類の内訳（「ボタン 4・トグルボタン 2」）。多い順、同じ数なら最初に出てきた順。 */
export function kindSummary(els: readonly Element[]): string {
  const counts = new Map<string, number>();
  for (const e of els) {
    const name = defFor(e) ? t(defFor(e)!.title) : titleOf(e.localName);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sep = lang === 'en' ? ', ' : '・';
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(sep);
}

/** まとめて変えたときの履歴の名前（「6 個の size を large に変更」）。 */
export function bulkLabel(n: number, attr: string, value: string | null): string {
  return value === null || value === ''
    ? t('{n} 個の {attr} を削除', { n, attr })
    : t('{n} 個の {attr} を {value} に変更', { n, attr, value });
}
