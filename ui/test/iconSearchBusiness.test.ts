// 0.3.1：業務の言葉（営業・設計・工作・出荷・開発・検討・部品・製品・エレベーター ほか）で、妥当なアイコンが上位に出ること。
// 辞書（iconConcepts.ts）の「業務語の拡充」と、Lucide・Sash のアイコンの受け入れ確認。
import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../src/fluent/iconConcepts';
import { searchIconSet } from '../src/fluent/iconSearch';
import { allIcons } from './helpers/allIcons';

const top = (q: string, n: number) => searchIconSet(allIcons, q).hits.slice(0, n).map((h) => h.icon.name);

/** [検索語, 上位 n 件のどれかに入っていてほしいアイコン名, n] */
const ACCEPTANCE: readonly (readonly [string, readonly string[], number])[] = [
  ['営業', ['handshake', 'business-card', 'sales-order'], 5],
  ['設計', ['drawing-sheet', 'drafting-compass', 'pencil-ruler'], 3],
  ['工作', ['lathe', 'machining-center', 'drill'], 3],
  ['出荷', ['truck-delivery', 'stock-out', 'truck-loading'], 3],
  ['開発', ['prototype-cube', 'flask-conical', 'microscope'], 3],
  ['検討', ['search-check', 'clipboard-search', 'scale'], 3],
  ['部品', ['hex-bolt', 'nut', 'bearing'], 3],
  ['製品', ['package', 'packing-box', 'box'], 3],
  ['エレベーター', ['elevator', 'elevator-car'], 2],
  ['エレベータ', ['elevator', 'elevator-car'], 2],
  ['昇降機', ['elevator', 'elevator-car'], 2],
  ['旋盤', ['lathe'], 1],
  ['図面', ['drawing-sheet'], 1],
  ['見積', ['estimate-sheet'], 1],
  ['納期', ['deadline-calendar', 'calendar-due'], 2],
  ['在庫', ['shelf-stock', 'packages', 'box'], 3],
  ['検品', ['package-check', 'scan-search', 'clipboard-check'], 3],
  ['梱包', ['packing-box'], 1],
  ['フォークリフト', ['forklift'], 1],
  // 受け入れの語のほかに、重点の言葉
  ['金型', ['mold-die'], 1],
  ['溶接', ['welding-torch'], 1],
  ['受注', ['sales-order'], 1],
  ['発注', ['purchase-order'], 1],
  ['名刺', ['business-card'], 1],
  ['部品表', ['parts-tree'], 1],
  ['承認', ['rubber-stamp', 'stamp'], 3],
  ['基板', ['circuit-board'], 1],
  ['ねじ', ['hex-bolt', 'screw'], 3],
  ['ボルト', ['hex-bolt'], 1],
  ['歯車', ['cog'], 1],
  ['原価', ['cost-down'], 1],
  ['工程', ['chart-gantt', 'kanban', 'workflow'], 3],
  ['コンテナ', ['container'], 1],
  ['パレット', ['pallet', 'pallet-stack'], 4],
  ['バーコード', ['scan-barcode', 'barcode'], 2],
  ['倉庫', ['shelf-stock', 'building-warehouse', 'warehouse'], 4],
  ['出庫', ['stock-out'], 3],
  ['入荷', ['stock-in'], 1],
  ['納品書', ['delivery-note'], 3],
  ['コンパス', ['drafting-compass'], 1],
  ['人事', ['id-card-lanyard', 'users-group'], 2],
];

describe('業務の言葉で探す（受け入れ）', () => {
  for (const [q, want, n] of ACCEPTANCE) {
    it(`「${q}」の上位 ${n} 件に ${want.join(' / ')} のどれかが出る`, () => {
      const got = top(q, n);
      expect(got.some((g) => want.includes(g)), `${q}: ${got.join(', ')}`).toBe(true);
    });
  }

  it('言い換え・表記ゆれ（英語・ひらがな・カタカナ・略称）でも同じ結果の先頭に着く', () => {
    expect(top('せんばん', 1)).toEqual(['lathe']);
    expect(top('ずめん', 1)).toEqual(['drawing-sheet']);
    expect(top('かながた', 1)).toEqual(['mold-die']);
    expect(top('のうひんしょ', 4)).toContain('delivery-note');
    expect(top('みつもりしょ', 1)).toEqual(['estimate-sheet']);
    expect(top('出貨', 3)).toContain('truck-delivery');
    expect(top('発送', 8)).toContain('truck-delivery');
    expect(top('R&D', 3).some((n) => ['prototype-cube', 'flask-conical', 'microscope'].includes(n))).toBe(true);
    expect(top('CAD', 3)).toContain('drawing-sheet');
    expect(top('エレベータ', 1)).toEqual(top('エレベーター', 1));
    expect(top('EV', 10)).toContain('elevator');
    expect(top('EV', 10)).toContain('ev-charger');
    expect(top('リフト', 3)).toContain('elevator');
    expect(top('ダムウェーター', 1)).toEqual(['freight-lift']);
    expect(top('プロトタイプ', 1)).toEqual(['prototype-cube']);
  });

  it('Sash のオリジナルのアイコンは、すべていずれかの辞書の語から引ける', () => {
    const named = new Set<string>();
    for (const [, terms] of CONCEPTS) for (const t of terms.split(' ')) named.add(t);
    const lost = allIcons.filter((i) => i.set === 'sash').filter((i) => !named.has(i.name) && !named.has(i.words[0]!)).map((i) => i.name);
    // 辞書の言葉に名前が出てこないもの（タグだけで引けるもの）。10 個未満であること
    expect(lost.length).toBeLessThan(10);
  });

  it('辞書は拡充後、概念が 460 以上、見出しが 4,800 以上', () => {
    const heads = new Set<string>();
    for (const [k] of CONCEPTS) k.split('/').forEach((x) => heads.add(x));
    expect(CONCEPTS.length).toBeGreaterThanOrEqual(460);
    expect(heads.size).toBeGreaterThanOrEqual(4800);
  });
});
