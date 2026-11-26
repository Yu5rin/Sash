// アイコンの色のパレットの画面部品（アイコン集のダイアログと、アイコンエディタの両方が使う）。
// データと判定は iconPalette.ts（純粋）。ここは DOM を作り、キーボードで選べるようにする。
//
// キーボード：パレットの各グループ（色相のグリッド・標準の色・最近使った色）は、Tab で 1 つだけ止まり（今の色か先頭）、
// 矢印で隣へ、Home / End で端へ移る。グリッドは上下の矢印で段を移る。Enter / Space で選ぶ（ボタンなので標準の動き）。
// 色は #RRGGBB を直接入力もできる（#RGB・# なしも可）。

import './colorPalette.css';
import { h } from '../dom';
import { t } from '../i18n';
import {
  PALETTE_COLUMNS, STANDARD_COLORS, legibility, normalizeHex, paletteGrid, paletteName, type PaletteSwatch,
} from './iconPalette';

export interface ColorPaletteOptions {
  /** 今の色（#rrggbb）。 */
  value: string;
  /** 最近使った色（新しい順）。省略したら「最近使った色」は出さない。 */
  recent?: readonly string[];
  /** 色を選んだとき。 */
  onPick: (color: string) => void;
  /** 色の入力欄に付ける名前（読み上げ用。t() のキー）。 */
  label?: string;
}

export interface ColorPalette {
  el: HTMLElement;
  /** 外から色が変わったとき（選択の印と、入力欄・メモを合わせる）。 */
  setValue(color: string): void;
  /** 最近使った色を差し替える。 */
  setRecent(list: readonly string[]): void;
}

/** 色の読み上げ用の名前。例：「赤・濃い（#691411）」。沈む色にはその旨を足す。 */
export function colorLabel(color: string, fallback?: string): string {
  const n = paletteName(color);
  // 区切りの記号は言語ごとに違うので、文言ごと（テンプレート）で訳す
  let base = color;
  if (n) base = 'label' in n ? t('{name}（{color}）', { name: t(n.label), color }) : t('{hue}・{shade}（{color}）', { hue: t(n.hue), shade: t(n.shade), color });
  else if (fallback) base = t('{name}（{color}）', { name: t(fallback), color });
  const sink = legibility(color);
  return sink === 'ok' ? base : t('{label}、{note}', { label: base, note: t(sinkText(sink)) });
}

/** 沈む色の説明（配布前チェックと同じ言い方）。 */
export function sinkText(sink: 'dark' | 'light'): string {
  return sink === 'dark' ? 'Office の黒・濃い灰色のテーマで背景に沈みます' : 'Office の白・明るいテーマで背景に沈みます';
}

