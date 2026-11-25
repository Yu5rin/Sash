// 分割ボタンのラベル・アイコン（中のボタンに書く）と、アイコンの総点検で直したもののテスト（仕様書 §5.4・§6.3）。
// 分割ボタン自身には label / image / imageMso / getImage を付けられない（スキーマ違反になる）ので、
// どの入口から設定しても、書き込み先は中のボタンになることを確かめる。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { applyBulkAttr, commonAttrDefs, bulkValue } from '../src/bulkEdit';
import { attributes } from '../src/schema';
import { applyLibraryIcon, openIconDialog } from '../src/icon/iconDialog';
import { canSetIcon, delegatesToInner, iconTargetOf, iconTargetPath, innerButtonOf } from '../src/iconTarget';
import { lint } from '../src/lint';
import { displayName, elementAt, pathOf, parseXml } from '../src/model';
import { defFor } from '../src/schema';
import { mountCanvas, startRenameOf } from '../src/views/canvas';
import { renderBackstage } from '../src/views/backstage';
import { mountInspector } from '../src/views/inspector';
import { setPreview } from '../src/views/ribbonPreview';


const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g" label="G">
          <button id="b1" label="ふつう" imageMso="HappyFace" />
          <splitButton id="sp" size="large">
            <button id="spb" label="分割A" imageMso="Copy" onAction="cb" />
            <menu id="spm"><button id="spi" label="項目" imageMso="Paste" onAction="cb" /></menu>
          </splitButton>
          <splitButton id="spt">
            <toggleButton id="spg" label="分割トグル" onAction="cb" />
            <menu id="spm2"><button id="spi2" label="項目2" onAction="cb" /></menu>
          </splitButton>
          <splitButton id="sp0">
            <menu id="spm0"><button id="spi0" label="空" onAction="cb" /></menu>
          </splitButton>
          <dialogBoxLauncher><button id="dbl" onAction="cb" /></dialogBoxLauncher>
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

let insp: HTMLElement;
let canvas: HTMLElement;
const dropped: { path: number[]; target: number[] }[] = [];
const noop = () => undefined;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  insp = document.createElement('div');
  document.body.append(insp);
  mountInspector(insp, { pickIdMso: noop, pickImageMso: noop, editImage: noop, pickFromLibrary: noop });
  canvas = document.createElement('div');
  canvas.id = 'canvas';
  document.body.append(canvas);
  mountCanvas(canvas, { onImageDrop: (_files, path, target) => dropped.push({ path: [...path], target: [...target] }) });
});

beforeEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
  setPreview({ width: null, scale: 100, fit: 'fit', compare: false, keytips: false, keytipsAll: false });
  dropped.length = 0;
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

afterEach(() => localStorage.clear());

