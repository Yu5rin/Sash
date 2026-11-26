// 「空の状態」の部品（総点検 C-1）。Backstage・右クリックメニュー・自作のタブがないときなど、
// 同じ役割の場所が同じ見た目になるよう、1 つにまとめる：
// 中央寄せ、アイコン 24px（--text-subtle）、見出し 14px・600、説明 12px・--text-subtle（最大幅 360px）、主な操作のボタン 1 つ。
// 枠は点線 1px・角丸 8px・余白 24px（styles-views.css の .empty-card）。

import { h, svg } from '../dom';

export interface EmptyStateOptions {
  /** uiIcons の SVG（16px の線のアイコン。24px に拡大して出す）。 */
  icon?: string;
  /** 見出し。 */
  title: string;
  /** 説明（1〜2 行）。 */
  text?: string;
  /** 主な操作のボタン。 */
  action?: HTMLElement | null;
  /** 追加のクラス。floating は右下に浮かせる小さい形。 */
  className?: string;
}

export function emptyState(opts: EmptyStateOptions): HTMLElement {
  return h('div', { class: `empty-card${opts.className ? ` ${opts.className}` : ''}` },
    opts.icon ? h('span', { class: 'empty-card-icon', 'aria-hidden': 'true' }, svg(opts.icon)) : null,
    h('h3', { class: 'empty-card-title' }, opts.title),
    opts.text ? h('p', { class: 'empty-card-text' }, opts.text) : null,
    opts.action ?? null);
}
