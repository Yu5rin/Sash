import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { pathOf } from '../src/model';
import { flushPendingEdits, mountInspector } from '../src/views/inspector';
import { mountTree } from '../src/views/tree';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g" label="G">
          <button id="b1" label="B1" />
          <gallery id="gal" label="Gal" />
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

beforeEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

function select(selector: string): Element {
  const store = app.store!;
  const el = store.doc.querySelector(selector)!;
  store.select(pathOf(el), 'canvas');
  return el;
}

const field = (attr: string) => insp.querySelector<HTMLInputElement>(`[data-attr="${attr}"]`)!;

describe('インスペクタ', () => {
  it('属性を日本語名と属性名で出し、真偽値は 既定 / はい / いいえ にする', () => {
    select('[id="b1"]');
    expect(insp.querySelector('.insp-label-ja')!.textContent).toBe('ID');
    const visible = insp.querySelector('[data-attr="visible"]')!;
    expect(Array.from(visible.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['既定（はい）', 'はい', 'いいえ']);
  });

  it('入力中（未確定）の値は、ほかからの変更で描き直しても残る', async () => {
    select('[id="b1"]');
    const label = field('label');
    label.focus();
    label.value = 'Typing';
    // ほかのビューでの変更（例：XML 側で別の属性を変える）
    app.store!.edit('xml', (doc) => {
      doc.querySelector('[id="b1"]')!.setAttribute('screentip', 'tip');
    }, 'test');
    await new Promise((r) => setTimeout(r, 5));
    expect(field('label').value).toBe('Typing');
    expect(document.activeElement).toBe(field('label'));
    expect(app.store!.doc.querySelector('[id="b1"]')!.getAttribute('label')).toBe('B1');
  });

  it('Enter で確定し、Esc で元の値に戻す', () => {
    select('[id="b1"]');
    const label = field('label');
    label.value = 'New';
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.store!.doc.querySelector('[id="b1"]')!.getAttribute('label')).toBe('New');
    const again = field('label');
    again.value = 'Other';
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(again.value).toBe('New');
  });

  it('日本語入力の変換中の Enter では確定しない', () => {
    select('[id="b1"]');
    const label = field('label');
    label.value = 'かな';
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(app.store!.doc.querySelector('[id="b1"]')!.getAttribute('label')).toBe('B1');
  });

  it('整数の欄は、整数でなければ確定せず理由を出す', () => {
    select('[id="gal"]');
    const cols = field('columns');
    cols.value = '1e';
    cols.dispatchEvent(new Event('change'));
    expect(app.store!.doc.querySelector('[id="gal"]')!.hasAttribute('columns')).toBe(false);
    expect(cols.getAttribute('aria-invalid')).toBe('true');
    expect(cols.parentElement!.querySelector('.field-error')!.textContent).not.toBe('');
  });

  it('id の重複は確定しない', () => {
    select('[id="b1"]');
    const id = field('id');
    id.value = 'gal';
    id.dispatchEvent(new Event('change'));
    expect(app.store!.doc.querySelector('[id="b1"]')).not.toBeNull();
  });

  it('アイコンの種類で「画像ファイル」を選んでも、値が決まるまで XML を変えない', () => {
    select('[id="b1"]');
    const mode = insp.querySelector<HTMLSelectElement>('[data-attr="icon-mode"]')!;
    const before = app.store!.text;
    mode.value = 'image';
    mode.dispatchEvent(new Event('change'));
    expect(app.store!.text).toBe(before);
    expect(insp.querySelector<HTMLSelectElement>('[data-attr="icon-mode"]')!.value).toBe('image');
    expect(document.querySelector('.modal')).toBeNull();
    // 組み込みアイコンを選んでも HappyFace を勝手に入れない
    const mode2 = insp.querySelector<HTMLSelectElement>('[data-attr="icon-mode"]')!;
    mode2.value = 'imageMso';
    mode2.dispatchEvent(new Event('change'));
    expect(app.store!.text).toBe(before);
  });

  it('固定 → VBA → 固定 で、入力していた値に戻る', () => {
    select('[id="b1"]');
    // 「固定 | VBA」は入力欄の右端の切り替えボタン 1 個（押すたびに固定と VBA が入れ替わる）
    const vbaButton = () => insp.querySelector<HTMLButtonElement>('[data-fkey="label:mode"]')!;
    const staticButton = vbaButton;
    expect(vbaButton().getAttribute('aria-pressed')).toBe('false');
    vbaButton().click();
    expect(vbaButton().getAttribute('aria-pressed')).toBe('true');
    const el = app.store!.doc.querySelector('[id="b1"]')!;
    expect(el.hasAttribute('label')).toBe(false);
    expect(el.getAttribute('getLabel')).toBeTruthy();
    staticButton().click();
    const el2 = app.store!.doc.querySelector('[id="b1"]')!;
    expect(el2.getAttribute('label')).toBe('B1');
    expect(el2.hasAttribute('getLabel')).toBe(false);
  });
});

