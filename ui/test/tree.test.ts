import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { pathOf } from '../src/model';
import { mountTree } from '../src/views/tree';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g" label="G">
          <button id="b1" label="B1" />
          <button id="b2" getLabel="Mod.GetLabel" />
          <separator id="s1" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

let tree: HTMLElement;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  tree = document.createElement('div');
  document.body.append(tree);
  mountTree(tree);
});

beforeEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

function select(id: string): Element {
  const el = app.store!.doc.querySelector(`[id="${id}"]`)!;
  app.store!.select(pathOf(el), 'tree');
  return el;
}

const press = (el: Element, key: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const input = () => tree.querySelector<HTMLInputElement>('.tree-rename');

describe('ツリーのその場での名前変更', () => {
  it('F2 で行の中に入力欄が出て、全選択される', () => {
    select('b1');
    tree.focus();
    press(tree, 'F2');
    expect(input()).not.toBeNull();
    expect(input()!.value).toBe('B1');
    expect(document.activeElement).toBe(input());
    expect(input()!.selectionStart).toBe(0);
    expect(input()!.selectionEnd).toBe(2);
  });

  it('Enter で確定し、フォーカスはツリーに残る。履歴から取り消せる', () => {
    const el = select('b1');
    press(tree, 'Enter');
    input()!.value = '新しい名前';
    press(input()!, 'Enter');
    expect(el.getAttribute('label')).toBe('新しい名前');
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(tree);
    expect(tree.querySelector('.tree-row.selected .tree-label')!.textContent).toBe('新しい名前');
    app.store!.undo();
    expect(app.store!.doc.querySelector('[id="b1"]')!.getAttribute('label')).toBe('B1');
  });

  it('Esc は取り消し、フォーカスはツリーに戻る', () => {
    const el = select('b1');
    press(tree, 'F2');
    input()!.value = '捨てる';
    press(input()!, 'Escape');
    expect(el.getAttribute('label')).toBe('B1');
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(tree);
  });

  it('空にして確定すると label 属性を外す', () => {
    const el = select('b1');
    press(tree, 'F2');
    input()!.value = '';
    press(input()!, 'Enter');
    expect(el.hasAttribute('label')).toBe(false);
  });

  it('日本語入力の変換中の Enter では確定しない', () => {
    const el = select('b1');
    press(tree, 'F2');
    input()!.value = 'かな';
    press(input()!, 'Enter', { isComposing: true });
    expect(el.getAttribute('label')).toBe('B1');
    expect(input()).not.toBeNull();
  });

  it('入力欄の中のキーはツリーの操作（矢印での選択など）に伝わらない', () => {
    select('b1');
    press(tree, 'F2');
    press(input()!, 'ArrowDown');
    expect(app.store!.selectedElement!.getAttribute('id')).toBe('b1');
    expect(input()).not.toBeNull();
  });

  it('変えずにほかへ移ったときは、行を作り直さずラベルを元に戻す', () => {
    select('b1');
    const row = tree.querySelector('.tree-row.selected')!;
    press(tree, 'F2');
    input()!.dispatchEvent(new FocusEvent('blur'));
    expect(input()).toBeNull();
    expect(tree.querySelector('.tree-row.selected')).toBe(row);
    expect(row.querySelector('.tree-label')!.textContent).toBe('B1');
    expect(row.getAttribute('draggable')).toBe('true');
  });

  it('入力欄から外れたとき、変えていれば保存する', () => {
    const el = select('b1');
    press(tree, 'F2');
    input()!.value = 'ほか';
    input()!.dispatchEvent(new FocusEvent('blur'));
    expect(el.getAttribute('label')).toBe('ほか');
  });

  it('VBA で返すラベル（getLabel）やラベルを持たない要素では入力欄を出さない', () => {
    select('b2');
    press(tree, 'F2');
    expect(input()).toBeNull();
    select('s1');
    press(tree, 'Enter');
    expect(input()).toBeNull();
  });

  it('入力中は、ほかの変更で描き直しても入力欄が消えない', () => {
    select('b1');
    press(tree, 'F2');
    input()!.value = '途中';
    app.store!.edit('xml', (doc) => doc.querySelector('[id="g"]')!.setAttribute('screentip', 'x'), 'test');
    expect(input()!.value).toBe('途中');
  });
});
