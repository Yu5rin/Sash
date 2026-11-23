// インスペクタの使い勝手（I-1 切り替えボタンと並び順、I-2 ID の提案、I-3 アイコンの見本、I-4 既定の表記）。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { pathOf, suggestIdFromLabel } from '../src/model';
import { enumUnsetText, idSuggestions, mountInspector, SECTIONS } from '../src/views/inspector';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g" label="G">
          <button id="b1" label="出荷一覧を作る" imageMso="HappyFace" />
          <button id="b2" label="Export CSV" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

let insp: HTMLElement;
const noop = () => undefined;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  insp = document.createElement('div');
  document.body.append(insp);
  mountInspector(insp, { pickIdMso: noop, pickImageMso: noop, editImage: noop, pickFromLibrary: noop });
});

beforeEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

function select(id: string): Element {
  const el = app.store!.doc.querySelector(`[id="${id}"]`)!;
  app.store!.select(pathOf(el), 'canvas');
  return el;
}

describe('I-1 切り替えボタンと並び順', () => {
  it('「画像」「コールバック」は「基本」の直後に並ぶ', () => {
    expect(SECTIONS.slice(0, 3)).toEqual(['基本', '画像', 'コールバック']);
    select('b1');
    const order = Array.from(insp.querySelectorAll<HTMLElement>('.insp-section')).map((s) => s.dataset['section']);
    expect(order.indexOf('画像')).toBe(order.indexOf('基本') + 1);
  });

  it('固定 / VBA の切り替えは、ラベルの下ではなく入力欄と同じ行の 1 個のボタン', () => {
    select('b1');
    const row = insp.querySelector<HTMLElement>('[data-attr="label"]')!.closest<HTMLElement>('.insp-row')!;
    const btn = row.querySelector<HTMLButtonElement>('.insp-modebtn')!;
    expect(btn.parentElement).toBe(row.querySelector('.insp-value'));
    expect(btn.textContent).toBe('VBA');
    expect(row.querySelector('.insp-label-cell')).toBeNull();
    expect(row.querySelectorAll('.segmented.insp-mode').length).toBe(0);
  });

  it('VBA にして固定へ戻すと、前の固定の値に戻る（切り替えのたびに同じボタンにフォーカスが残る）', async () => {
    select('b2');
    const btn = () => insp.querySelector<HTMLButtonElement>('[data-fkey="label:mode"]')!;
    btn().focus();
    btn().click();
    await new Promise((r) => setTimeout(r, 5));
    expect(app.store!.doc.querySelector('[id="b2"]')!.hasAttribute('label')).toBe(false);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(btn());
    btn().click();
    await new Promise((r) => setTimeout(r, 5));
    expect(app.store!.doc.querySelector('[id="b2"]')!.getAttribute('label')).toBe('Export CSV');
  });
});

describe('I-2 ID の提案', () => {
  it('日本語のラベルからは、ラベルそのまま（Unicode の id）と連番の 2 択', () => {
    const s = idSuggestions('button', '出荷一覧を作る', new Set());
    expect(s).toEqual([{ id: 'btn出荷一覧を作る', kind: 'label' }, { id: 'btn1', kind: 'seq' }]);
  });

  it('英字のラベルは単語をつなげたものと連番', () => {
    expect(idSuggestions('button', 'Export CSV', new Set())).toEqual([{ id: 'btnExportCsv', kind: 'label' }, { id: 'btn1', kind: 'seq' }]);
  });

  it('ラベルが空なら連番だけ。使われている id は避ける', () => {
    expect(idSuggestions('button', '', new Set(['btn1']))).toEqual([{ id: 'btn2', kind: 'seq' }]);
    expect(idSuggestions('button', '出荷', new Set(['btn出荷']))[0]).toEqual({ id: 'btn出荷2', kind: 'label' });
  });

  it('記号だけのラベルは ID にできないので連番だけ', () => {
    expect(suggestIdFromLabel('button', '★ ！', new Set())).toBeNull();
    expect(idSuggestions('button', '★ ！', new Set())).toEqual([{ id: 'btn1', kind: 'seq' }]);
  });

  it('空白・記号は落とす。数字で始まる本体でも接頭辞が付くので id になる', () => {
    expect(suggestIdFromLabel('group', '2024年 集計（月次）', new Set())).toBe('grp2024年集計月次');
  });

  it('「提案」を押すと、2 択の小メニューが開き、選ぶと id が入る', () => {
    select('b1');
    insp.querySelector<HTMLButtonElement>('[data-attr="id"]')!.closest('.insp-inline')!.querySelector<HTMLButtonElement>('button')!.click();
    const items = Array.from(document.querySelectorAll<HTMLElement>('.ctx-menu .ctx-item'));
    expect(items.map((i) => i.textContent)).toEqual(['btn出荷一覧を作る（ラベルから）', 'btn1（連番）']);
    items[0]!.click();
    expect(app.store!.doc.querySelector('[id="btn出荷一覧を作る"]')).not.toBeNull();
  });
});

describe('I-3 アイコンの見本', () => {
  it('組み込みアイコンの欄に 24px の見本の枠と、読み上げ用の名前がある', () => {
    select('b1');
    const input = insp.querySelector<HTMLInputElement>('[data-attr="imageMso"]')!;
    expect(input.getAttribute('aria-label')).toBe('imageMso の名前');
    const preview = input.closest('.insp-inline')!.querySelector<HTMLElement>('.insp-icon-preview')!;
    expect(preview).not.toBeNull();
    expect(insp.querySelector('[data-attr="icon-mode"]')!.getAttribute('aria-label')).toBe('アイコンの種類');
  });
});

describe('I-4 列挙値の既定', () => {
  it('既定値が分かる属性は「既定（normal）」、分からない属性は「未指定」', () => {
    expect(enumUnsetText('size')).toBe('既定（normal）');
    expect(enumUnsetText('boxStyle')).toBe('既定（horizontal）');
    expect(enumUnsetText('align')).toBe('未指定');
  });

  it('インスペクタの size の選択肢にも出る', () => {
    select('b2');
    const sel = insp.querySelector<HTMLSelectElement>('[data-attr="size"]')!;
    expect(sel.options[0]!.textContent).toBe('既定（normal）');
  });
});
