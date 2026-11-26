// 0.3.1 の見直しの指摘への対応のテスト。
import { describe, expect, it, vi } from 'vitest';
import { h } from '../src/dom';
import { openModal } from '../src/dialogs/modal';
import { openFluentPicker } from '../src/fluent/fluentDialog';
import { approxIconCount, ICON_SET_NAMES } from '../src/fluent/fluent';
import { ICON_COUNTS } from '../src/fluent/iconCounts';
import { buildColorPalette } from '../src/fluent/colorPalette';
import { splitQuery, searchIconSet } from '../src/fluent/iconSearch';
import { CONCEPTS } from '../src/fluent/iconConcepts';
import { allIcons, fluentIcons, lucideIcons, sashIcons, tablerIcons } from './helpers/allIcons';
import fluentData from '../src/fluent/fluentIcons.json';
import tablerData from '../src/fluent/tablerIcons.json';
import lucideData from '../src/fluent/lucideIcons.json';
import sashData from '../src/fluent/sashIcons.json';

const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('Esc（中 3）：ダイアログの中のポップアップが開いているときは、それだけを閉じる', () => {
  it('onEscape が true を返す間はダイアログを閉じず、false なら閉じる', () => {
    let open = true;
    const onClose = vi.fn();
    const m = openModal('テスト', h('div', null, 'x'), { onEscape: () => { const was = open; open = false; return was; }, onClose });
    press('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.modal')).not.toBeNull();
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.modal')).toBeNull();
    m.close();
  });

  it('onEscape がなければ、これまでどおり Esc で閉じる', () => {
    const onClose = vi.fn();
    openModal('テスト', h('div', null, 'x'), { onClose });
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('パレットの部品（低 7）', () => {
  it('色の入力欄は maxLength を持たない（前後に空白のある貼り付けが切れない）。読み上げ名は setLabel で変えられる', () => {
    const picks: string[] = [];
    const p = buildColorPalette({ value: '#424242', onPick: (c) => picks.push(c), label: '置き換える前の色' });
    const hex = p.el.querySelector<HTMLInputElement>('input.cp-hex')!;
    expect(hex.hasAttribute('maxlength')).toBe(false);
    hex.value = '   #217346   ';
    hex.dispatchEvent(new Event('change'));
    expect(picks).toEqual(['#217346']);
    expect(hex.getAttribute('aria-label')).toBe('置き換える前の色');
    p.setLabel('置き換えた後の色');
    expect(hex.getAttribute('aria-label')).toBe('置き換えた後の色');
  });
});

describe('保存した色（低 7）', () => {
  it('最近使った色は、大文字小文字だけ違う重複を除いて開く', async () => {
    localStorage.setItem('sash.fluent', JSON.stringify({ variant: 'regular', color: '#424242', set: 'all', recent: ['#ABC', '#abc', '#AABBCC', '#112233'] }));
    await openFluentPicker(() => undefined);
    const recent = [...document.querySelectorAll<HTMLElement>('.cp-recent button')].map((b) => b.dataset['color']);
    expect(recent).toEqual(['#aabbcc', '#112233']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    localStorage.removeItem('sash.fluent');
  });
});

describe('ツールチップの個数（低 7）', () => {
  it('件数は iconCounts.ts（データを数えたもの）から作り、実際のデータと合っている', () => {
    expect(ICON_COUNTS).toEqual({
      fluent: Object.keys((fluentData as { icons: object }).icons).length,
      tabler: Object.keys((tablerData as { icons: object }).icons).length,
      lucide: Object.keys((lucideData as { icons: object }).icons).length,
      sash: Object.keys((sashData as { icons: object }).icons).length,
    });
    expect(fluentIcons.length + tablerIcons.length + lucideIcons.length + sashIcons.length).toBe(allIcons.length);
    expect(approxIconCount()).toBe('8,200');
    expect(ICON_SET_NAMES).toBe('Fluent・Tabler・Lucide・Sash');
  });
});

describe('& のまとめ方（低〜中 5）', () => {
  it('1 文字どうしの英字をはさむ & だけを 1 語にする（R&D・Q&A・M&A）。drag&drop・black&white は分ける', () => {
    expect(splitQuery('R&D').map((t) => t.norm)).toEqual(['rd']);
    expect(splitQuery('Q&A').map((t) => t.norm)).toEqual(['qa']);
    expect(splitQuery('M&A').map((t) => t.norm)).toEqual(['ma']);
    expect(splitQuery('drag&drop').map((t) => t.norm)).toEqual(['drag', '&', 'drop']);
    expect(splitQuery('black&white').map((t) => t.norm)).toEqual(['black', '&', 'white']);
  });

  it('drag&drop・black&white・Q&A は、0 件にならない', () => {
    expect(searchIconSet(allIcons, 'drag&drop').hits.length).toBeGreaterThan(0);
    expect(searchIconSet(allIcons, 'black&white').hits.length).toBeGreaterThan(0);
    const qa = searchIconSet(allIcons, 'Q&A').hits.slice(0, 5).map((h) => h.icon.name);
    expect(qa.some((n) => ['shield-check', 'certificate', 'award', 'package-check', 'clipboard-check'].includes(n))).toBe(true);
    expect(searchIconSet(allIcons, '品質保証').hits.length).toBeGreaterThan(0);
  });
});

describe('同じ読みの見出し（低 6）', () => {
  const top = (q: string, n = 3) => searchIconSet(allIcons, q).hits.slice(0, n).map((h) => h.icon.name);

  it('「かこう」は加工（工作機械）、「けんしゅう」は検収（検品）が先頭に来る', () => {
    expect(top('かこう', 2).some((n) => ['machining-center', 'lathe', 'press-machine'].includes(n))).toBe(true);
    expect(top('けんしゅう', 3).some((n) => ['package-check', 'scan-search', 'clipboard-check'].includes(n))).toBe(true);
    // 漢字の下降・研修は、これまでどおり引ける
    expect(top('下降', 1)).toEqual(['trending-down']);
    expect(searchIconSet(allIcons, '研修').hits.length).toBeGreaterThan(0);
  });

  it('見出しの読み（ひらがな）が、離れた行の同じ読みと重ならない（工場の語が先頭に来る読み）', () => {
    const rows = CONCEPTS.map(([k]) => k.split('/'));
    const owners = (kana: string) => rows.filter((r) => r.includes(kana)).map((r) => r[0]);
    expect(owners('かこう')).toEqual(['工作']);
    expect(owners('けんしゅう')).toEqual(['検品']);
  });
});

describe('0.3.1 の拡充の効果（集の追加前は出なかった・圏外だったもの）', () => {
  // Lucide と Sash を外した索引（0.3.0 までの Fluent + Tabler）と、今の索引を比べる
  const before = [...fluentIcons, ...tablerIcons];
  const rank = (icons: typeof allIcons, q: string, name: string) => searchIconSet(icons, q).hits.findIndex((h) => h.icon.name === name);

  it.each([
    ['旋盤', 'lathe'],
    ['エレベーター', 'elevator-car'],
    ['見積', 'estimate-sheet'],
    ['金型', 'mold-die'],
    ['溶接', 'welding-torch'],
    ['受注', 'sales-order'],
    ['納品書', 'delivery-note'],
    ['部品表', 'parts-tree'],
    ['梱包', 'packing-box'],
    ['名刺', 'business-card'],
  ])('「%s」で %s が上位 5 件に出る（Sash を外すと、そもそもそのアイコンがない）', (q, name) => {
    expect(before.some((i) => i.name === name)).toBe(false);
    const r = rank(allIcons, q, name);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(5);
  });

  it('Lucide のアイコンが、受け入れの語の上位に出る（Lucide を外すと出ない）', () => {
    for (const [q, name] of [['検品', 'package-check'], ['検討', 'search-check'], ['歯車', 'cog'], ['設計', 'drafting-compass']] as const) {
      expect(before.some((i) => i.name === name), name).toBe(false);
      const r = rank(allIcons, q, name);
      expect(r, `${q} → ${name}`).toBeGreaterThanOrEqual(0);
      expect(r, `${q} → ${name}`).toBeLessThan(5);
    }
  });

  it('Fluent + Tabler だけの索引では先頭に lathe は出ない（アイコンがないため）。いまは先頭に出る', () => {
    const lathe = searchIconSet(before, '旋盤').hits.slice(0, 3).map((h) => h.icon.name);
    expect(lathe).not.toContain('lathe');
    expect(searchIconSet(allIcons, '旋盤').hits[0]!.icon.name).toBe('lathe');
  });
});
