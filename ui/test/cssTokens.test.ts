import { describe, expect, it } from 'vitest';

// CSS の文字の大きさ・角丸・太さは、トークン（var(--fs-…) など）で書く（総点検 S-4）。直書きの値が増えると、
// 画面ごとに少しずつ大きさが違う「継ぎ足し」の見た目に戻る。また、ライト・ダークの切り替えを light-dark() に一本化しているので、
// color-mix() や入れ子の CSS は使わない（古い WebView2 で効かないため）。

// vitest は CSS を空にするので、ファイルを直接読む（node の型は tsconfig に含めていない）
// @ts-expect-error node:fs の型がない
const { readFileSync } = (await import('node:fs')) as { readFileSync: (p: string, enc: string) => string };
const FILES = ['src/styles.css', 'src/styles-views.css', 'src/styles-w3.css', 'src/styles-v3.css', 'src/fluent/fluent.css', 'src/icon/paint/paint.css'];
const css: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, 'utf8')]));

/** コメントを除く。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

describe('CSS のトークン', () => {
  it('font-size は var(--fs-…) か相対値（%・em・inherit）だけ', () => {
    const bad: string[] = [];
    for (const [f, text] of Object.entries(css)) {
      for (const m of strip(text).matchAll(/font-size:\s*([^;}]+)/g)) {
        const v = m[1]!.trim();
        if (!/^(var\(--fs-[a-z0-9]+\)|inherit|[\d.]+(%|em)|calc\(.*var\(--fs-.*\))$/.test(v)) bad.push(`${f}: font-size: ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('border-radius は var(--radius-…)・0・50% だけ（組み合わせは各値がそうであること）', () => {
    const bad: string[] = [];
    for (const [f, text] of Object.entries(css)) {
      for (const m of strip(text).matchAll(/border-radius:\s*([^;}]+)/g)) {
        const rest = m[1]!.replace(/var\(--radius-[a-z]+\)/g, '').replace(/\b0\b|50%|inherit/g, '').trim();
        if (rest !== '') bad.push(`${f}: border-radius: ${m[1]!.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('font-weight は 400 と 600 だけ', () => {
    const bad: string[] = [];
    for (const [f, text] of Object.entries(css)) {
      for (const m of strip(text).matchAll(/font-weight:\s*([^;}]+)/g)) {
        if (!/^(400|600|inherit|normal)$/.test(m[1]!.trim())) bad.push(`${f}: font-weight: ${m[1]!.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('color-mix() と入れ子の CSS を書かない', () => {
    const bad: string[] = [];
    for (const [f, text] of Object.entries(css)) {
      const body = strip(text);
      if (/color-mix\(/.test(body)) bad.push(`${f}: color-mix()`);
      if (/&\s*[.:#\[]/.test(body.replace(/"[^"]*"/g, ''))) bad.push(`${f}: 入れ子（&）`);
    }
    expect(bad).toEqual([]);
  });

  it('ハイコントラスト（forced-colors）の指定がある（総点検 G-14）', () => {
    expect(Object.values(css).some((t) => /@media\s*\(forced-colors:\s*active\)/.test(t))).toBe(true);
  });
});
