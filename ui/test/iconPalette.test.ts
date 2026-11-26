// アイコンの色のパレット（0.3.1）：データ（色相ごとの 5 段と Office の標準の色）・入力のそろえ方・沈む色の判定・画面部品とキーボード。
import { describe, expect, it } from 'vitest';
import { missingKeys } from '../src/i18n';
import { analyzePixels, lumaOf, SINK_DARK_LUMA, SINK_LIGHT_LUMA, sinkOfColor } from '../src/imageStats';
import { buildColorPalette, colorLabel } from '../src/fluent/colorPalette';
import {
  allPaletteColors, legibility, normalizeHex, paletteGrid, paletteName, PALETTE_COLUMNS, PALETTE_HUES, pushRecent,
  RECENT_MAX, SHADE_NAMES, STANDARD_COLORS,
} from '../src/fluent/iconPalette';

const lumaHex = (hex: string) => lumaOf(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));

describe('パレットのデータ', () => {
  it('色相 13 列 × 濃さ 5 段 と Office の標準の色 10 色（合わせて 75 色）で、どれも小文字の #rrggbb', () => {
    expect(PALETTE_HUES).toHaveLength(13);
    expect(PALETTE_COLUMNS).toBe(13);
    expect(SHADE_NAMES).toHaveLength(5);
    expect(STANDARD_COLORS).toHaveLength(10);
    const all = allPaletteColors();
    expect(all).toHaveLength(75);
    expect(all.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    // グリッドの中は重ならない（標準の色は Office の定義なので、グリッドと同じ色があってもよい）
    expect(new Set(PALETTE_HUES.flatMap((h) => h.colors)).size).toBe(65);
  });

  it('以前の 6 色（既定のグレー・Excel の緑・青・赤・オレンジ・黒）は同じ値のまま残っている', () => {
    const grid = new Set(PALETTE_HUES.flatMap((h) => h.colors));
    for (const c of ['#424242', '#217346', '#0f6cbd', '#c42b1c', '#ca5010', '#000000']) expect(grid.has(c), c).toBe(true);
  });

  it('各色相の 5 色は、濃い方から淡い方へ明るさが増える', () => {
    for (const hue of PALETTE_HUES) {
      const l = hue.colors.map(lumaHex);
      for (let i = 1; i < l.length; i++) expect(l[i]!, `${hue.id} の ${i} 段目`).toBeGreaterThan(l[i - 1]!);
    }
  });

  it('グリッドの並びは段ごとに左から右（13 個ずつ）で、どの色にも色相と濃さの名前が付く', () => {
    const grid = paletteGrid();
    expect(grid).toHaveLength(65);
    expect(grid[0]).toMatchObject({ color: '#000000', hue: 'グレー', shade: '濃い' });
    expect(grid[13]).toMatchObject({ hue: 'グレー', shade: 'やや濃い' });
    expect(paletteName('#217346')).toEqual({ hue: '緑', shade: 'やや濃い' });
    expect(paletteName('#FF0000')).toEqual({ label: '赤' });
    expect(paletteName('#123456')).toBeNull();
  });

  it('名前は英語の辞書に全部ある（色相・濃さ・標準の色・案内の文言）', () => {
    const keys = [
      ...PALETTE_HUES.map((h) => h.ja), ...SHADE_NAMES, ...STANDARD_COLORS.map((c) => c.label),
      '色相ごとの色', 'Office の標準の色', '最近使った色', '色を入力（#RRGGBB）', '色は #RRGGBB の形で入力してください（例：#217346）',
      '白・黒どちらの Office のテーマでも見えます', 'Office の黒・濃い灰色のテーマで背景に沈みます', 'Office の白・明るいテーマで背景に沈みます',
      '右下の印：Office の黒（暗）・白（明）のテーマで沈む色', 'パレットから選ぶ',
    ];
    expect(missingKeys(keys)).toEqual([]);
  });
});

describe('色の入力', () => {
  it('#RRGGBB・RRGGBB・#RGB・RGB を小文字の #rrggbb にそろえ、それ以外は null', () => {
    expect(normalizeHex('#ABCDEF')).toBe('#abcdef');
    expect(normalizeHex(' 217346 ')).toBe('#217346');
    expect(normalizeHex('#f0a')).toBe('#ff00aa');
    expect(normalizeHex('fa0')).toBe('#ffaa00');
    for (const bad of ['', '#12345', '#1234567', 'red', '#ggg', '"/><script>', '#12 456']) expect(normalizeHex(bad), bad).toBeNull();
  });

  it('最近使った色は先頭に足し、重複を除き、8 個まで', () => {
    expect(pushRecent(['#111111', '#222222'], '#222222')).toEqual(['#222222', '#111111']);
    expect(pushRecent([], 'ABC')).toEqual(['#aabbcc']);
    expect(pushRecent(['#111111'], 'xyz')).toEqual(['#111111']);
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = pushRecent(list, `#0000${(i + 16).toString(16)}`);
    expect(list).toHaveLength(RECENT_MAX);
  });
});

describe('リボンの上での見え方（配布前チェックと同じ基準）', () => {
  it('暗い色は黒いテーマで、淡い色は白いテーマで沈む。既定のグレーと中間色は沈まない', () => {
    expect(legibility('#000000')).toBe('dark');
    expect(legibility('#691411')).toBe('dark');
    expect(legibility('#ffff00')).toBe('light');
    expect(legibility('#fbe3a7')).toBe('light');
    expect(legibility('#424242')).toBe('ok');
    expect(legibility('#217346')).toBe('ok');
    expect(legibility('#0f6cbd')).toBe('ok');
    expect(sinkOfColor('nope')).toBeNull();
  });

  it('判定は、画像の画素を集計する配布前チェックの基準（平均の明るさ 60 未満・215 超）と、パレットの全色で一致する', () => {
    expect(SINK_DARK_LUMA).toBe(60);
    expect(SINK_LIGHT_LUMA).toBe(215);
    for (const c of allPaletteColors()) {
      const px = new Uint8ClampedArray(8 * 8 * 4);
      for (let i = 0; i < 64; i++) px.set([parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255], i * 4);
      const st = analyzePixels(px, 8, 8);
      const checkDark = st.meanLuma < SINK_DARK_LUMA && st.darkShare >= 0.85;
      const checkLight = st.meanLuma > SINK_LIGHT_LUMA && st.lightShare >= 0.85;
      expect(legibility(c) === 'dark', `${c} 暗`).toBe(checkDark);
      expect(legibility(c) === 'light', `${c} 明`).toBe(checkLight);
    }
  });

  it('リボンに置いて使える（沈まない）色が 40 色以上ある', () => {
    expect(allPaletteColors().filter((c) => legibility(c) === 'ok').length).toBeGreaterThanOrEqual(40);
  });
});

describe('パレットの画面部品', () => {
  const make = (value = '#424242', picks: string[] = [], recent: string[] = []) => buildColorPalette({ value, recent, onPick: (c) => picks.push(c) });
  const swatches = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('button.cp-swatch')];

  it('色のボタンは 65 + 10 個で、名前（色相・濃さ・色コード）を読み上げ用に持つ', () => {
    const p = make();
    const list = swatches(p.el);
    expect(list).toHaveLength(75);
    const green = list.find((b) => b.dataset['color'] === '#217346')!;
    expect(green.getAttribute('aria-label')).toBe('緑・やや濃い（#217346）');
    expect(list.find((b) => b.dataset['color'] === '#ff0000')!.getAttribute('aria-label')).toContain('赤（#ff0000）');
    // 沈む色には、その旨も読み上げる
    expect(list.find((b) => b.dataset['color'] === '#000000')!.getAttribute('aria-label')).toContain('背景に沈みます');
    expect(list.find((b) => b.dataset['color'] === '#000000')!.dataset['sink']).toBe('dark');
    expect(list.find((b) => b.dataset['color'] === '#ffff00')!.dataset['sink']).toBe('light');
    expect(list.find((b) => b.dataset['color'] === '#217346')!.dataset['sink']).toBeUndefined();
    expect(colorLabel('#7a7a7a')).toBe('#7a7a7a');
  });

  it('今の色に選択の印が付き、Tab で止まるのは各グループで 1 つだけ', () => {
    const p = make('#217346');
    const pressed = swatches(p.el).filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed.every((b) => b.dataset['color'] === '#217346')).toBe(true);
    expect(pressed.length).toBeGreaterThanOrEqual(1);
    for (const g of p.el.querySelectorAll<HTMLElement>('.cp-group')) {
      expect([...g.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.tabIndex === 0)).toHaveLength(1);
    }
    p.setValue('#ff0000');
    expect(swatches(p.el).filter((b) => b.getAttribute('aria-pressed') === 'true').every((b) => b.dataset['color'] === '#ff0000')).toBe(true);
  });

  it('ボタンを押す・Enter / Space（ボタンの標準の動き）で色が選べる', () => {
    const picks: string[] = [];
    const p = make('#424242', picks);
    swatches(p.el).find((b) => b.dataset['color'] === '#0f6cbd')!.click();
    expect(picks).toEqual(['#0f6cbd']);
  });

  it('矢印・Home・End でグリッドの中を移れる（上下は 1 段、左右は 1 つ）', () => {
    document.body.append(make().el);
    const grid = document.querySelector<HTMLElement>('.cp-hues')!;
    const items = [...grid.querySelectorAll<HTMLButtonElement>('button')];
    const press = (key: string, ctrlKey = false) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }));
    items[0]!.focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(items[1]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items[1 + PALETTE_COLUMNS]);
    press('ArrowLeft');
    expect(document.activeElement).toBe(items[PALETTE_COLUMNS]);
    press('ArrowUp');
    expect(document.activeElement).toBe(items[0]);
    press('ArrowUp'); // 先頭の段より上には行かない
    expect(document.activeElement).toBe(items[0]);
    press('End');
    expect(document.activeElement).toBe(items[PALETTE_COLUMNS - 1]);
    press('Home');
    expect(document.activeElement).toBe(items[0]);
    press('End', true);
    expect(document.activeElement).toBe(items[items.length - 1]);
    // 移った先だけが Tab で止まる
    expect(items.filter((b) => b.tabIndex === 0)).toEqual([items[items.length - 1]]);
    document.body.innerHTML = '';
  });

  it('#RRGGBB を直接入力できる（Enter か欄を離れたとき）。読めなければ案内を出して選ばない', () => {
    const picks: string[] = [];
    const p = make('#424242', picks);
    const hex = p.el.querySelector<HTMLInputElement>('input.cp-hex')!;
    const error = p.el.querySelector<HTMLElement>('.cp-error')!;
    expect(error.hidden).toBe(true);
    hex.value = '#ABC';
    hex.dispatchEvent(new Event('change'));
    expect(picks).toEqual(['#aabbcc']);
    expect(hex.value).toBe('#aabbcc');
    hex.value = 'zzz';
    hex.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(picks).toEqual(['#aabbcc']);
    expect(error.hidden).toBe(false);
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    hex.value = '217346';
    hex.dispatchEvent(new Event('change'));
    expect(picks).toEqual(['#aabbcc', '#217346']);
    expect(error.hidden).toBe(true);
  });

  it('沈む色を選ぶと、その旨のメモを出す。見える色なら見えると出す', () => {
    const p = make('#424242');
    const note = p.el.querySelector<HTMLElement>('.cp-note')!;
    expect(note.textContent).toContain('どちらの Office のテーマでも見えます');
    expect(note.dataset['sink']).toBeUndefined();
    p.setValue('#000000');
    expect(note.textContent).toContain('黒・濃い灰色のテーマで背景に沈みます');
    expect(note.dataset['sink']).toBe('dark');
    p.setValue('#ffff00');
    expect(note.textContent).toContain('白・明るいテーマで背景に沈みます');
    expect(note.dataset['sink']).toBe('light');
  });

  it('最近使った色があるときだけ、その行を出す', () => {
    const none = make();
    expect(none.el.querySelector<HTMLElement>('.cp-recent-wrap')!.hidden).toBe(true);
    const some = make('#424242', [], ['#123456', '#654321']);
    const wrap = some.el.querySelector<HTMLElement>('.cp-recent-wrap')!;
    expect(wrap.hidden).toBe(false);
    expect([...wrap.querySelectorAll<HTMLElement>('button')].map((b) => b.dataset['color'])).toEqual(['#123456', '#654321']);
    some.setRecent([]);
    expect(wrap.hidden).toBe(true);
  });
});
