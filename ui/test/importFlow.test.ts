import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 別のブックのリボンを取り込む・見比べる・XML を書き出す（仕様書 §23.3）。ホストとの通信は差し替える

const invoke = vi.fn();
vi.mock('../src/bridge', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
// Monaco の差分エディタは jsdom では動かないので、渡された内容だけを確かめる
const openDiffViews = vi.fn();
vi.mock('../src/dialogs/diffDialog', () => ({ openDiffViews: (...a: unknown[]) => openDiffViews(...a), openDiff: vi.fn() }));

const { app } = await import('../src/app');
const flow = await import('../src/importFlow');
const { openImportDialog } = await import('../src/dialogs/importDialog');
const { vba } = await import('../src/callbacks');
const { exportSash } = await import('../src/sashJson');
const { PartStore } = await import('../src/store');
const { clearToasts } = await import('../src/shell/toast');

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const MINE = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="tabMine" label="自分"><group id="grpSum" label="既存"><button id="btnSum" label="既存"/></group></tab></tabs></ribbon></customUI>`;
const OTHER = `<customUI xmlns="${NS}">
  <ribbon><tabs><tab id="tabA" label="経理"><group id="grpSum" label="月次"><button id="btnSum" label="集計" image="logo" onAction="Ribbon_btnSum_onAction"/></group></tab></tabs></ribbon>
</customUI>`;
const IMG = { id: 'logo', contentType: 'image/png', base64: 'AAAA' };

function openMine(): void {
  app.open({ path: 'C:\\mine.xlsm', parts: [{ version: 'office2010', xml: MINE, images: [] }] } as never);
  vba.status = 'notOpen';
  vba.modules = null;
}

beforeEach(() => {
  invoke.mockReset();
  openDiffViews.mockReset();
  openMine();
});
afterEach(() => {
  // ダイアログは、登録（レイヤー）ごと閉じてから DOM を片づける（残すと、次のテストで同じダイアログを開けない）
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('.modal-close'))) b.click();
  clearToasts();
  document.body.replaceChildren();
});

describe('sourceFromRead', () => {
  it('ブックと XML は、そのまま取り込み・比較の元になる', () => {
    const book = flow.sourceFromRead({ path: 'C:\\old\\前任者.xlam', kind: 'workbook', parts: [{ version: 'office2010', xml: OTHER, images: [IMG] }] });
    expect(book.name).toBe('前任者.xlam');
    expect(book.parts[0]).toMatchObject({ version: 'office2010', xml: OTHER, images: [IMG] });
  });

  it('.sash.json は解析して同じ形にする。形式が違えば理由つきで例外', () => {
    const store = new PartStore('office2010', OTHER, [{ id: 'logo', dataUrl: 'data:image/png;base64,AAAA', isNew: false }]);
    const book = flow.sourceFromRead({ path: 'C:\\x\\a.sash.json', kind: 'sashJson', parts: [], json: exportSash([store], 'a.xlam') });
    expect(book.parts[0]!.xml.trim()).toBe(OTHER.trim());
    expect(book.parts[0]!.images).toEqual([IMG]);
    expect(() => flow.sourceFromRead({ path: 'x.json', kind: 'sashJson', parts: [], json: '{"a":1}' })).toThrow();
  });
});

describe('readSourceBook', () => {
  it('選ばなければ null、リボン定義がなければ知らせて null、読めなければ知らせて null', async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await flow.readSourceBook()).toBeNull();
    invoke.mockResolvedValueOnce({ path: 'C:\\x.xlsm', kind: 'workbook', parts: [] });
    expect(await flow.readSourceBook()).toBeNull();
    expect(document.querySelector('.toast.warning')?.textContent).toContain('リボン定義');
    invoke.mockRejectedValueOnce(new Error('壊れています'));
    expect(await flow.readSourceBook()).toBeNull();
    expect(document.querySelector('.toast.error')?.textContent).toContain('壊れています');
  });
});

describe('比べる', () => {
  it('formatXmlText：書き方の違い（字下げ・改行）を整形でそろえる。読めなければそのまま', () => {
    expect(flow.formatXmlText(`<customUI xmlns="${NS}"><ribbon/></customUI>`)).toBe(flow.formatXmlText(`<customUI xmlns="${NS}">\n\n   <ribbon/>\n</customUI>`));
    expect(flow.formatXmlText('<customUI')).toBe('<customUI');
  });

  it('buildCompareViews：左が別のブック、右が今の編集。画像は中身で比べる', () => {
    const book = flow.sourceFromRead({ path: 'C:\\o.xlam', kind: 'workbook', parts: [{ version: 'office2010', xml: OTHER, images: [IMG, { id: 'only', contentType: 'image/png', base64: 'ZZZZ' }] }] });
    const views = flow.buildCompareViews(book, [{ version: 'office2010', text: MINE, images: new Map([['renamedLogo', 'data:image/png;base64,AAAA'], ['mine', 'data:image/png;base64,MMMM']]) }]);
    expect(views).toHaveLength(1);
    expect(views[0]!.left).toContain('経理');
    expect(views[0]!.right).toContain('自分');
    // logo は id が違っても中身が同じなので差ではない
    expect(views[0]!.addedImages).toEqual(['mine']);
    expect(views[0]!.removedImages).toEqual(['only']);
  });

  it('片方にしかないパーツも組にする（なければ空の XML と比べる）', () => {
    const book = flow.sourceFromRead({ path: 'C:\\o.xlam', kind: 'workbook', parts: [{ version: 'office2007', xml: OTHER.replace(NS, 'http://schemas.microsoft.com/office/2006/01/customui'), images: [] }] });
    const views = flow.buildCompareViews(book, [{ version: 'office2010', text: MINE, images: new Map() }]);
    expect(views.map((v) => [v.version, v.left === '', v.right === ''])).toEqual([['office2007', false, true], ['office2010', true, false]]);
  });

  it('compareWithOtherBook：選んだブックを左にして差分ダイアログへ渡す', async () => {
    invoke.mockResolvedValueOnce({ path: 'C:\\o.xlam', kind: 'workbook', parts: [{ version: 'office2010', xml: OTHER, images: [] }] });
    await flow.compareWithOtherBook();
    const opts = openDiffViews.mock.calls[0]![0] as { title: string; views: { left: string }[]; legend: string };
    expect(opts.title).toContain('o.xlam');
    expect(opts.legend).toContain('o.xlam');
    expect(opts.views[0]!.left).toContain('経理');
  });
});

describe('customUI の XML を書き出す', () => {
  it('いま編集しているパーツの XML を、パーツ名つきの名前で書き出す（画像は含まれないと知らせる）', async () => {
    invoke.mockResolvedValueOnce('C:\\out\\mine_customUI14.xml');
    await flow.exportCustomUiXml();
    const call = invoke.mock.calls[0]!;
    expect(call[0]).toBe('file.exportText');
    expect(call[1]).toMatchObject({ defaultName: 'mine_customUI14.xml', content: MINE });
    expect(document.querySelector('.toast.success')?.textContent).toContain('画像は含まれません');
  });
});

describe('取り込みダイアログ', () => {
  const book = () => flow.sourceFromRead({ path: 'C:\\old\\前任者.xlam', kind: 'workbook', parts: [{ version: 'office2010', xml: OTHER, images: [IMG] }] });
  const byText = (sel: string, text: string) => Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.textContent?.includes(text))!;

  it('最初のタブが選ばれていて、id の重なりと画像・VBA が運ばれないことを見せる', () => {
    openImportDialog(book());
    expect(document.querySelector('.modal')).not.toBeNull();
    const checked = Array.from(document.querySelectorAll<HTMLInputElement>('.import-tree input')).map((i) => i.checked);
    // タブ（選択）と、その中のグループ（タブごと入るので選択済み・押せない）
    expect(checked).toEqual([true, true]);
    expect((document.querySelectorAll<HTMLInputElement>('.import-tree input')[1])!.disabled).toBe(true);
    const side = document.querySelector('.import-side')!.textContent!;
    expect(side).toContain('id が重なる 2 件を振り直します');
    expect(side).toContain('画像 1 個');
    expect(side).toContain('VBA は運ばれません');
    expect(document.querySelector('.import-xml')!.textContent).toContain('id="tabA"');
  });

  it('［取り込む］で文書に入り、結果の画面で要る Sub を案内する', async () => {
    openImportDialog(book());
    (byText('.modal footer button', '取り込む') as HTMLButtonElement).click();
    expect(app.store!.text).toContain('id="tabA"');
    expect(app.store!.text).toContain('id="btnSum2"');
    expect(app.store!.images.has('logo')).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('.import-callbacks')).not.toBeNull());
    expect(document.querySelector('.import-callbacks')!.textContent).toContain('Ribbon_btnSum_onAction');
    expect(document.querySelector('.import-callbacks')!.textContent).toContain('VBA は運ばれません');
    // VBA を読めていない（Excel で開いていない）ので、挿入は出さず、コピーだけ
    expect(byText('.import-cb-actions button', 'Sub の一覧をコピー')).toBeTruthy();
    expect(document.querySelector('.import-cb-actions .primary')).toBeNull();
    expect(Array.from(document.querySelectorAll('.modal footer button')).map((b) => b.textContent)).toEqual(['閉じる']);
  });

  it('何も選ばなければ［取り込む］は押せない', () => {
    openImportDialog(book());
    const first = document.querySelector<HTMLInputElement>('.import-tree input')!;
    first.checked = false;
    first.dispatchEvent(new Event('change'));
    expect((byText('.modal footer button', '取り込む') as HTMLButtonElement).disabled).toBe(true);
  });

  it('グループだけを選ぶと、入れるタブを選べる', () => {
    openImportDialog(book());
    const inputs = document.querySelectorAll<HTMLInputElement>('.import-tree input');
    inputs[0]!.checked = false;
    inputs[0]!.dispatchEvent(new Event('change'));
    const groupInput = document.querySelectorAll<HTMLInputElement>('.import-tree input')[1]!;
    expect(groupInput.disabled).toBe(false);
    groupInput.checked = true;
    groupInput.dispatchEvent(new Event('change'));
    const select = document.querySelector<HTMLSelectElement>('.import-side select')!;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['自分', '（新しいタブを作る）']);
  });

  it('リボンの定義のない取り込み元（取り込める部品がない）では、ダイアログを開かず知らせる', () => {
    openImportDialog({ name: 'x.xml', path: 'x.xml', kind: 'xml', parts: [{ version: 'office2010', xml: `<customUI xmlns="${NS}"/>`, images: [] }] });
    expect(document.querySelector('.modal')).toBeNull();
    expect(document.querySelector('.toast.warning')).not.toBeNull();
  });

  it('XML に構文エラーのある取り込み元では、ダイアログを開かず知らせる', () => {
    openImportDialog({ name: 'x.xml', path: 'x.xml', kind: 'xml', parts: [{ version: 'office2010', xml: '<customUI', images: [] }] });
    expect(document.querySelector('.modal')).toBeNull();
    expect(document.querySelector('.toast.error')).not.toBeNull();
  });
});
