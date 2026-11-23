// キャンバスの使い勝手（C-1 追加直後の名前入力、C-3 組み込みタブの「…」、C-5 選択の読み上げ、C-7 グループ名）。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { builtinGroupName, describeSelection, mountCanvas, startRenameOf } from '../src/views/canvas';
import { elementAt, pathOf } from '../src/model';
import { setPreview } from '../src/views/ribbonPreview';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="集計">
        <group id="g" label="集計">
          <button id="b1" label="集計する" />
          <button id="b2" label="出力" />
          <button id="b3" label="閉じる" />
          <button id="b4" />
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

const el = (id: string) => app.store!.doc.querySelector(`[id="${id}"]`)!;

describe('C-5 選択の読み上げ文', () => {
  it('種類・名前・親・位置の順で作る', () => {
    expect(describeSelection(el('b1'))).toBe('ボタン 集計する、集計 グループ、4 個中 1 個目');
    expect(describeSelection(el('b3'))).toBe('ボタン 閉じる、集計 グループ、4 個中 3 個目');
  });

  it('ラベルがなければ id を名前に使う', () => {
    expect(describeSelection(el('b4'))).toContain('ボタン b4');
  });
});

describe('C-1 足した直後の名前入力', () => {
  it('startRenameOf でその場の入力欄が全選択で開き、Enter で確定する', () => {
    const b = el('b2');
    app.store!.select(pathOf(b), 'canvas');
    expect(startRenameOf(pathOf(b))).toBe(true);
    const input = host.querySelector<HTMLInputElement>('input.cv-rename')!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('出力');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
    input.value = '書き出し';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el('b2').getAttribute('label')).toBe('書き出し');
    expect(host.querySelector('input.cv-rename')).toBeNull();
  });

  it('Esc では既定名のまま（編集しない）', () => {
    const b = el('b2');
    startRenameOf(pathOf(b));
    const input = host.querySelector<HTMLInputElement>('input.cv-rename')!;
    input.value = '捨てる';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el('b2').getAttribute('label')).toBe('出力');
  });

  it('日本語入力の変換中の Enter では確定しない', () => {
    startRenameOf(pathOf(el('b2')));
    const input = host.querySelector<HTMLInputElement>('input.cv-rename')!;
    input.value = 'しゅつりょく';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(host.querySelector('input.cv-rename')).not.toBeNull();
    expect(el('b2').getAttribute('label')).toBe('出力');
    // 次のテストに入力中の状態を持ち越さない
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host.querySelector('input.cv-rename')).toBeNull();
  });

  it('［＋］でタブを足すと、足したタブの名前がその場で編集できる', () => {
    host.querySelector<HTMLElement>('.rb-tab-add')!.click();
    const input = host.querySelector<HTMLInputElement>('input.cv-rename')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    // 名前を打って Enter
    input.value = '新しいタブ名';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const added = Array.from(app.store!.doc.querySelectorAll('tab')).at(-1)!;
    expect(added.getAttribute('label')).toBe('新しいタブ名');
    expect(elementAt(app.store!.doc, pathOf(added))).toBe(added);
  });

  it('ラベルを持たない要素では何もしない', () => {
    expect(startRenameOf([])).toBe(false);
  });
});

describe('C-3 組み込みタブのまとめ', () => {
  it('まとめる印（data-fold）は、ホーム・自作タブ・表示中のタブには付かない', () => {
    const folds = Array.from(host.querySelectorAll<HTMLElement>('.rb-tab[data-fold]')).map((n) => n.dataset['idmso']);
    expect(folds).not.toContain('TabHome');
    expect(folds).toContain('TabInsert');
    expect(host.querySelector('.rb-tab.file')!.hasAttribute('data-fold')).toBe(false);
    expect(host.querySelector('.rb-tab[data-path]')!.hasAttribute('data-fold')).toBe(false);
  });

  it('「…」は普段は隠れている（jsdom は幅を測れないので、あふれない扱い）', () => {
    expect(host.querySelector<HTMLElement>('.rb-tab-more')!.hidden).toBe(true);
  });
});

describe('C-7 組み込みグループの日本語名', () => {
  it('よく使うグループは日本語で出し、知らない ID は接頭辞を外した名前にする', () => {
    expect(builtinGroupName('GroupClipboard')).toBe('クリップボード');
    expect(builtinGroupName('GroupFont')).toBe('フォント');
    expect(builtinGroupName('GroupSomethingNew')).toBe('SomethingNew');
  });
});
