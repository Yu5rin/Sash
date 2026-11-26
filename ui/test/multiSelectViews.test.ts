// 複数選択の画面（インスペクタのまとめて変更・ツリーの Ctrl / Shift +クリック。仕様書 §19）のテスト。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { pathOf } from '../src/model';
import { mountInspector } from '../src/views/inspector';
import { mountTree } from '../src/views/tree';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g" label="G">
          <button id="b1" label="B1" size="large" />
          <button id="b2" label="B2" size="large" />
          <button id="b3" label="Same" />
          <toggleButton id="tg" label="Same" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

let insp: HTMLElement;
let tree: HTMLElement;
const noop = () => undefined;

beforeAll(() => {
  // jsdom には scrollIntoView がない
  Element.prototype.scrollIntoView = () => undefined;
  insp = document.createElement('div');
  tree = document.createElement('div');
  document.body.append(insp, tree);
  mountInspector(insp, { pickIdMso: noop, pickImageMso: noop, editImage: noop, pickFromLibrary: noop });
  mountTree(tree);
});

// 予約済みの検査がテスト環境の後始末のあとに走って、window がないエラーになるのを避ける
afterAll(() => app.close());

beforeEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

const p = (id: string) => pathOf(app.store!.doc.querySelector(`[id="${id}"]`)!);
const attrOf = (id: string, name: string) => app.store!.doc.querySelector(`[id="${id}"]`)!.getAttribute(name);
const row = (id: string) => tree.querySelector<HTMLElement>(`.tree-row[data-path="${p(id).join('.')}"]`)!;

function pick(...ids: string[]): void {
  app.store!.select(p(ids[0]!), 'canvas');
  for (const id of ids.slice(1)) app.store!.toggleSelect(p(id), 'canvas');
}

describe('インスペクタのまとめて変更', () => {
  it('見出しに数と種類の内訳を出し、id は出さない', () => {
    pick('b1', 'b2', 'tg');
    expect(insp.querySelector('.insp-title')!.textContent).toBe('3 個の要素（ボタン 2・トグルボタン 1）');
    expect(insp.querySelector('[data-attr="id"]')).toBeNull();
    expect(insp.querySelector('[data-attr="size"]')).not.toBeNull();
  });

  it('値が違う列挙値は「（複数の値）」を出し、選び直すと一度の編集で全部に入る', () => {
    pick('b1', 'b3', 'tg');
    const size = insp.querySelector<HTMLSelectElement>('[data-attr="size"]')!;
    expect(size.selectedOptions[0]!.textContent).toBe('（複数の値）');
    size.value = 'normal';
    size.dispatchEvent(new Event('change'));
    expect(['b1', 'b3', 'tg'].map((id) => attrOf(id, 'size'))).toEqual(['normal', 'normal', 'normal']);
    expect(app.store!.undoLabel).toBe('3 個の size を normal に変更');
    // 選択は保ったまま、値がそろったので「（複数の値）」は消える
    expect(app.store!.selections).toHaveLength(3);
    expect(insp.querySelector<HTMLSelectElement>('[data-attr="size"]')!.value).toBe('normal');
    app.store!.undo();
    expect(attrOf('b1', 'size')).toBe('large');
    expect(attrOf('b3', 'size')).toBeNull();
  });

  it('文字の欄：そろっていれば値を、違えば空欄に「（複数の値）」を出す。空のまま離れても消さない', () => {
    pick('b3', 'tg');
    expect(insp.querySelector<HTMLInputElement>('[data-attr="label"]')!.value).toBe('Same');
    pick('b1', 'b2');
    const label = insp.querySelector<HTMLInputElement>('[data-attr="label"]')!;
    expect(label.value).toBe('');
    expect(label.placeholder).toBe('（複数の値）');
    label.dispatchEvent(new Event('change'));
    expect(attrOf('b1', 'label')).toBe('B1');
    label.value = 'Run';
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect([attrOf('b1', 'label'), attrOf('b2', 'label')]).toEqual(['Run', 'Run']);
  });

  it('真偽値は 既定 / はい / いいえ で、押すと全部に入る', () => {
    pick('b1', 'b2', 'tg');
    const seg = insp.querySelector('[data-attr="showLabel"]')!;
    const no = Array.from(seg.querySelectorAll('button')).find((b) => b.textContent === 'いいえ')!;
    no.click();
    expect(['b1', 'b2', 'tg'].map((id) => attrOf(id, 'showLabel'))).toEqual(['false', 'false', 'false']);
    expect(app.store!.undoLabel).toBe('3 個の showLabel を false に変更');
  });

  it('「小さく」ボタンで size をまとめて normal にする', () => {
    pick('b1', 'b2');
    const small = Array.from(insp.querySelectorAll<HTMLButtonElement>('.insp-bulk-actions button')).find((b) => b.textContent === '小さく')!;
    small.click();
    expect([attrOf('b1', 'size'), attrOf('b2', 'size')]).toEqual(['normal', 'normal']);
  });
});

