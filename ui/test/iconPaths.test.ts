// アイコンのビルド（scripts/iconPaths.mjs）：Lucide の元のパスが、相対→絶対の変換で変わっていないこと。
// 画素での比較は scripts/verify-icon-pixels.mjs（Chromium が要るので手で実行する）。ここは Chromium なしでできる、座標の比較。
import { describe, expect, it } from 'vitest';
import nodes from '../node_modules/lucide-static/icon-nodes.json';
import lucideData from '../src/fluent/lucideIcons.json';
import { absoluteStart, tidy } from '../scripts/iconPaths.mjs';
import { absolute } from './helpers/pathNormalize';

describe('absoluteStart（先頭の m を M にする）', () => {
  it('先頭の 1 組だけ絶対にして、続く暗黙の座標は相対の l にする（x と y の間の空白に影響されない）', () => {
    expect(absoluteStart('m11 13.73-4 6.93', 'x')).toBe('M11 13.73l-4 6.93');
    expect(absoluteStart('m3.34 17 1.73-1', 'x')).toBe('M3.34 17l1.73-1');
    expect(absoluteStart('m3.34,17 1.73-1', 'x')).toBe('M3.34 17l1.73-1');
    expect(absoluteStart('m1 2', 'x')).toBe('M1 2');
    expect(absoluteStart('m1 2v3', 'x')).toBe('M1 2v3');
    expect(absoluteStart('M1 2 3 4', 'x')).toBe('M1 2 3 4');
    // カンマ区切り・+ 符号・x と y の間が空白でないもの（続く座標は相対のまま）
    expect(absoluteStart('m12 5,3 4', 'x')).toBe('M12 5l3 4');
    expect(absoluteStart('m12,5 3,4', 'x')).toBe('M12 5l3,4');
    expect(absoluteStart('m1+2 3', 'x')).toBe('M1 2l3');
    expect(absoluteStart('m1 2,l3 4', 'x')).toBe('M1 2l3 4');
    // x と y の間が「空白 カンマ 空白」や改行のもの
    expect(absoluteStart('m1 , 2 3', 'x')).toBe('M1 2l3');
    expect(absoluteStart('m1\n2 3', 'x')).toBe('M1 2l3');
    expect(absoluteStart('m1 ,\n 2 3 4', 'x')).toBe('M1 2l3 4');
    expect(() => absoluteStart('x1 2', 'x')).toThrow();
  });

  it('座標の展開が元と同じ（先頭 m の暗黙の繰り返しを絶対座標にしたとき）', () => {
    expect(absolute(absoluteStart(tidy('m11 13.73-4 6.93', 'x'), 'x'))).toEqual(absolute('m11 13.73-4 6.93'));
    expect(absolute('m1 2 3 4')).toEqual(['M 1 2', 'L 4 6']);
  });
});

describe('Lucide のデータは、元のパスの座標と同じ（すべて）', () => {
  const icons = (lucideData as unknown as { icons: Record<string, [number, string, string | string[], 0]> }).icons;
  const flat = (e: string | string[]) => (Array.isArray(e) ? e : [e]).map((x) => (x.startsWith('#') ? x.slice(1) : x)).join('');

  it('元の path 要素の座標が、そのまま（絶対座標に直して）残っている', () => {
    const names = Object.keys(icons);
    expect(names.length).toBeGreaterThanOrEqual(185);
    const bad: string[] = [];
    for (const name of names) {
      const generated = absolute(flat(icons[name]![2])).join('|');
      for (const [tag, attrs] of (nodes as unknown as Record<string, [string, Record<string, string>][]>)[name]!) {
        if (tag !== 'path') continue;
        const want = absolute(attrs['d']!).join('|');
        if (!generated.includes(want)) bad.push(name);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it('塗りのある小さな点は、塗りと線の両方で描く印（#）を持つ（key-round・brain-circuit）', () => {
    for (const n of ['key-round', 'brain-circuit']) {
      const e = icons[n]![2];
      expect(Array.isArray(e) && e.some((x) => x.startsWith('#')), n).toBe(true);
    }
  });
});