export function buildColorPalette(opts: ColorPaletteOptions): ColorPalette {
  let value = normalizeHex(opts.value) ?? '#424242';
  const swatches: HTMLButtonElement[] = [];

  const swatch = (color: string, label?: string): HTMLButtonElement => {
    const sink = legibility(color);
    const b = h('button', {
      type: 'button',
      class: 'cp-swatch',
      style: `--swatch:${color}`,
      title: colorLabel(color, label),
      'aria-label': colorLabel(color, label),
      'aria-pressed': 'false',
      tabIndex: -1,
      dataset: { color, ...(sink === 'ok' ? {} : { sink }) },
      onclick: () => pick(color),
    }) as HTMLButtonElement;
    swatches.push(b);
    return b;
  };

  const group = (cls: string, items: HTMLButtonElement[], cols: number, name: string): HTMLElement => {
    const g = h('div', { class: `cp-group ${cls}`, role: 'group', 'aria-label': t(name) }, items);
    g.addEventListener('keydown', (e: KeyboardEvent) => roving(e, items, cols));
    return g;
  };

  const grid: PaletteSwatch[] = paletteGrid();
  const hueGroup = group('cp-hues', grid.map((s) => swatch(s.color)), PALETTE_COLUMNS, '色相ごとの色');
  const stdItems = STANDARD_COLORS.map((c) => swatch(c.color, c.label));
  const stdGroup = group('cp-standard', stdItems, STANDARD_COLORS.length, 'Office の標準の色');

  const recentGroup = h('div', { class: 'cp-recent-wrap', hidden: true }, h('p', { class: 'cp-title' }, t('最近使った色')));
  let recentButtons: HTMLButtonElement[] = [];
  let recentEl: HTMLElement | null = null;

  const hex = h('input', {
    type: 'text', class: 'cp-hex', value, maxLength: 7, spellcheck: false, autocomplete: 'off',
    'aria-label': t(opts.label ?? '色を入力（#RRGGBB）'), title: t('色を入力（#RRGGBB）'), placeholder: '#RRGGBB',
    onchange: () => commitHex(),
    onkeydown: (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Enter') {
        k.preventDefault();
        k.stopPropagation();
        commitHex();
      }
    },
  }) as HTMLInputElement;
  const native = h('input', { type: 'color', value, title: t('色を選ぶ'), 'aria-label': t('色を選ぶ'), oninput: () => pick(native.value) }) as HTMLInputElement;
  const current = h('span', { class: 'cp-current', role: 'img' });
  const error = h('p', { class: 'cp-error', role: 'alert', hidden: true }, t('色は #RRGGBB の形で入力してください（例：#217346）'));
  const note = h('p', { class: 'cp-note', role: 'status' });
  const legend = h('p', { class: 'cp-legend' }, h('i', { class: 'd' }), h('i', { class: 'l' }),
    t('右下の印：Office の黒（暗）・白（明）のテーマで沈む色'));

  const el = h('div', { class: 'cp' },
    hueGroup, h('p', { class: 'cp-title' }, t('Office の標準の色')), stdGroup, recentGroup,
    h('div', { class: 'cp-custom' }, current, hex, native), error, note, legend);

  function commitHex(): void {
    const c = normalizeHex(hex.value);
    if (!c) {
      error.hidden = false;
      hex.setAttribute('aria-invalid', 'true');
      return;
    }
    pick(c);
  }

  function pick(color: string): void {
    setValue(color);
    opts.onPick(value);
  }

  function setValue(color: string): void {
    const c = normalizeHex(color);
    if (!c) return;
    value = c;
    hex.value = c;
    native.value = c;
    error.hidden = true;
    hex.removeAttribute('aria-invalid');
    current.style.setProperty('--swatch', c);
    current.setAttribute('aria-label', colorLabel(c));
    const sink = legibility(c);
    note.textContent = sink === 'ok' ? t('白・黒どちらの Office のテーマでも見えます') : t(sinkText(sink));
    if (sink === 'ok') note.removeAttribute('data-sink');
    else note.dataset['sink'] = sink;
    syncSwatches();
  }

  /** 選択の印と、Tab で止まる 1 つ（今の色があればそれ、なければグループの先頭）を合わせる。 */
  function syncSwatches(): void {
    for (const g of [hueGroup, stdGroup, recentEl]) {
      if (!g) continue;
      const items = [...g.querySelectorAll<HTMLButtonElement>('button.cp-swatch')];
      const on = items.find((b) => b.dataset['color'] === value);
      for (const b of items) {
        b.setAttribute('aria-pressed', String(b.dataset['color'] === value));
        b.tabIndex = (on ?? items[0]) === b ? 0 : -1;
      }
    }
  }

  function setRecent(list: readonly string[]): void {
    recentEl?.remove();
    recentButtons = list.map((c) => swatch(c));
    recentEl = recentButtons.length > 0 ? group('cp-recent', recentButtons, 8, '最近使った色') : null;
    recentGroup.hidden = recentEl === null;
    if (recentEl) recentGroup.append(recentEl);
    syncSwatches();
  }

  setRecent(opts.recent ?? []);
  setValue(value);
  return { el, setValue, setRecent };
}

/** 矢印・Home・End で、グループの中のボタンへフォーカスを移す（cols はグリッドの列数。上下の矢印はその数だけ動く）。 */
function roving(e: KeyboardEvent, items: readonly HTMLButtonElement[], cols: number): void {
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  let next = -1;
  if (e.key === 'ArrowRight') next = Math.min(items.length - 1, i + 1);
  else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
  else if (e.key === 'ArrowDown') next = i + cols < items.length ? i + cols : i;
  else if (e.key === 'ArrowUp') next = i - cols >= 0 ? i - cols : i;
  else if (e.key === 'Home') next = e.ctrlKey ? 0 : i - (i % cols);
  else if (e.key === 'End') next = e.ctrlKey ? items.length - 1 : Math.min(items.length - 1, i - (i % cols) + cols - 1);
  if (next < 0) return;
  e.preventDefault();
  e.stopPropagation();
  items.forEach((b, j) => (b.tabIndex = j === next ? 0 : -1));
  items[next]!.focus();
}
