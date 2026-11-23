import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { getPreviewState, mountCanvas, setFitMode, setPreviewScale, setPreviewWidth, toggleKeytips } from '../src/views/canvas';
import { setPreview } from '../src/views/ribbonPreview';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T" keytip="H">
        <group id="g" label="G">
          <button id="b1" label="B1" size="large" keytip="A" />
          <button id="b2" label="B2" keytip="a" />
          <button id="b3" label="B3" getVisible="vis" />
          <button id="b4" label="B4" getEnabled="en" />
          <button id="b5" getLabel="lbl" />
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

describe('キャンバスの幅のプレビュー', () => {
  it('タブの「＋」は横スクロールの欄の外に置く', () => {
    const add = host.querySelector('.rb-tab-add');
    expect(add).not.toBeNull();
    expect(add!.closest('.rb-tabs-scroll')).toBeNull();
    expect(host.querySelector('.rb-tabs-scroll .rb-tab')).not.toBeNull();
  });

  it('「自由」では枠を作らず、幅を選ぶと実効の幅の枠と目盛りを作る', () => {
    expect(host.querySelector('.cv-frame')).toBeNull();
    setPreviewWidth(1920);
    setPreviewScale(125);
    const frame = host.querySelector<HTMLElement>('.cv-frame');
    expect(frame?.style.width).toBe('1536px');
    expect(host.querySelector<HTMLElement>('.cv-zoom')?.dataset['eff']).toBe('1536');
    expect([...host.querySelectorAll('.cv-mark')].map((m) => m.textContent)).toEqual(['1280', '1366', '1536 (1920@125%)']);
    expect(getPreviewState()).toMatchObject({ width: 1920, scale: 125 });
    setFitMode('actual');
    expect(getPreviewState().fit).toBe('actual');
  });

  it('表示メニューの sash:preview を受けて切り替える', () => {
    window.dispatchEvent(new CustomEvent('sash:preview', { detail: { width: 1366, scale: 150, mode: 'actual', keytips: true } }));
    expect(getPreviewState()).toMatchObject({ width: 1366, scale: 150, fit: 'actual', keytips: true });
    expect(host.querySelector<HTMLElement>('.cv-frame')?.style.width).toBe('911px');
  });

  it('キーヒントを重ねて表示し、ないものは「自動」、重なりは赤にする', () => {
    expect(host.querySelector('.rb-keytip')).toBeNull();
    expect(toggleKeytips()).toBe(true);
    const tip = (id: string) => host.querySelector(`[data-path="${pathOfId(id)}"] > .rb-keytip`);
    expect(tip('b1')?.classList.contains('dup')).toBe(true);
    expect(tip('b2')?.classList.contains('dup')).toBe(true);
    // 書いていないものの「自動」は、［未設定も表示］のときだけ出す
    expect(tip('b3')).toBeNull();
    setPreview({ keytipsAll: true });
    setPreviewWidth(null);
    expect(tip('b3')?.classList.contains('auto')).toBe(true);
    // 自分のタブの H は、組み込みの［ホーム］の H と重なる
    expect(host.querySelector('.rb-tab.active .rb-keytip')?.classList.contains('dup')).toBe(true);
  });

  it('動的な状態を試す：隠す・無効にする・ラベルの例', () => {
    window.dispatchEvent(new CustomEvent('sash:dynamicSim', { detail: { path: pathOfId('b3').split('.').map(Number) } }));
    const rows = [...host.querySelectorAll<HTMLElement>('.cv-dyn-row')];
    expect(rows).toHaveLength(3);
    expect(host.querySelector('.cv-dyn-row.focus')?.textContent).toContain('B3');
    const change = (input: HTMLInputElement | null, apply: (i: HTMLInputElement) => void) => {
      apply(input!);
      input!.dispatchEvent(new Event('change'));
    };
    change(host.querySelector<HTMLInputElement>('.cv-dyn-row.focus input[type=checkbox]'), (i) => (i.checked = false));
    expect(host.querySelector(`[data-path="${pathOfId('b3')}"]`)).toBeNull();
    const enabledRow = [...host.querySelectorAll<HTMLElement>('.cv-dyn-row')].find((r) => r.textContent?.includes('B4'));
    change(enabledRow!.querySelector('input'), (i) => (i.checked = false));
    expect(host.querySelector(`[data-path="${pathOfId('b4')}"]`)?.classList.contains('disabled')).toBe(true);
    change(host.querySelector<HTMLInputElement>('.cv-dyn-label'), (i) => (i.value = '例のラベル'));
    expect(host.querySelector(`[data-path="${pathOfId('b5')}"]`)?.textContent).toContain('例のラベル');
    // 開き直すと試し表示は消える
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
    expect(host.querySelector(`[data-path="${pathOfId('b3')}"]`)).not.toBeNull();
  });

  it('2つの幅を比べる：比べる側は選べない・運べない', () => {
    setPreview({ compare: true, compareWidth: 1366 });
    setPreviewWidth(1920);
    const compare = host.querySelector<HTMLElement>('.cv-compare');
    expect(compare).not.toBeNull();
    expect(compare!.querySelector('[inert]')).not.toBeNull();
    expect(compare!.querySelector('[data-path], [data-sel], [draggable="true"]')).toBeNull();
    // 編集する側の要素は一つずつ
    expect(host.querySelectorAll(`[data-path="${pathOfId('b1')}"]`)).toHaveLength(1);
  });

  it('見出しは 1 行：比べる・キーヒント・VBA で変わる表示・チェックする幅・Excel の幅は「表示」メニューにまとめる', () => {
    setPreviewWidth(1920);
    const header = host.querySelector<HTMLElement>('.cv-header')!;
    expect(header.querySelector('.cv-bar, .cv-row')).toBeNull();
    expect(header.querySelector('[data-fk="compare"]')).toBeNull();
    expect(header.querySelector('.cv-status .cv-zoominfo')).not.toBeNull();
    header.querySelector<HTMLButtonElement>('[data-fk="menu-view"]')!.click();
    const pop = host.querySelector<HTMLElement>('.cv-viewpop')!;
    expect(pop).not.toBeNull();
    for (const fk of ['compare', 'keytips', 'keytipsAll', 'menu-dynamic', 'menu-checks', 'excelWidth']) expect(pop.querySelector(`[data-fk="${fk}"]`)).not.toBeNull();
    // キーヒントが切ってあるうちは「未設定も表示」は選べない
    expect(pop.querySelector<HTMLInputElement>('[data-fk="keytipsAll"]')!.disabled).toBe(true);
    // 「VBA で変わる表示を試す…」で、同じ場所に試すメニューを開く
    pop.querySelector<HTMLButtonElement>('[data-fk="menu-dynamic"]')!.click();
    expect(host.querySelector('.cv-viewpop')).toBeNull();
    expect(host.querySelectorAll('.cv-dyn-row').length).toBeGreaterThan(0);
  });

  it('自作のタブは書いた順に並べる（insertAfterMso などがないもの）', () => {
    const many = XML.replace('<tab id="t" label="T" keytip="H">', '<tab id="t0" label="T0"><group id="g0" label="G0" /></tab><tab id="t1" label="T1"><group id="g1" label="G1" /></tab><tab id="t" label="T" keytip="H">');
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: many, images: [] }] });
    const labels = [...host.querySelectorAll('.rb-tabs-scroll .rb-tab:not(.builtin):not(.file) .rb-label')].map((x) => x.textContent);
    expect(labels).toEqual(['T0', 'T1', 'T']);
  });

  it('ヒントの id は title に出さない（マウスを乗せたときのヒントと二重にしない）', () => {
    const b1 = host.querySelector<HTMLElement>(`[data-path="${pathOfId('b1')}"]`);
    expect(b1?.getAttribute('title')).toBeNull();
    expect(b1?.dataset['tip']).toBe('1');
  });
});

function pathOfId(id: string): string {
  const el = app.store!.doc.querySelector(`[id="${id}"]`)!;
  const path: number[] = [];
  for (let cur: Element = el; cur.parentElement; cur = cur.parentElement) path.unshift(Array.prototype.indexOf.call(cur.parentElement.children, cur));
  return path.join('.');
}
