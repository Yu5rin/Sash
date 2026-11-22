import { describe, expect, it } from 'vitest';
import { attrRange, elementIndexAt, scanElements } from '../src/xmlpos';

describe('scanElements', () => {
  const text = '<?xml version="1.0"?>\n<a x="1>2"><!-- <b/> --><b/><c>\n<d y="q"/></c></a>';

  it('コメントや引用符の中を無視して要素を数える', () => {
    expect(scanElements(text).map((s) => s.tag)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('位置から最も内側の要素を返す', () => {
    const spans = scanElements(text);
    expect(elementIndexAt(spans, text.indexOf('<d') + 2)).toBe(3);
    expect(elementIndexAt(spans, text.indexOf('</c>'))).toBe(2);
  });

  it('属性の範囲を返す', () => {
    const spans = scanElements(text);
    const r = attrRange(text, spans[3]!, 'y')!;
    expect(text.slice(r.start, r.end)).toBe('y="q"');
  });
});