const el = (id: string) => app.store!.doc.querySelector(`[id="${id}"]`)!;
const select = (id: string): Element => {
  const e = el(id);
  app.store!.select(pathOf(e), 'canvas');
  return e;
};
const xml = () => new XMLSerializer().serializeToString(app.store!.doc);
const input = (attr: string) => insp.querySelector<HTMLInputElement>(`input[data-attr="${attr}"]`)!;
function type(attr: string, value: string): void {
  const i = input(attr);
  i.value = value;
  i.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('アイコンの書き込み先（iconTarget）', () => {
  it('分割ボタンは中の先頭の button / toggleButton に委ね、それ以外は自分自身', () => {
    expect(delegatesToInner(el('sp'))).toBe(true);
    expect(iconTargetOf(el('sp'))).toBe(el('spb'));
    expect(iconTargetOf(el('spt'))).toBe(el('spg'));
    expect(innerButtonOf(el('sp0'))).toBeNull();
    expect(iconTargetOf(el('sp0'))).toBeNull();
    expect(iconTargetOf(el('b1'))).toBe(el('b1'));
    expect(canSetIcon(el('sp'))).toBe(true);
    expect(canSetIcon(el('sp0'))).toBe(false);
    expect(canSetIcon(el('t'))).toBe(false);
  });

  it('dialogBoxLauncher は委ねない（Excel の画面にアイコンが出ないので、設定先にしない）', () => {
    const l = app.store!.doc.querySelector('dialogBoxLauncher')!;
    expect(delegatesToInner(l)).toBe(false);
    expect(canSetIcon(l)).toBe(false);
    expect(canSetIcon(el('dbl'))).toBe(true);
  });

  it('iconTargetPath：分割ボタンなら中のボタンの path、自分自身なら渡した path そのもの、付けられない要素は null', () => {
    const doc = app.store!.doc;
    expect(iconTargetPath(doc, pathOf(el('sp')))).toEqual(pathOf(el('spb')));
    const own = pathOf(el('b1'));
    expect(iconTargetPath(doc, own)).toBe(own);
    expect(iconTargetPath(doc, pathOf(el('sp0')))).toBeNull();
    expect(iconTargetPath(doc, pathOf(el('t')))).toBeNull();
  });
});

describe('分割ボタンのインスペクタ', () => {
  it('「ラベルとアイコン」の区画を先頭に出し、書き込み先（中のボタンの id）と移るリンクを示す', () => {
    select('sp');
    const sections = Array.from(insp.querySelectorAll<HTMLElement>('.insp-section')).map((s) => s.dataset['section']);
    expect(sections[0]).toBe('inner');
    const box = insp.querySelector<HTMLElement>('[data-section="inner"]')!;
    expect(box.querySelector('[data-inner-note]')!.textContent).toContain('中のボタン（spb）に設定されます');
    expect(box.querySelector('[data-attr="label"]')).not.toBeNull();
    expect(box.querySelector('[data-attr="icon-mode"]')).not.toBeNull();
    // 分割ボタン自身の区画には、ラベルとアイコンの行がない
    expect(insp.querySelectorAll('[data-attr="label"]').length).toBe(1);
    expect(insp.querySelectorAll('[data-attr="icon-mode"]').length).toBe(1);
  });

  it('ラベルを変えると中のボタンの label が変わり、分割ボタンには付かない。元に戻すは 1 回', () => {
    select('sp');
    const before = xml();
    type('label', '新しい名前');
    expect(el('spb').getAttribute('label')).toBe('新しい名前');
    expect(el('sp').hasAttribute('label')).toBe(false);
    expect(app.store!.selection).toEqual(pathOf(el('sp')));
    app.store!.undo();
    expect(xml()).toBe(before);
  });

  it('組み込みアイコン（imageMso）を変えると中のボタンに書き、分割ボタンには付かない。元に戻すは 1 回', () => {
    select('sp');
    const before = xml();
    type('imageMso', 'Cut');
    expect(el('spb').getAttribute('imageMso')).toBe('Cut');
    expect(el('sp').hasAttribute('imageMso')).toBe(false);
    expect(el('sp').hasAttribute('image')).toBe(false);
    app.store!.undo();
    expect(xml()).toBe(before);
  });

  it('アイコンの種類を VBA にすると、中のボタンに getImage が付き、元の imageMso が外れる（1 回の編集）', () => {
    select('sp');
    const before = xml();
    const sel = insp.querySelector<HTMLSelectElement>('select[data-attr="icon-mode"]')!;
    sel.value = 'getImage';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(el('spb').hasAttribute('getImage')).toBe(true);
    expect(el('spb').hasAttribute('imageMso')).toBe(false);
    expect(el('sp').hasAttribute('getImage')).toBe(false);
    app.store!.undo();
    expect(xml()).toBe(before);
  });

  it('getLabel への切り替えも中のボタンに書く', () => {
    select('sp');
    const btn = insp.querySelector<HTMLElement>('[data-section="inner"] [data-attr="label"]')!.closest('.insp-row')!.querySelector<HTMLButtonElement>('.insp-modebtn')!;
    btn.click();
    expect(el('spb').hasAttribute('getLabel')).toBe(true);
    expect(el('spb').hasAttribute('label')).toBe(false);
    expect(el('sp').hasAttribute('getLabel')).toBe(false);
    app.store!.undo();
    expect(el('spb').getAttribute('label')).toBe('分割A');
  });

  it('アイコンのない中のボタンに、種類を選んで組み込みアイコンを設定できる（種類の選択は描き直しても残る）', () => {
    select('spt');
    // 種類を選んだだけでは XML は変えない（既存の決まり）
    const sel = insp.querySelector<HTMLSelectElement>('select[data-attr="icon-mode"]')!;
    expect(sel.value).toBe('');
    sel.value = 'imageMso';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(el('spg').hasAttribute('imageMso')).toBe(false);
    // 種類の選択は描き直しても残る（書き込み先の鍵が中のボタンのもの）
    expect(insp.querySelector<HTMLSelectElement>('select[data-attr="icon-mode"]')!.value).toBe('imageMso');
    type('imageMso', 'Bold');
    expect(el('spg').getAttribute('imageMso')).toBe('Bold');
    expect(el('spt').hasAttribute('imageMso')).toBe(false);
  });

  it('分割ボタン自身の属性（大きさ）は分割ボタンに書く', () => {
    select('sp');
    const sel = insp.querySelector<HTMLSelectElement>('select[data-attr="size"]')!;
    sel.value = 'normal';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(el('sp').getAttribute('size')).toBe('normal');
    expect(el('spb').hasAttribute('size')).toBe(false);
  });

  it('「中のボタンを選ぶ」で中のボタンへ移る', () => {
    select('sp');
    insp.querySelector<HTMLButtonElement>('[data-fkey="inner:goto"]')!.click();
    expect(app.store!.selection).toEqual(pathOf(el('spb')));
  });

  it('中のボタンが無い（壊れた XML）ときは、その旨を表示し、入力欄は出さない', () => {
    select('sp0');
    const warn = insp.querySelector<HTMLElement>('[data-inner-missing]')!;
    expect(warn.textContent).toContain('button か toggleButton がありません');
    expect(insp.querySelector('[data-attr="label"]')).toBeNull();
    expect(insp.querySelector('[data-attr="icon-mode"]')).toBeNull();
  });

  it('分割ボタン以外（普通のボタン）は、これまでどおり自分自身に書く', () => {
    select('b1');
    expect(insp.querySelector('[data-section="inner"]')).toBeNull();
    type('label', '変更');
    expect(el('b1').getAttribute('label')).toBe('変更');
  });

  it('書いたあとの XML は、Lint のエラーにならない', () => {
    select('sp');
    type('label', 'X');
    type('imageMso', 'Cut');
    const problems = lint(app.store!.doc, { version: 'office2010', imageIds: new Set(), knownIdMso: new Set(), missingImageMso: new Set() });
    // 残るエラーは、わざと中を空にした sp0 の「button が必要」だけ（分割ボタン sp には出ない）
    expect(problems.filter((p) => p.severity === 'error').map((p) => p.path.join('.'))).toEqual([pathOf(el('sp0')).join('.')]);
  });
});

describe('ほかの入口', () => {
  it('ライブラリのアイコンを分割ボタンに設定すると、中のボタンに image が付く。選択は分割ボタンのまま、元に戻すは 1 回', () => {
    select('sp');
    const before = xml();
    applyLibraryIcon(pathOf(el('sp')), { id: 'x', name: 'star', tags: [], png: 'iVBORw0KGgo=', source: null, sourceName: null, sourceContentType: null, options: null });
    expect(el('spb').getAttribute('image')).toBe('img_star');
    expect(el('spb').hasAttribute('imageMso')).toBe(false);
    expect(el('sp').hasAttribute('image')).toBe(false);
    expect(app.store!.selection).toEqual(pathOf(el('sp')));
    expect(app.store!.images.has('img_star')).toBe(true);
    app.store!.undo();
    expect(xml()).toBe(before);
    expect(app.store!.images.has('img_star')).toBe(false);
  });

  it('アイコンエディタを分割ボタンの path で開くと、中のボタンが対象になる（見出しに中のボタンの id）', () => {
    openIconDialog(pathOf(el('sp')));
    const title = document.body.textContent ?? '';
    expect(title).toContain('アイコンを作る：spb');
    expect(title).not.toContain('アイコンを作る：sp ');
    document.querySelectorAll('dialog, .modal, .modal-backdrop').forEach((n) => n.remove());
  });

  it('画像ファイルを分割ボタンにドロップすると、中のボタンが設定先になる', () => {
    const node = canvas.querySelector<HTMLElement>(`[data-sel][data-path="${pathOf(el('sp')).join('.')}"]`)!;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [new File(['x'], 'a.png')], types: ['Files'] } });
    node.dispatchEvent(ev);
    // 選択に使う path はドロップされた分割ボタン、書き込み先は中のボタン（main.ts は選択を分割ボタンのままにする）
    expect(dropped).toEqual([{ path: pathOf(el('sp')), target: pathOf(el('spb')) }]);
  });

  it('アイコンを付けられない要素（中が空の分割ボタン）への画像のドロップは受けない', () => {
    const node = canvas.querySelector<HTMLElement>(`[data-sel][data-path="${pathOf(el('sp0')).join('.')}"]`)!;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [new File(['x'], 'a.png')], types: ['Files'] } });
    node.dispatchEvent(ev);
    expect(dropped).toEqual([]);
  });
});