describe('ツリーの複数選択', () => {
  it('Ctrl+クリックで足し、Shift+クリックで範囲を選び、ほかの選択に印を付ける', () => {
    row('b1').click();
    row('b3').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(app.store!.selections).toEqual([p('b1'), p('b3')]);
    expect(row('b3').classList.contains('selected')).toBe(true);
    expect(row('b1').classList.contains('multi-selected')).toBe(true);
    expect(row('b1').getAttribute('aria-selected')).toBe('true');
    row('tg').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    // 起点は最後に Ctrl+クリックした b3
    expect(app.store!.selections).toEqual([p('b3'), p('tg')]);
  });

  it('Shift+↓ で範囲を広げ、Esc で主な選択だけに戻す', () => {
    row('b1').click();
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(app.store!.selections).toEqual([p('b1'), p('b2'), p('b3')]);
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.store!.selections).toEqual([p('b3')]);
  });

  it('Ctrl+A で同じ階層をすべて選ぶ', () => {
    row('b2').click();
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    expect(app.store!.selections).toHaveLength(4);
    expect(tree.querySelectorAll('.tree-row.multi-selected')).toHaveLength(3);
  });
});

describe('レビューの指摘の修正（仕様書 §19）', () => {
  const enter = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  it('まとめて変更でも、コールバック名を確かめて入れない（単独のインスペクタと同じ知らせ方）', () => {
    pick('b1', 'b2');
    const input = insp.querySelector<HTMLInputElement>('input[data-attr="onAction"]')!;
    enter(input, '1 bad name!');
    expect([attrOf('b1', 'onAction'), attrOf('b2', 'onAction')]).toEqual([null, null]);
    const error = input.parentElement!.querySelector<HTMLElement>('.field-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('VBA の Sub 名として使えない文字があります');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // 直せば入る
    enter(input, 'Module1.OnRun');
    expect([attrOf('b1', 'onAction'), attrOf('b2', 'onAction')]).toEqual(['Module1.OnRun', 'Module1.OnRun']);
  });

  it('まとめて変更でも keytip は 3 文字まで', () => {
    pick('b1', 'b2');
    const input = insp.querySelector<HTMLInputElement>('input[data-attr="keytip"]')!;
    enter(input, 'ABCD');
    expect(attrOf('b1', 'keytip')).toBeNull();
    expect(input.parentElement!.querySelector('.field-error')!.textContent).toBe('keytip は3文字以内で指定してください');
    enter(input, 'Q');
    expect([attrOf('b1', 'keytip'), attrOf('b2', 'keytip')]).toEqual(['Q', 'Q']);
  });

  it('単独のインスペクタも同じ決まりで keytip の長さを確かめる', () => {
    app.store!.select(p('b1'), 'canvas');
    const input = insp.querySelector<HTMLInputElement>('input[data-attr="keytip"]')!;
    enter(input, 'ABCD');
    expect(attrOf('b1', 'keytip')).toBeNull();
    expect(input.closest('.insp-field')!.querySelector('.field-error')!.textContent).toBe('keytip は3文字以内で指定してください');
  });

  it('ツリーを絞り込んでいるときの Ctrl+A は、見えている兄弟だけを選ぶ（続く Delete で隠れた要素を消さない）', () => {
    const filter = document.querySelector<HTMLInputElement>('.tree-filter input')!;
    filter.value = 'Same';
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tree.querySelectorAll('.tree-row')).not.toHaveLength(0);
    row('b3').click();
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    expect(app.store!.selections).toEqual([p('b3'), p('tg')]);
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(app.store!.doc.querySelector('[id="b1"]')).not.toBeNull();
    expect(app.store!.doc.querySelector('[id="b2"]')).not.toBeNull();
    expect(app.store!.doc.querySelector('[id="b3"]')).toBeNull();
    expect(app.store!.doc.querySelector('[id="tg"]')).toBeNull();
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('ツリーの Shift+クリックは、絞り込みで隠れた兄弟を範囲に入れない', () => {
    // b1 のラベルも「Same」にして、絞り込みで b1・b3・tg を出し、間の b2 だけを隠す
    app.store!.edit('other', (doc) => {
      doc.querySelector('[id="b1"]')!.setAttribute('label', 'Same');
    });
    const filter = document.querySelector<HTMLInputElement>('.tree-filter input')!;
    filter.value = 'Same';
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tree.querySelector(`.tree-row[data-path="${p('b2').join('.')}"]`)).toBeNull();
    row('b1').click();
    row('b3').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(app.store!.selections).toEqual([p('b1'), p('b3')]);
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});
