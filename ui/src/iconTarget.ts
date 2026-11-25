// 「アイコン・ラベルを設定する先」の決め方。
// 分割ボタン（splitButton）は、customUI のスキーマ（CT_SplitButtonRestricted）で label / image / imageMso / getImage などが
// 禁止されていて、「中の先頭の button / toggleButton から受け継ぐ」決まりになっている。
// 分割ボタンに属性を付けるとスキーマ違反の XML になるので、利用者が分割ボタンを選んだまま操作しても、
// 実際の書き込み先は中のボタンにする。アイコンを設定する入口（インスペクタ・コマンド・ドロップ）はここを通す。
//
// dialogBoxLauncher の中の button は、Excel の画面ではアイコンが出ない（グループ右下の小さな矢印に決まっている）ので、
// 同じ扱いにはしない（選んでも、アイコンの設定先にはならない）。

import { childElements, elementAt, pathOf, type Path } from './model';
import { defFor } from './schema';

/** 分割ボタンの中の先頭の button / toggleButton（アイコンとラベルを持つ側）。なければ null。 */
export function innerButtonOf(split: Element): Element | null {
  return childElements(split).find((c) => c.localName === 'button' || c.localName === 'toggleButton') ?? null;
}

/** el が、アイコン・ラベルを中のボタンに委ねる要素か。 */
export function delegatesToInner(el: Element): boolean {
  return el.localName === 'splitButton' && defFor(el)?.attrs.includes('image') !== true;
}

/** アイコンを書き込む先の要素。分割ボタンなら中のボタン（なければ null）、それ以外は el 自身。 */
export function iconTargetOf(el: Element): Element | null {
  return delegatesToInner(el) ? innerButtonOf(el) : el;
}

/** el にアイコンを設定できるか（委ねる先がある場合は、その先で判定する）。 */
export function canSetIcon(el: Element | null | undefined): boolean {
  const target = el ? iconTargetOf(el) : null;
  return !!target && defFor(target)?.attrs.includes('image') === true;
}

/** path の要素のアイコンの書き込み先の path。設定できないときは null。 */
export function iconTargetPath(doc: Document, path: Path): Path | null {
  const el = elementAt(doc, path);
  if (!el || !canSetIcon(el)) return null;
  const target = iconTargetOf(el);
  // 書き込み先が選んだ要素自身のときは、渡された path をそのまま返す（同じ配列かどうかで「付け替えたか」が分かる）
  return !target ? null : target === el ? path : pathOf(target);
}
