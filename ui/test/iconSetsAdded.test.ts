// 0.3.1 で足したアイコン集（Lucide と Sash のオリジナル）。件数・ライセンス・組み立て・名前の重なり・カテゴリを確かめる。
import { describe, expect, it } from 'vitest';
import lucideData from '../src/fluent/lucideIcons.json';
import sashData from '../src/fluent/sashIcons.json';
import lucideLicense from '../src/fluent/LICENSE-lucide.txt?raw';
import sashLicense from '../src/fluent/LICENSE-sash-icons.txt?raw';
import { THIRD_PARTY_LICENSES } from '../src/shell/licenses';
import { buildSvg, iconKey, isStrokeSet, setFilePrefix, setLabel, type TablerData } from '../src/fluent/fluent';
import { categorize, categoryBit } from '../src/fluent/iconCategories';
import { allIcons, fluentIcons, lucideIcons, sashIcons, tablerIcons } from './helpers/allIcons';

describe('Lucide のデータ', () => {
  const d = lucideData as unknown as TablerData;

  it('ISC License の版つきデータで、業務向けに選んだ 150 個以上（全部は入れない）', () => {
    expect(d.source).toBe('lucide-static');
    expect(d.license).toBe('ISC');
    expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lucideIcons.length).toBeGreaterThanOrEqual(150);
    expect(lucideIcons.length).toBeLessThan(400);
  });

  it('Tabler にある名前は入れていない（同じ名前を二重に出さない）', () => {
    const t = new Set(tablerIcons.map((i) => i.name));
    expect(lucideIcons.filter((i) => t.has(i.name)).map((i) => i.name)).toEqual([]);
  });

  it('ものづくり・物流・営業の主なアイコンがある', () => {
    const names = new Set(lucideIcons.map((i) => i.name));
    for (const n of ['factory', 'warehouse', 'hand-truck', 'handshake', 'hard-hat', 'drafting-compass', 'ruler-dimension-line', 'robot-arm', 'shelving-unit', 'scan-barcode', 'package-check', 'screwdriver', 'chart-gantt', 'id-card']) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it('図形はすべてパスに直してあり、M で始まる 1 本のパス（つないでも相対にならない）', () => {
    for (const i of lucideIcons) {
      expect(typeof i.regular, i.name).toBe('string');
      expect((i.regular as string).startsWith('M'), i.name).toBe(true);
      expect(i.filled, i.name).toBe(0);
      expect(buildSvg(i, 'regular', '#000000'), i.name).not.toBeNull();
    }
  });

  it('ISC License と Feather 由来の MIT License の全文を同梱し、アプリの中の一覧にも出る', () => {
    expect(lucideLicense).toContain('ISC License');
    expect(lucideLicense).toContain('Lucide Icons and Contributors');
    expect(lucideLicense).toContain('Cole Bemis');
    expect(lucideLicense).toContain('lucide-static ' + d.version);
    expect(THIRD_PARTY_LICENSES.find((l) => l.name === 'Lucide')?.text).toBe(lucideLicense);
  });
});

describe('Sash のオリジナルのアイコン', () => {
  const d = sashData as unknown as TablerData;

  it('エレベーター・旋盤・金型・パレット・見積書など 30 個以上を自作している', () => {
    expect(d.license).toBe('Sash');
    expect(sashIcons.length).toBeGreaterThanOrEqual(30);
    const names = new Set(sashIcons.map((i) => i.name));
    for (const n of ['elevator-car', 'elevator-shaft', 'elevator-call', 'lathe', 'machining-center', 'mold-die', 'welding-torch', 'pallet', 'hex-bolt', 'estimate-sheet', 'purchase-order', 'sales-order', 'stock-in', 'stock-out', 'parts-tree', 'drawing-sheet', 'business-card', 'deadline-calendar']) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it('Tabler・Lucide と同じ名前のものは作っていない', () => {
    const others = new Set([...tablerIcons, ...lucideIcons].map((i) => i.name));
    expect(sashIcons.filter((i) => others.has(i.name)).map((i) => i.name)).toEqual([]);
  });

  it('どれも線のアイコンで、全体が 24×24 の枠に収まる（座標が枠から大きくはみ出さない）', () => {
    for (const i of sashIcons) {
      expect(i.regular, i.name).not.toBe(0);
      const svg = buildSvg(i, 'regular', '#000000')!;
      expect(svg, i.name).toContain('stroke-width="2"');
      // 絶対座標の数字（M・L・H・V の直後）が、枠（0〜24）の内側にあること
      for (const m of (i.regular as string).matchAll(/[MLHV](-?\d+(?:\.\d+)?)/g)) {
        const v = Number(m[1]);
        expect(v, `${i.name}: ${m[0]}`).toBeGreaterThanOrEqual(1);
        expect(v, `${i.name}: ${m[0]}`).toBeLessThanOrEqual(23);
      }
    }
  });

  it('タグは英語だけ、出どころの表記は自作と分かる', () => {
    for (const i of sashIcons) expect(i.tags!.every((t) => /^[a-z0-9-]+$/.test(t)), i.name).toBe(true);
    expect(sashLicense).toContain('オリジナル');
    expect(sashLicense).toContain('MIT License');
    expect(THIRD_PARTY_LICENSES.find((l) => l.name === 'Sash original icons')?.text).toBe(sashLicense);
  });
});

describe('4 つのアイコン集の合わせ方', () => {
  it('合計は 8,200 個前後で、出どころごとの名前・ファイル名の前置き・描き方が決まっている', () => {
    expect(allIcons.length).toBe(fluentIcons.length + tablerIcons.length + lucideIcons.length + sashIcons.length);
    expect(allIcons.length).toBeGreaterThan(8200);
    expect(setLabel('lucide')).toBe('Lucide');
    expect(setLabel('sash')).toBe('Sash');
    expect(setFilePrefix('fluent')).toBe('');
    expect(setFilePrefix('lucide')).toBe('lucide-');
    expect(setFilePrefix('sash')).toBe('sash-');
    expect(isStrokeSet('fluent')).toBe(false);
    expect(['tabler', 'lucide', 'sash'].every((s) => isStrokeSet(s as 'tabler'))).toBe(true);
  });

  it('出どころを含めたキーは全アイコンで重ならない', () => {
    expect(new Set(allIcons.map(iconKey)).size).toBe(allIcons.length);
  });

  it('Lucide・Sash の線のアイコンは、色を stroke に入れて描く（Tabler と同じ）', () => {
    const svg = buildSvg(sashIcons.find((i) => i.name === 'lathe')!, 'regular', '#0f6cbd', 32)!;
    expect(svg).toContain('stroke="#0f6cbd"');
    expect(svg).toContain('fill="none"');
    expect(svg).not.toContain('fill="#0f6cbd"');
    expect(buildSvg(lucideIcons.find((i) => i.name === 'factory')!, 'filled', '#000000')).toBeNull();
  });

  it('ものづくり・工場のカテゴリがあり、Lucide・Sash の工場系はそこに入る。Tabler の nut は食べ物ではない', () => {
    const cat = (set: typeof allIcons, name: string) => categorize(set.find((i) => i.name === name)!);
    expect(cat(sashIcons, 'lathe') & categoryBit('industry')).not.toBe(0);
    expect(cat(lucideIcons, 'factory') & categoryBit('industry')).not.toBe(0);
    expect(cat(tablerIcons, 'forklift') & categoryBit('industry')).not.toBe(0);
    expect(cat(tablerIcons, 'nut') & categoryBit('food')).toBe(0);
    expect(cat(sashIcons, 'pallet') & categoryBit('business')).not.toBe(0);
  });
});