describe('見直しでの修正', () => {
  const insertSplitBefore = (id: string) =>
    app.store!.edit('other', (doc) => {
      const sp = doc.querySelector(`[id="${id}"]`)!;
      const add = doc.createElementNS(NS, 'splitButton');
      add.setAttribute('id', 'spNew');
      const b = doc.createElementNS(NS, 'button');
      b.setAttribute('id', 'spNewB');
      b.setAttribute('label', '差し込んだ');
      add.append(b);
      const m = doc.createElementNS(NS, 'menu');
      m.setAttribute('id', 'spNewM');
      add.append(m);
      sp.parentElement!.insertBefore(add, sp);
      return undefined;
    });

  it('1. 入力中に構造が変わっても、選んでいた分割ボタンの中のボタンに書く（別の要素に書かない）', () => {
    select('sp');
    const i = input('label');
    insertSplitBefore('sp');
    i.value = '入力した名前';
    i.dispatchEvent(new Event('change', { bubbles: true }));
    expect(el('spb').getAttribute('label')).toBe('入力した名前');
    expect(el('spNewB').getAttribute('label')).toBe('差し込んだ');
  });

  it('1. 書き込み先が文書から外れていたら、何も書かない（履歴も増やさない）', () => {
    select('sp');
    const i = input('label');
    const spb = el('spb');
    app.store!.edit('other', () => {
      spb.remove();
      return undefined;
    });
    const before = xml();
    i.value = '外れた後';
    i.dispatchEvent(new Event('change', { bubbles: true }));
    expect(xml()).toBe(before);
    expect(spb.getAttribute('label')).toBe('分割A');
  });

  it('1. アイコンの設定（種類 VBA）も、構造が変わったあとで正しい中のボタンに書く', () => {
    select('sp');
    const sel = insp.querySelector<HTMLSelectElement>('select[data-attr="icon-mode"]')!;
    insertSplitBefore('sp');
    sel.value = 'getImage';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(el('spb').hasAttribute('getImage')).toBe(true);
    expect(el('spNewB').hasAttribute('getImage')).toBe(false);
  });

  it('3. ID の提案は、分割ボタンでは中のボタンのラベルから作る', () => {
    select('sp');
    insp.querySelector<HTMLButtonElement>('[data-fkey="id:suggest"]')!.click();
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((n) => n.textContent ?? '');
    expect(items.some((x) => x.includes('ラベルから'))).toBe(true);
    document.querySelectorAll('[role="menu"]').forEach((n) => n.remove());
  });

  it('4. リボンのメニューのポップアップは、アイコンとラベルの間をあける', async () => {
    // vitest は CSS を空にするので、ファイルを直接読む（node の型は tsconfig に含めていない）
    // @ts-expect-error node:fs の型がない
    const { readFileSync } = (await import('node:fs')) as { readFileSync: (p: string, enc: string) => string };
    const stylesViews = readFileSync('src/styles-views.css', 'utf8');
    expect(stylesViews).toMatch(/\.rb-menu-item \{[^}]*gap: 6px/);
  });

  it('5. 分割ボタンの行は中の先頭のボタンを兼ね、その子の行を並べない（ポップアップ）', () => {
    select('sp');
    const rows = Array.from(canvas.querySelectorAll<HTMLElement>('.rb-menu-popup .rb-menu-item')).map((r) => r.dataset['path']);
    expect(rows).not.toContain(pathOf(el('spb')).join('.'));
    expect(rows).toContain(pathOf(el('spm')).join('.'));
  });

  it('5. 右クリックメニューでも、分割ボタンの行は 1 つ', () => {
    const d = `<customUI xmlns="${NS}"><contextMenus><contextMenu idMso="ContextMenuCell"><splitButton id="cs"><button id="csb" label="右の分割" onAction="cb"/><menu id="csm"><button id="csi" label="q" onAction="cb"/></menu></splitButton></contextMenu></contextMenus></customUI>`;
    app.open({ path: 'x.xlam', parts: [{ version: 'office2010', xml: d, images: [] }] });
    app.store!.select(pathOf(el('cs')), 'canvas');
    const labels = Array.from(canvas.querySelectorAll<HTMLElement>('.rb-menu-item .rb-label')).map((n) => n.textContent);
    expect(labels.filter((x) => x === '右の分割')).toHaveLength(1);
  });

  it('6. アイコンを付けられない要素（中が空の分割ボタン・tab）には、エディタを開かず・ライブラリからも付けない', () => {
    const closed: boolean[] = [];
    const before = xml();
    openIconDialog(pathOf(el('sp0')), undefined, undefined, { onClose: (a) => closed.push(a) });
    openIconDialog(pathOf(el('t')), undefined, undefined, { onClose: (a) => closed.push(a) });
    expect(closed).toEqual([false, false]);
    const detail = { id: 'x', name: 'star', tags: [], png: 'iVBORw0KGgo=', source: null, sourceName: null, sourceContentType: null, options: null };
    applyLibraryIcon(pathOf(el('sp0')), detail);
    applyLibraryIcon(pathOf(el('t')), detail);
    expect(xml()).toBe(before);
    expect(app.store!.images.size).toBe(0);
  });

  it('8. 分割ボタンのアイコンを出すかは、中のボタンの showImage で決まる', () => {
    app.store!.edit('other', () => {
      el('spb').setAttribute('showImage', 'false');
      return undefined;
    });
    const node = canvas.querySelector<HTMLElement>(`[data-sel][data-path="${pathOf(el('sp')).join('.')}"]`)!;
    expect(node.querySelector('.rb-split-main .rb-icon')).toBeNull();
  });

  it('8. キャンバスでの名前の直接編集（F2）が、分割ボタンでは中のボタンの label に対して働く。元に戻すは 1 回', () => {
    const before = xml();
    expect(startRenameOf(pathOf(el('sp')))).toBe(true);
    const box = canvas.querySelector<HTMLInputElement>('input.cv-rename')!;
    expect(box.value).toBe('分割A');
    box.value = '直接編集';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(el('spb').getAttribute('label')).toBe('直接編集');
    expect(el('sp').hasAttribute('label')).toBe(false);
    app.store!.undo();
    expect(xml()).toBe(before);
  });

  it('8. 分割ボタンの区画に、中のボタンのヒント（screentip / supertip）の行も出す', () => {
    select('sp');
    const box = insp.querySelector<HTMLElement>('[data-section="inner"]')!;
    expect(box.querySelector('[data-attr="screentip"]')).not.toBeNull();
    expect(box.querySelector('[data-attr="supertip"]')).not.toBeNull();
    expect(insp.querySelectorAll('[data-attr="screentip"]').length).toBe(1);
    type('screentip', 'ヒント');
    expect(el('spb').getAttribute('screentip')).toBe('ヒント');
    expect(el('sp').hasAttribute('screentip')).toBe(false);
  });

  it('8. 中のボタンについての Lint の指摘も、分割ボタンのインスペクタに出す', () => {
    app.store!.edit('other', () => {
      el('spb').setAttribute('image', 'missing');
      return undefined;
    });
    app.runLint();
    select('sp');
    const list = insp.querySelector('[data-inner-problems]')!;
    expect(list.textContent).toContain('missing');
    // 分割ボタン自身の指摘は、これまでの場所（先頭の一覧）に出る。ここに重ねて出さない
    expect(insp.querySelectorAll('[data-inner-problems]').length).toBe(1);
  });
});

