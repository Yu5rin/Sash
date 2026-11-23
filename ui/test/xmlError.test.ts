import { describe, expect, it } from 'vitest';
import { describeXmlError } from '../src/xmlError';

describe('XML の構文エラーの日本語化', () => {
  const cases: [string, string][] = [
    ['27行目 11列：Unexpected closing tag: {http://x/ns}ribbon != {http://x/ns}broken', '閉じタグ </ribbon> に対応する開始タグが <broken> です'],
    ['3行目 5列：Unexpected end of stream: still inside the root element', '閉じられていないタグ'],
    ['1行目 1列：Unexpected end of stream: no root element found', 'XML が空です'],
    ['1行目 6列：Unexpected token: c', '属性の値は " で囲んでいるか'],
    ['1行目 5列：Unexpected token inside qualified name: />', '属性に値がありません'],
    ['1行目 7列：Unexpected token \'<\' before \'"\'', '属性の値に「<」は書けません'],
    ['1行目 5列：Unexpected token inside entity: </', '「&」の使い方'],
    ['1行目 10列：Attribute \'b\' is redefined', '属性 b が同じタグに二重'],
    ['1行目 5列：Element x:a prefix is unbound', '名前空間の接頭辞'],
    ['5行目 3列：Opening and ending tag mismatch: group line 4 and tab', '<group>（4行目）の閉じタグが <tab>'],
    ['5行目 3列：AttValue: " or \' expected', '引用符'],
    // > の閉じ忘れ（<button id="a" <button …）で Chromium が出す文
    ['4行目 20列：Unexpected token inside opening tag: <', '開始タグの中に予期しない文字があります（> の閉じ忘れの可能性）'],
    ['4行目 20列：Unexpected token inside opening tag: x', '開始タグの中に予期しない文字があります'],
  ];
  for (const [src, expected] of cases) {
    it(src, () => {
      const out = describeXmlError(src);
      expect(out).toContain(expected);
      // 行・列の前置きは残す
      expect(out.startsWith(src.slice(0, src.indexOf('：') + 1))).toBe(true);
    });
  }

  it('知らない文は原文のまま返す', () => {
    expect(describeXmlError('1行目 1列：Something new happened')).toBe('1行目 1列：Something new happened');
  });
});
