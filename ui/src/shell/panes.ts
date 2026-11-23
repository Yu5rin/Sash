// ペインの間のフォーカス移動（Ctrl+1〜4、Ctrl+J、F6 / Shift+F6）。
// ビューが focus() を出していればそれを使い（キャンバスなら選択中の要素へ、など）、なければペインの要素にフォーカスする。

import { focus as focusCanvas } from '../views/canvas';
import { focus as focusTree } from '../views/tree';
import { focus as focusInspector } from '../views/inspector';
import { focus as focusXml } from '../views/xmlEditor';
import { focus as focusBottom } from '../views/bottom';
import type { LayoutHandle, PaneKey } from '../layout';

export type PaneId = 'canvas' | 'palette' | 'tree' | 'xml' | 'inspector' | 'bottom';

/** F6 で回る順。パレットも入れる（キーボードだけで部品を探して追加できるように）。 */
export const PANE_ORDER: readonly PaneId[] = ['canvas', 'palette', 'tree', 'xml', 'inspector', 'bottom'];

let layout: LayoutHandle | null = null;

export function initPanes(opts: { layout: LayoutHandle }): void {
  layout = opts.layout;
}

/** ペインがどの仕切りで畳まれるか。 */
const COLLAPSE_KEY: Readonly<Record<PaneId, PaneKey>> = { canvas: 'top', palette: 'left', tree: 'left', xml: 'top', inspector: 'right', bottom: 'bottom' };

function paneElement(id: PaneId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane="${id}"]`);
}

/** ビューが出している focus()。選択中の項目など、ビューごとに適した場所へ移すため。 */
const VIEW_FOCUS: Readonly<Record<PaneId, (() => void) | null>> = { canvas: focusCanvas, palette: focusPalette, tree: focusTree, xml: focusXml, inspector: focusInspector, bottom: focusBottom };

/** パレットは検索欄に移る（そこから ↓ で部品に移れる）。 */
function focusPalette(): void {
  document.querySelector<HTMLElement>('#palette input')?.focus();
}

/** 指定したペインにフォーカスする。畳んでいれば戻してから移る。 */
export function focusPane(id: PaneId): void {
  // キャンバスは上の仕切り（--top）が 0 のときに隠れる。XML は残るので、キャンバスのときだけ戻す
  const key = COLLAPSE_KEY[id];
  if (layout?.isCollapsed(key) && id !== 'xml') layout.expand(key);
  // パレットとツリーの境目で畳んでいる側へ移るときは、その側を開いてから移る（見えない場所へフォーカスしないように）
  if (id === 'palette' || id === 'tree') layout?.expandSplit(id);
  const el = paneElement(id);
  const fn = VIEW_FOCUS[id];
  if (fn) fn();
  else (id === 'bottom' ? document.getElementById('bottom-body') : el)?.focus();
  // マウスで選んだ場合でもどこへ移ったかが分かるよう、ペインを一瞬だけ縁取る
  const flash = id === 'xml' ? el : el?.closest<HTMLElement>('section, aside, footer') ?? el;
  if (flash) {
    flash.classList.remove('pane-flash');
    void flash.offsetWidth;
    flash.classList.add('pane-flash');
  }
}

/** 今フォーカスのあるペイン。 */
export function currentPane(): PaneId | null {
  const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-pane]');
  const id = el?.dataset['pane'];
  return PANE_ORDER.includes(id as PaneId) ? (id as PaneId) : null;
}

/** F6 / Shift+F6 で次・前のペインへ。畳んだペインは飛ばす。 */
export function cyclePane(delta: 1 | -1): void {
  const visible = PANE_ORDER.filter((p) => !(layout?.isCollapsed(COLLAPSE_KEY[p]) && p !== 'xml'));
  if (visible.length === 0) return;
  const cur = currentPane();
  const i = cur ? visible.indexOf(cur) : -1;
  const next = visible[(i + delta + visible.length) % visible.length]!;
  focusPane(i < 0 && delta === 1 ? visible[0]! : next);
}

/** 下部パネルの表示・非表示（Ctrl+J）。出したときはフォーカスも移す。 */
export function toggleBottom(): void {
  if (!layout) return;
  layout.toggle('bottom');
  if (!layout.isCollapsed('bottom')) focusPane('bottom');
  else if (currentPane() === 'bottom') focusPane('canvas');
}
