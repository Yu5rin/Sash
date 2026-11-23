// ペインの間のフォーカス移動（Ctrl+1〜4、Ctrl+J、F6 / Shift+F6）。
// ビューが focus() を出していればそれを使い（キャンバスなら選択中の要素へ、など）、なければペインの要素にフォーカスする。

import * as canvasView from '../views/canvas';
import * as treeView from '../views/tree';
import * as inspectorView from '../views/inspector';
import * as bottomView from '../views/bottom';
import type { LayoutHandle, PaneKey } from '../layout';

export type PaneId = 'canvas' | 'tree' | 'xml' | 'inspector' | 'bottom';

export const PANE_ORDER: readonly PaneId[] = ['canvas', 'tree', 'xml', 'inspector', 'bottom'];

type Focusable = { focus?: () => void };

let xmlFocus: (() => void) | null = null;
let layout: LayoutHandle | null = null;

/** XML エディタは mountXmlEditor の戻り値でしかフォーカスできないので、main.ts から渡してもらう。 */
export function initPanes(opts: { layout: LayoutHandle; focusXml: () => void }): void {
  layout = opts.layout;
  xmlFocus = opts.focusXml;
}

/** ペインがどの仕切りで畳まれるか。 */
const COLLAPSE_KEY: Readonly<Record<PaneId, PaneKey>> = { canvas: 'top', tree: 'left', xml: 'top', inspector: 'right', bottom: 'bottom' };

function paneElement(id: PaneId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane="${id}"]`);
}

function viewFocus(id: PaneId): (() => void) | undefined {
  const mod: Focusable | undefined = { canvas: canvasView, tree: treeView, inspector: inspectorView, bottom: bottomView, xml: undefined }[id] as Focusable | undefined;
  return typeof mod?.focus === 'function' ? mod.focus.bind(mod) : undefined;
}

/** 指定したペインにフォーカスする。畳んでいれば戻してから移る。 */
export function focusPane(id: PaneId): void {
  // キャンバスは上の仕切り（--top）が 0 のときに隠れる。XML は残るので、キャンバスのときだけ戻す
  const key = COLLAPSE_KEY[id];
  if (layout?.isCollapsed(key) && id !== 'xml') layout.expand(key);
  const el = paneElement(id);
  if (id === 'xml') xmlFocus?.();
  else {
    const fn = viewFocus(id);
    if (fn) fn();
    else {
      const target = id === 'bottom' ? document.getElementById('bottom-body') : el;
      target?.focus();
    }
  }
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
