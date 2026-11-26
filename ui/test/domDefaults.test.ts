// 入力欄の既定（総点検 D-13）。
import { describe, expect, it } from 'vitest';
import { h } from '../src/dom';

describe('D-13 入力欄の既定', () => {
  it('input と textarea には spellcheck=false・autocomplete=off が付く（指定があればそちらを使う）', () => {
    const a = h('input', { type: 'text' });
    expect(a.getAttribute('spellcheck')).toBe('false');
    expect(a.getAttribute('autocomplete')).toBe('off');
    const b = h('textarea', null);
    expect(b.getAttribute('spellcheck')).toBe('false');
    const c = h('input', { type: 'text', spellcheck: true, autocomplete: 'on' });
    expect(c.getAttribute('spellcheck')).not.toBe('false');
    expect(c.getAttribute('autocomplete')).toBe('on');
    // 入力欄でない要素には付けない
    expect(h('div', null).hasAttribute('spellcheck')).toBe(false);
  });
});
