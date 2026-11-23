import { describe, expect, it } from 'vitest';
import { jaTermsInText, toIcons } from '../src/fluent/fluent';
import { suggestFluent, suggestImageMso, suggestTerms } from '../src/iconSuggest';

const NAMES = ['FileSave', 'FileSaveAs', 'FilePrint', 'AutoSum', 'PrintPreviewClose', 'Copy', 'SortDialog', 'Filter', 'ExportTextFile', 'Refresh'];

describe('アイコンの候補', () => {
  it('ラベルの中の日本語の言葉を英単語にする（文の中で先に出る言葉が先）', () => {
    expect(jaTermsInText('集計する')[0]).toBe('autosum');
    expect(suggestTerms('CSV出力')).toContain('csv');
    expect(jaTermsInText('上書き')).not.toContain('arrow_up');
  });

  it('imageMso：辞書の英単語が名前に含まれるものを、名前の素直なものから並べる', () => {
    const r = suggestImageMso('保存', NAMES, new Map());
    expect(r[0]).toBe('FileSave');
    expect(r).toContain('FileSaveAs');
    expect(r.indexOf('FileSave')).toBeLessThan(r.indexOf('FileSaveAs'));
    expect(suggestImageMso('集計する', NAMES, new Map())[0]).toBe('AutoSum');
  });

  it('imageMso：言葉が複数あれば、言葉ごとに交互に取る', () => {
    const r = suggestImageMso('集計して保存', ['AutoSum', 'AutoSumMax', 'AutoSumMin', 'AutoSumCount', 'AutoSumMenu', 'FileSave'], new Map());
    expect(r[0]).toBe('AutoSum');
    expect(r).toContain('FileSave');
  });

  it('imageMso：Excel の日本語の表示名が一致するものを最優先する', () => {
    const labels = new Map([['PrintPreviewClose', '印刷'], ['FilePrint', 'クイック印刷']]);
    const r = suggestImageMso('印刷', NAMES, labels);
    expect(r[0]).toBe('PrintPreviewClose');
    expect(r).toContain('FilePrint');
  });

  it('imageMso：手がかりがなければ空、最大 5 個', () => {
    expect(suggestImageMso('ほげほげ', NAMES, new Map())).toEqual([]);
    expect(suggestImageMso('', NAMES, new Map())).toEqual([]);
    const many = Array.from({ length: 20 }, (_v, i) => `FileSave${'X'.repeat(i)}`);
    expect(suggestImageMso('保存', many, new Map())).toHaveLength(5);
  });

  it('アイコン集：言葉ごとの候補を交互に並べる', async () => {
    const icons = toIcons({
      source: '', version: '', license: '',
      icons: { save: ['M0 0', 'M0 0'], save_copy: ['M0 0', 'M0 0'], document_csv: ['M0 0', 'M0 0'], arrow_export: ['M0 0', 'M0 0'], share: ['M0 0', 'M0 0'], print: ['M0 0', 'M0 0'] },
    });
    expect((await suggestFluent(icons, '保存'))[0]!.name).toBe('save');
    const csv = (await suggestFluent(icons, 'CSV出力')).map((i) => i.name);
    expect(csv).toContain('document_csv');
    expect(csv.length).toBeLessThanOrEqual(5);
    expect(await suggestFluent(icons, 'ほげ')).toEqual([]);
  });
});
