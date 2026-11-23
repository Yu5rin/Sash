import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { mountBottom, showBottomTab } from '../src/views/bottom';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G">
  <button id="b1" label="B1" onAction="Ribbon_b1_onAction" />
  <button id="b1" label="B2" />
</group></tab></tabs></ribbon></customUI>
`;

let tabs: HTMLElement;
let body: HTMLElement;

beforeAll(() => {
  tabs = document.createElement('div');
  tabs.setAttribute('role', 'tablist');
  body = document.createElement('div');
  body.setAttribute('role', 'tabpanel');
  document.body.append(tabs, body);
  mountBottom(tabs, body, () => undefined, () => undefined);
});

beforeEach(() => {
  showBottomTab('problems');
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

const press = (k: string) => (document.activeElement ?? tabs).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const selected = () => tabs.querySelector<HTMLElement>('[aria-selected="true"]')!;

describe('下部パネルのタブ', () => {
  it('選んでいるタブだけが tabindex=0 で、タブパネルと結び付く', () => {
    const tabEls = Array.from(tabs.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabEls.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    expect(tabEls[0]!.getAttribute('aria-controls')).toBe('bottom-body');
    expect(body.getAttribute('aria-labelledby')).toBe(tabEls[0]!.id);
  });

  it('クリックしても、作り直したタブにフォーカスが戻る', () => {
    tabs.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.click();
    expect(selected().id).toBe('bottom-tab-callbacks');
    expect(document.activeElement).toBe(selected());
  });

  it('← → ・Home・End で移り、移った先にフォーカスがある', () => {
    selected().focus();
    press('ArrowRight');
    expect(selected().id).toBe('bottom-tab-callbacks');
    expect(document.activeElement).toBe(selected());
    press('End');
    expect(selected().id).toBe('bottom-tab-images');
    press('ArrowRight');
    expect(selected().id).toBe('bottom-tab-problems');
    press('ArrowLeft');
    expect(selected().id).toBe('bottom-tab-images');
    press('Home');
    expect(selected().id).toBe('bottom-tab-problems');
    expect(body.getAttribute('aria-labelledby')).toBe('bottom-tab-problems');
  });

  it('本文にフォーカスがあるときの描き直しでは、フォーカスをタブへ奪わない', () => {
    const li = body.querySelector<HTMLElement>('li.problem')!;
    li.focus();
    app.emit('problems');
    expect(tabs.contains(document.activeElement)).toBe(false);
  });
});

describe('問題の一覧', () => {
  it('「対象のラベル（種類）：文」の順で出す', () => {
    const msg = body.querySelector('li.problem .msg')!.textContent!;
    expect(msg).toMatch(/^B\d（.+）：/);
  });

  it('id の重複には「ID を振り直す」が出て、押すと重複が解ける', () => {
    const fix = Array.from(body.querySelectorAll<HTMLElement>('.problem-fix')).find((b) => b.textContent === 'ID を振り直す');
    expect(fix).toBeDefined();
    fix!.click();
    const ids = Array.from(app.store!.doc.querySelectorAll('button')).map((b) => b.getAttribute('id'));
    expect(new Set(ids).size).toBe(2);
  });
});
