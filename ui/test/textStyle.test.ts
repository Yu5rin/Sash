import { describe, expect, it } from 'vitest';

// 表記の決まり（docs/SPEC.md「表記」）：英字と日本語の間は半角空白 1 つ。画面の文言で、Excel などの直後・直前が日本語の文字になっていないか調べる。
// 「Excelへ反映」と「Excel へ反映する」が同じ画面に並んでいた（総点検 G-10）。戻らないようにする。

const WORDS = 'Excel|XML|VBA|VBE|ID|DPI|Sub|CSV';
const JP = 'ぁ-んァ-ヶー一-龠々';
const after = new RegExp(`(?<![A-Za-z0-9_])(${WORDS})(?=[${JP}])`);
const before = new RegExp(`(?<=[${JP}])(${WORDS})(?![A-Za-z0-9_])`);

/** 画面の文言ではなく、利用者の例として置いてあるデータ（サンプルのラベルなど）。 */
const DATA_FILES = new Set(['../src/sample.ts']);

const sources = import.meta.glob(['../src/**/*.ts', '../index.html'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('表記：英字と日本語の間の半角空白', () => {
  it('Excel・XML・VBA・VBE・ID・DPI・Sub・CSV の直前・直後が日本語の文字になっていない', () => {
    const bad: string[] = [];
    for (const [rel, text] of Object.entries(sources)) {
      if (DATA_FILES.has(rel)) continue;
      text.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return;
        // XML のサンプル（label="CSV出力" など、利用者のデータの例）は対象にしない
        if (/\b(label|screentip|supertip|title|description)="[^"]*(?:CSV|Excel|XML|VBA)/.test(line) && /<(button|group|tab|menu|toggleButton)\b/.test(line)) return;
        if (after.test(line) || before.test(line)) bad.push(`${rel}:${i + 1}: ${t.slice(0, 100)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

// C#（ホスト）の日本語の文言も同じ決まりにする（見直し 低12）。L("日本語", "English") の日本語側と、UserFacingException などの文言を見る。
// 英語側は対象外（日本語の文字を含まない）。ビルド成果物（obj・bin）は除く。
const csSources = import.meta.glob(['../../src/**/*.cs', '!../../src/**/obj/**', '!../../src/**/bin/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('表記：C# の日本語の文言', () => {
  it('L("…") と UserFacingException などの文言で、Excel などの直前・直後が日本語の文字になっていない', () => {
    expect(Object.keys(csSources).length).toBeGreaterThan(10);
    const literal = /(?:\bL\(\s*|UserFacingException\(\s*|UserErrors\.(?:Argument|Format)\(\s*)\$?"((?:[^"\\]|\\.)*)"/g;
    const bad: string[] = [];
    for (const [rel, text] of Object.entries(csSources)) {
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(literal)) {
          const body = m[1]!;
          if (after.test(body) || before.test(body)) bad.push(`${rel}:${i + 1}: ${body.slice(0, 80)}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });
});