describe('複数選択のまとめて変更', () => {
  it('分割ボタンとボタンを選ぶと label・imageMso が共通になり、分割ボタンには中のボタンに入る。元に戻すは 1 回', () => {
    const els = [el('sp'), el('b1')];
    const names = commonAttrDefs(els).map((d) => d.name);
    expect(names).toContain('label');
    expect(names).toContain('imageMso');
    expect(bulkValue(els, attributes.get('label')!)).toEqual({ mixed: true, values: ['分割A', 'ふつう'] });

    app.store!.select(pathOf(el('sp')), 'canvas');
    app.store!.toggleSelect(pathOf(el('b1')), 'canvas');
    const before = xml();
    const d = attributes.get('imageMso')!;
    expect(app.store!.edit('inspector', (doc) => {
      const targets = [elementAt(doc, pathOf(el('sp')))!, elementAt(doc, pathOf(el('b1')))!];
      expect(applyBulkAttr(targets, d, 'Cut')).toBe(2);
      return undefined;
    })).toBe(true);
    expect(el('spb').getAttribute('imageMso')).toBe('Cut');
    expect(el('b1').getAttribute('imageMso')).toBe('Cut');
    expect(el('sp').hasAttribute('imageMso')).toBe(false);
    app.store!.undo();
    expect(xml()).toBe(before);
  });

  it('中が空の分割ボタンが混ざると、label・imageMso は共通にならない', () => {
    expect(commonAttrDefs([el('sp0'), el('b1')]).map((d) => d.name)).not.toContain('label');
  });
});

