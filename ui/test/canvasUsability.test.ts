// キャンバスの使い勝手（C-1 追加直後の名前入力、C-3 組み込みタブの「…」、C-5 選択の読み上げ、C-7 グループ名）。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { builtinGroupName, contextMenuTitle, describeSelection, KEY_HELP_LINES, mountCanvas, setCanvasGrowHandler, showBuiltinGroup, startRenameOf } from '../src/views/canvas';
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

  it('入力欄にフォーカスが移らないとき（畳んだ枠の中など）は始めなかったことにし、描き直しが止まったままにならない', () => {
    const spy = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => undefined);
    expect(startRenameOf(pathOf(el('b2')))).toBe(false);
    spy.mockRestore();
    expect(host.querySelector('input.cv-rename')).toBeNull();
    expect(host.textContent).toContain('出力');
    // 旗が残っていれば、次の編集が画面に出ない
    app.store!.edit('other', (doc) => doc.querySelector('[id="b3"]')!.setAttribute('label', '別名'), 'test');
    expect(host.textContent).toContain('別名');
    expect(startRenameOf(pathOf(el('b2')))).toBe(true);
    host.querySelector<HTMLInputElement>('input.cv-rename')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('入力中に文書が変わって入力欄のパスが別の要素を指すようになったら、確定せずに捨てて描き直す', () => {
    const b2 = el('b2');
    startRenameOf(pathOf(b2));
    const input = host.querySelector<HTMLInputElement>('input.cv-rename')!;
    input.value = '古いパスへ書く';
    app.store!.edit('xml', () => { b2.remove(); return undefined; }, 'test');
    expect(host.querySelector('input.cv-rename')).toBeNull();
    input.dispatchEvent(new FocusEvent('blur'));
    expect(el('b3').getAttribute('label')).toBe('閉じる');
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

describe('C-4 比べるモードの高さ', () => {
  it('比べる枠があれば高さを広げ、閉じたら元に戻す', () => {
    const calls: number[] = [];
    let released = 0;
    setCanvasGrowHandler((px) => {
      calls.push(px);
      return () => { released++; };
    });
    setPreview({ width: 1366, compare: true });
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
    expect(calls.length).toBe(1);
    setPreview({ compare: false });
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
    expect(released).toBe(1);
    setCanvasGrowHandler(null);
  });

  it('広げるのは足りない分だけ（比べる枠の全高ではなく、枠の下端までに要る高さ − いまのキャンバスの高さ）', () => {
    const calls: number[] = [];
    setCanvasGrowHandler((px) => {
      calls.push(px);
      return () => undefined;
    });
    // キャンバスの枠は 500px、比べる枠は上端 380・下端 600（全高 220）。足りないのは 600 + 12 − 500 = 112
    vi.spyOn(host, 'clientHeight', 'get').mockReturnValue(500);
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const orig = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('cv-compare')) return rect(380, 600);
      return this === host ? rect(0, 500) : orig.call(this);
    });
    setPreview({ width: 1366, compare: true });
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
    expect(calls).toEqual([112]);
    setPreview({ compare: false });
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
    // すでに十分な高さがあれば、広げない
    vi.spyOn(host, 'clientHeight', 'get').mockReturnValue(900);
    calls.length = 0;
    setPreview({ width: 1366, compare: true });
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
    expect(calls).toEqual([]);
    setPreview({ compare: false });
    setCanvasGrowHandler(null);
    vi.restoreAllMocks();
  });
});

describe('C-3 組み込みの名前', () => {
  it('よく使う右クリックメニューは「セル（ContextMenuCell）」の形で出し、知らない idMso はそのまま', () => {
    expect(contextMenuTitle('ContextMenuCell')).toBe('セル（ContextMenuCell）');
    expect(contextMenuTitle('ContextMenuListRange')).toBe('テーブル（ContextMenuListRange）');
    expect(contextMenuTitle('ContextMenuSomethingNew')).toBe('ContextMenuSomethingNew');
  });

  it('日本語の名前が分からない組み込みグループ（Activation など）は描かない。自分のグループがそこを指していれば描く', () => {
    expect(showBuiltinGroup('GroupActivation', false)).toBe(false);
    expect(showBuiltinGroup('GroupActivation', true)).toBe(true);
    expect(showBuiltinGroup('GroupClipboard', false)).toBe(true);
  });
});

describe('C-4・C-6 キー操作の案内', () => {
  it('「?」は button で、押すと案内が開き、Esc で閉じてフォーカスを戻す。案内に Esc（親を選ぶ）を含む', () => {
    const btn = host.querySelector<HTMLButtonElement>('button.cv-hint')!;
    const pop = host.querySelector<HTMLElement>('#cv-keyhelp')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('cv-keyhelp');
    expect(pop.hidden).toBe(true);
    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(pop.hidden).toBe(false);
    expect(pop.textContent).toContain('Esc：親を選ぶ');
    expect(KEY_HELP_LINES().some((l) => l.startsWith('Esc'))).toBe(true);
    btn.focus();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(pop.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
  });
});
