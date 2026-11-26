import { describe, expect, it } from 'vitest';
import { missingKeys } from '../src/i18n';

// 0.3.0 で足した画面の文言に、英語の訳があるか（辞書にない文言は日本語のまま出てしまう）。
// 文言は t('…') の第 1 引数の文字列そのものがキー。ここに挙げたファイルの t('…') を全部確かめる。

const FILES = [
  '../src/macroAssign.ts',
  '../src/dialogs/macroDialog.ts',
  '../src/recovery.ts',
  '../src/dialogs/recoveryDialog.ts',
  '../src/dialogs/externalChangeDialog.ts',
  '../src/shell/externalWatch.ts',
  '../src/importFlow.ts',
  '../src/dialogs/importDialog.ts',
  '../src/ribbonImport.ts',
  '../src/distributionCheck.ts',
];

const sources = import.meta.glob(['../src/**/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** t('…') の文字列を取り出す（エスケープした \' を含む）。変数の差し込みは {name} のまま。 */
function keysOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w.$])t\('((?:[^'\\\n]|\\.)*)'/g)) out.push(m[1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  return out;
}

describe('英語の辞書（0.3.0 の文言）', () => {
  it.each(FILES)('%s の t(…) の文言がすべて辞書にある', (file) => {
    const text = sources[file];
    expect(text, `${file} を読めない`).toBeTypeOf('string');
    const keys = keysOf(text!);
    expect(keys.length).toBeGreaterThan(0);
    expect(missingKeys(keys)).toEqual([]);
  });
});