describe('表示名とキャンバス', () => {
  it('分割ボタンの表示名（ツリー）は、ラベルを持つ中のボタンのラベル。中が空なら id', () => {
    expect(displayName(el('sp'))).toBe('分割A');
    expect(displayName(el('sp0'))).toBe('sp0');
  });

  it('分割ボタンは 1 つのコントロールとして、中のボタンのアイコンとラベルで描く', () => {
    const node = canvas.querySelector<HTMLElement>(`[data-sel][data-path="${pathOf(el('sp')).join('.')}"]`)!;
    expect(node.querySelector('.rb-split-main .rb-icon')).not.toBeNull();
    expect(node.querySelector('.rb-label')!.textContent).toBe('分割A');
  });

  it('メニューのポップアップに、項目のアイコンを描く（アイコンのない項目は同じ幅の空き）', () => {
    app.store!.select(pathOf(el('spm')), 'canvas');
    const popup = canvas.querySelector<HTMLElement>('.rb-menu-popup')!;
    const rows = Array.from(popup.querySelectorAll<HTMLElement>('.rb-menu-item'));
    const spi = rows.find((r) => r.dataset['path'] === pathOf(el('spi')).join('.'))!;
    expect(spi.querySelector('.rb-icon')).not.toBeNull();
    // アイコンのない項目（メニュー spm の行）は、同じ幅の空きを置く
    expect(rows.find((r) => r.dataset['path'] === pathOf(el('spm')).join('.'))!.querySelector('.rb-icon-gap')).not.toBeNull();
  });
});

