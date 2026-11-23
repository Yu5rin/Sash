import { describe, expect, it } from 'vitest';
import fluentData from '../src/fluent/fluentIcons.json';
import tablerData from '../src/fluent/tablerIcons.json';
import tablerLicense from '../src/fluent/LICENSE-tabler-icons.txt?raw';
import { THIRD_PARTY_LICENSES } from '../src/shell/licenses';
import {
  buildSvg, displayName, iconKey, iconSet, loadIconSet, toIcons, toTablerIcons,
  type FluentData, type FluentIcon, type TablerData,
} from '../src/fluent/fluent';

const tabler = toTablerIcons(tablerData as unknown as TablerData);
const fluent = toIcons(fluentData as unknown as FluentData);

const tablerIcon = (name: string): FluentIcon => tabler.find((i) => i.name === name)!;

describe('Tabler のデータ', () => {
  it('パッケージの版とライセンスを持ち、ブランドのロゴは含まない', () => {
    const d = tablerData as unknown as TablerData;
    expect(d.license).toBe('MIT');
    expect(d.source).toBe('@tabler/icons');
    expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(d.categories).not.toContain('Brand');
    expect(d.categories).toContain('Animals');
    expect(tabler.length).toBeGreaterThan(5000);
    expect(tabler.some((i) => i.name.startsWith('brand-'))).toBe(false);
  });

  it('アイコンに出どころ・単語・タグ・カテゴリが付く', () => {
    const cat = tablerIcon('cat');
    expect(iconSet(cat)).toBe('tabler');
    expect(cat.words).toEqual(['cat']);
    expect(cat.tablerCategory).toBe('Animals');
    expect(cat.tags!.length).toBeGreaterThan(0);
    expect(tablerIcon('letter-a').words).toEqual(['letter', 'a']);
    expect(iconSet(fluent[0]!)).toBe('fluent');
  });

  it('すべてのアイコンが、線か塗りのどちらかを持つ', () => {
    expect(tabler.every((i) => i.regular !== 0 || i.filled !== 0)).toBe(true);
    // 塗りは一部だけ（Tabler の塗りは約1,000個）
    expect(tabler.filter((i) => i.filled !== 0).length).toBeGreaterThan(900);
  });

  it('同梱しているデータの合計は 8,000 個前後', () => {
    expect(fluent.length + tabler.length).toBeGreaterThan(7500);
  });
});

describe('Tabler の SVG の組み立て', () => {
  it('線のアイコンは、色を stroke に入れて塗りは付けない（fill に入れると輪郭が塗りつぶされるため）', () => {
    const svg = buildSvg(tablerIcon('home'), 'regular', '#217346', 32)!;
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="#217346"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('width="32" height="32" viewBox="0 0 24 24"');
    expect(svg).not.toContain('fill="#217346"');
  });

  it('塗りのアイコンは、色を fill に入れる', () => {
    const svg = buildSvg(tablerIcon('home'), 'filled', '#c42b1c')!;
    expect(svg).toContain('fill="#c42b1c"');
    expect(svg).not.toContain('stroke=');
  });

  it('線と塗りの両方を使うパスと、塗りだけのパスを、印から組み立てる', () => {
    const icon: FluentIcon = { name: 'x', words: ['x'], set: 'tabler', size: 24, filled: 0, regular: ['M0 0h1', '#M2 2h1', '@M4 4h1'] };
    const svg = buildSvg(icon, 'regular', '#000000')!;
    expect(svg).toContain('<path d="M0 0h1"/>');
    expect(svg).toContain('<path d="M2 2h1" fill="#000000"/>');
    expect(svg).toContain('<path d="M4 4h1" fill="#000000" stroke="none"/>');
  });

  it('画面の文字色（currentColor）でも組み立てられる（一覧を暗いテーマでも見えるように描くため）', () => {
    expect(buildSvg(tablerIcon('home'), 'regular', 'currentColor', 24)).toContain('stroke="currentColor"');
    expect(buildSvg(fluent[0]!, 'regular', 'currentColor', 24)).toContain('fill="currentColor"');
    // それ以外の文字列は既定の色にする（属性に入れるので）
    expect(buildSvg(tablerIcon('home'), 'regular', '"/><script>')).toContain('stroke="#424242"');
  });

  it('パスに想定外の文字があれば使わない', () => {
    const icon: FluentIcon = { name: 'bad', words: ['bad'], set: 'tabler', size: 24, filled: 0, regular: 'M0 0"/><script>' };
    expect(buildSvg(icon, 'regular', '#000000')).toBeNull();
    expect(buildSvg({ ...icon, regular: 0 }, 'regular', '#000000')).toBeNull();
  });

  it('全アイコンから SVG が組み立てられ、パスの文字がすべて許可されたもの', () => {
    for (const icon of tabler) {
      if (icon.regular !== 0) expect(buildSvg(icon, 'regular', '#000000'), icon.name).not.toBeNull();
      if (icon.filled !== 0) expect(buildSvg(icon, 'filled', '#000000'), icon.name).not.toBeNull();
    }
  });

  it('組み立てた SVG を DOM で読める（線・塗りの両方）', () => {
    for (const name of ['home', 'cat', 'letter-a', 'chart-bar', 'truck-delivery', 'percentage-100']) {
      const icon = tablerIcon(name);
      for (const v of ['regular', 'filled'] as const) {
        const s = buildSvg(icon, v, '#424242', 16);
        if (!s) continue;
        const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
        expect(doc.querySelector('parsererror'), `${name} ${v}`).toBeNull();
        expect(doc.querySelectorAll('path').length).toBeGreaterThan(0);
      }
    }
  });

  it('名前の表示と一意のキー', () => {
    expect(displayName('arrow-up-circle')).toBe('arrow up circle');
    expect(displayName('arrow_clockwise')).toBe('arrow clockwise');
    // home は Fluent にも Tabler にもあるので、出どころを含めたキーで区別する
    expect(iconKey(tablerIcon('home'))).toBe('tabler:home');
    expect(iconKey(fluent.find((i) => i.name === 'home')!)).toBe('fluent:home');
  });
});

describe('データの読み込み', () => {
  it('Fluent と Tabler を合わせて読み込み、2回目は同じ結果を返す', async () => {
    const a = await loadIconSet();
    expect(a.icons.length).toBe(fluent.length + tabler.length);
    expect(a.tablerVersion).toBe((tablerData as unknown as TablerData).version);
    expect(a.icons.some((i) => iconSet(i) === 'fluent')).toBe(true);
    expect(a.icons.some((i) => iconSet(i) === 'tabler')).toBe(true);
    expect(await loadIconSet()).toBe(a);
  });
});

describe('ライセンス', () => {
  it('Tabler の MIT License の全文を同梱し、アプリの中の一覧にも出る', () => {
    expect(tablerLicense).toContain('MIT License');
    expect(tablerLicense).toContain('Paweł Kuna');
    expect(tablerLicense).toContain('Permission is hereby granted');
    const entry = THIRD_PARTY_LICENSES.find((l) => l.name === 'Tabler Icons');
    expect(entry?.text).toBe(tablerLicense);
  });
});