describe('インスペクタ（確定と取り消し）', () => {
  it('入力したまま保存などに進むときは、flushPendingEdits で入力中の値を確定する', () => {
    select('[id="b1"]');
    const label = field('label');
    label.focus();
    label.value = 'Typed';
    flushPendingEdits();
    expect(app.store!.doc.querySelector('[id="b1"]')!.getAttribute('label')).toBe('Typed');
    expect(app.dirty).toBe(true);
  });

  it('フォーカスが欄にないとき・値が変わっていないときは何もしない', () => {
    select('[id="b1"]');
    const before = app.store!.text;
    flushPendingEdits();
    field('label').focus();
    flushPendingEdits();
    expect(app.store!.text).toBe(before);
    expect(app.store!.canUndo).toBe(false);
  });

  it('編集を断られたら（XML の構文エラー中）、欄を元の値に戻す', () => {
    select('[id="b1"]');
    // 構文エラーにする（インスペクタは最後に読めた文書を出したまま）
    app.store!.setText(app.store!.text.replace('</customUI>', '</customU'));
    expect(app.store!.syncError).not.toBeNull();
    const label = field('label');
    label.value = 'Refused';
    label.dispatchEvent(new Event('change'));
    expect(app.store!.doc.querySelector('[id="b1"]')!.getAttribute('label')).toBe('B1');
    expect(field('label').value).toBe('B1');
    expect(field('label').dataset['orig']).toBe('B1');
  });

  it('真偽値を矢印キーで選び直すと、選んだ項目にフォーカスが移る', async () => {
    select('[id="b1"]');
    const group = () => insp.querySelector<HTMLElement>('[data-attr="visible"]')!;
    const active = () => group().querySelector<HTMLButtonElement>('button.active')!;
    active().focus();
    active().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(app.store!.doc.querySelector('[id="b1"]')!.getAttribute('visible')).toBe('true');
    expect(active().textContent).toBe('はい');
    expect(document.activeElement).toBe(active());
  });
});

describe('ツリー', () => {
  it('畳んだ状態は id で覚え、前に要素を挿入しても同じ要素が畳まれたまま', () => {
    select('group');
    const row = () => tree.querySelector<HTMLElement>('.tree-row[data-fold="group#g"]')!;
    row().querySelector<HTMLElement>('.twisty')!.click();
    expect(row().getAttribute('aria-expanded')).toBe('false');
    // グループの前に別のグループを入れる（パスがずれる）
    app.store!.edit('other', (doc) => {
      const g = doc.createElementNS(NS, 'group');
      g.setAttribute('id', 'g0');
      g.setAttribute('label', 'G0');
      doc.querySelector('tab')!.insertBefore(g, doc.querySelector('group'));
    }, 'test');
    expect(row().getAttribute('aria-expanded')).toBe('false');
    expect(tree.querySelector('.tree-row[data-fold="group#g0"]')).not.toBeNull();
  });

  it('長いラベルは行の title に全文を持つ', () => {
    select('[id="b1"]');
    const r = tree.querySelector<HTMLElement>('.tree-row[data-fold="button#b1"]')!;
    expect(r.title).toContain('B1');
    expect(r.title).toContain('<button> b1');
  });
});
