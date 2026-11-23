// キャンバスの複数選択（見出しの数の印・読み上げ・Esc・Ctrl+A。仕様書 §19.2）のテスト。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { pathOf } from '../src/model';
import { mountCanvas } from '../src/views/canvas';
import { setPreview } from '../src/views/ribbonPreview';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g" label="G">
          <button id="b1" label="B1" />
          <button id="b2" label="B2" />
          <button id="b3" label="B3" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

let host: HTMLElement;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  host = document.createElement('div');
  host.id = 'canvas';
  document.body.append(host);
  mountCanvas(host, { onImageDrop: () => undefined });
});

beforeEach(() => {
  setPreview({ width: null, scale: 100, fit: 'fit', compare: false, keytips: false, keytipsAll: false });
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

afterEach(() => localStorage.clear());

const p = (id: string) => pathOf(app.store!.doc.querySelector(`[id="${id}"]`)!);
const node = (id: string) => host.querySelector<HTMLElement>(`[data-sel][data-path="${p(id).join('.')}"]`)!;
const live = () => document.querySelector<HTMLElement>('[data-live="selection"]')!;
const key = (k: string, opts: KeyboardEventInit = {}, target: HTMLElement = host) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

function pick(...ids: string[]): void {
  app.store!.select(p(ids[0]!), 'canvas');
  for (const id of ids.slice(1)) app.store!.toggleSelect(p(id), 'canvas');
}

describe('キャンバスの複数選択', () => {
  it('「N 個選択中」は状態の文字より前に置き、縮めない印にする（読み上げは別の領域）', () => {
    pick('b1', 'b2', 'b3');
    const header = host.querySelector('.cv-header')!;
    const kids = Array.from(header.children);
    const chip = header.querySelector<HTMLElement>('.cv-multi')!;
    const status = header.querySelector('.cv-status')!;
    expect(kids.indexOf(chip)).toBeLessThan(kids.indexOf(status));
    expect(chip.getAttribute('aria-label')).toBe('3 個選択中');
    expect(chip.querySelector('.cv-long')!.textContent).toBe('3 個選択中');
    expect(chip.querySelector('.cv-short')!.textContent).toBe('3 個');
    // 描き直しのたびに作り直す要素は、読み上げの領域にしない
    expect(chip.hasAttribute('aria-live')).toBe(false);
  });

  it('選んだ数は、作り直さない 1 つの領域の文字を書き換えて知らせる', () => {
    pick('b1', 'b2');
    const region = live();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('2 個選択中');
    app.store!.toggleSelect(p('b3'), 'canvas');
    expect(live()).toBe(region);
    expect(region.textContent).toBe('3 個選択中');
    app.store!.clearMulti('canvas');
    expect(live()).toBe(region);
    expect(region.textContent).toBe('');
    expect(document.querySelectorAll('[data-live="selection"]')).toHaveLength(1);
  });

  it('ほかの選択には破線の印だけを付け、役割のない要素に aria-selected を付けない', () => {
    pick('b1', 'b2');
    expect(node('b1').classList.contains('multi-selected')).toBe(true);
    expect(node('b1').hasAttribute('aria-selected')).toBe(false);
    expect(node('b2').hasAttribute('aria-selected')).toBe(false);
  });

  it('「表示」メニューを閉じる Esc では、複数選択を解かない（次の Esc で解く）', () => {
    pick('b1', 'b2');
    host.querySelector<HTMLButtonElement>('.cv-viewbtn')!.click();
    const item = host.querySelector<HTMLElement>('.cv-viewpop .cv-mi')!;
    expect(item).not.toBeNull();
    key('Escape', {}, item);
    expect(host.querySelector('.cv-viewpop')).toBeNull();
    expect(app.store!.selections).toHaveLength(2);
    // メニューの中のチェックボックスからでも閉じられる
    host.querySelector<HTMLButtonElement>('.cv-viewbtn')!.click();
    key('Escape', {}, host.querySelector<HTMLInputElement>('.cv-viewpop input')!);
    expect(host.querySelector('.cv-viewpop')).toBeNull();
    expect(app.store!.selections).toHaveLength(2);
    key('Escape');
    expect(app.store!.selections).toHaveLength(1);
  });

  it('Ctrl+A は、キャンバスに描かれている要素の順を渡して選ぶ', () => {
    app.store!.select(p('b2'), 'canvas');
    const spy = vi.spyOn(app.store!, 'selectAll');
    key('a', { ctrlKey: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const order = spy.mock.calls[0]![1]!;
    const rendered = new Set(Array.from(host.querySelectorAll<HTMLElement>('[data-sel][data-path]'), (n) => n.dataset['path']!));
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((x) => rendered.has(x.join('.')))).toBe(true);
    expect(order.map((x) => x.join('.'))).toEqual(expect.arrayContaining(['b1', 'b2', 'b3'].map((id) => p(id).join('.'))));
    expect(app.store!.selections).toEqual([p('b1'), p('b2'), p('b3')]);
    spy.mockRestore();
  });
});