describe('アイコンの総点検（スキーマ）', () => {
  const parse = (body: string) => {
    const r = parseXml(`<customUI xmlns="${NS}">${body}</customUI>`);
    if (!r.ok) throw new Error(r.message);
    return r.doc;
  };
  const errors = (d: Document) => lint(d, { version: 'office2010', imageIds: new Set(['img1']), knownIdMso: new Set(), missingImageMso: new Set() }).filter((p) => p.severity === 'error').map((p) => p.message);

  it('splitButton は XSD どおり label・ヒント・アイコン系を持てず、size・showLabel などを持つ', () => {
    const names = new Set(defFor(el('sp'))!.attrs);
    for (const n of ['label', 'getLabel', 'screentip', 'supertip', 'image', 'imageMso', 'getImage', 'showImage', 'getShowImage']) expect(names.has(n), n).toBe(false);
    for (const n of ['size', 'getSize', 'showLabel', 'getShowLabel', 'visible', 'enabled', 'keytip']) expect(names.has(n), n).toBe(true);
  });

  it('分割ボタンに label / imageMso を書いた XML は、中のボタンに付けるよう案内するエラーにする', () => {
    const d = parse('<ribbon><tabs><tab id="t" label="T"><group id="g" label="G"><splitButton id="s" label="X" imageMso="Copy"><button id="b" label="B" onAction="cb"/><menu id="m"><button id="i" label="I" onAction="cb"/></menu></splitButton></group></tab></tabs></ribbon>');
    const msgs = errors(d);
    expect(msgs).toHaveLength(2);
    for (const m of msgs) expect(m).toContain('中の button / toggleButton に付けます');
  });

  it('Backstage の dropDown・comboBox の item と radioButton は CT_BackstageItem（image・imageMso を持てず、getLabel は持つ）', () => {
    const d = parse('<backstage><tab id="t" label="T"><firstColumn><group id="g" label="G"><topItems>'
      + '<dropDown id="d" label="D" onAction="cb"><item id="i1" label="a" imageMso="Copy"/></dropDown>'
      + '<radioGroup id="r" label="R" onAction="cb"><radioButton id="rb" getLabel="gl"/></radioGroup>'
      + '</topItems></group></firstColumn></tab></backstage>');
    const msgs = errors(d);
    // 以前の版で作ったファイルの直し方を添える
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('<item> に imageMso 属性は使えません');
    expect(msgs[0]).toContain('Backstage の項目はアイコンを持てません。XML エディタで image / imageMso を消してください');
  });

  it('リボンの item（CT_Item）は image・imageMso を持てる', () => {
    const d = parse('<ribbon><tabs><tab id="t" label="T"><group id="g" label="G"><dropDown id="d" label="D" onAction="cb"><item id="i1" label="a" imageMso="Copy"/><item id="i2" label="b" image="img1"/></dropDown></group></tab></tabs></ribbon>');
    expect(errors(d)).toEqual([]);
  });
});

describe('アイコンの総点検（描画）', () => {
  it('editBox・comboBox・dropDown の getImage も、キャンバスに印を出す', () => {
    const d = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G"><editBox id="e" label="E" getImage="gi" onChange="cb"/></group></tab></tabs></ribbon></customUI>`;
    app.open({ path: 'x.xlam', parts: [{ version: 'office2010', xml: d, images: [] }] });
    const node = canvas.querySelector<HTMLElement>(`[data-sel][data-path="${pathOf(el('e')).join('.')}"]`)!;
    expect(node.querySelector('.rb-icon.dynamic')).not.toBeNull();
  });

  it('Backstage：getImage のボタンは動的の印、hyperlink もアイコンを描く', () => {
    const d = `<customUI xmlns="${NS}"><backstage><tab id="t" label="T"><firstColumn><group id="g" label="G"><topItems>
      <button id="b" label="B" getImage="gi" onAction="cb"/>
      <hyperlink id="h" label="H" imageMso="Copy" target="https://example.com"/>
    </topItems></group></firstColumn></tab></backstage></customUI>`;
    app.open({ path: 'x.xlam', parts: [{ version: 'office2010', xml: d, images: [] }] });
    const view = renderBackstage(app.store!.doc, new Set());
    expect(view.querySelector('.bs-button .rb-icon.dynamic')).not.toBeNull();
    expect(view.querySelector('.bs-link .rb-icon')).not.toBeNull();
  });
});
