import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { buildEmptyState } from '../src/dialogs/libraryDialog';
import { joinSections, openRecipes, showCode } from '../src/dialogs/recipeDialog';
import { parseXml, pathOf } from '../src/model';

const DOC_XML = '<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G"><button id="b" label="B"/></group></tab></tabs></ribbon></customUI>';
/** 実際の文書を持つ store の代わり（アイコンを持てる要素かどうかを、文書の中身で判定するため）。 */
function storeSelecting(tag: string): { selection: number[]; doc: Document } {
  const r = parseXml(DOC_XML);
  if (!r.ok) throw new Error(r.message);
  const el = r.doc.querySelector(tag)!;
  return { selection: pathOf(el), doc: r.doc };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('レシピ：コピーできなかったときの VBA の画面', () => {
  const sections = [
    { name: 'SashRibbon（まだなければ）', code: 'Public x' },
    { name: 'Module1', code: 'Sub A()\r\nEnd Sub' },
  ];

  it('モジュールごとに［コピー］があり、フッターは［すべてコピー］（主）と［閉じる］', () => {
    const m = showCode(sections);
    expect(m.root.querySelector('h2')?.textContent).toBe('VBA に貼り付けるコード');
    expect(m.root.querySelectorAll('.vba-section-head')).toHaveLength(2);
    expect(Array.from(m.root.querySelectorAll('.vba-section-head button')).map((b) => b.textContent)).toEqual(['コピー', 'コピー']);
    const footer = Array.from(m.root.querySelectorAll('footer button'));
    expect(footer.map((b) => b.textContent)).toEqual(['すべてコピー', '閉じる']);
    expect(footer[0]!.classList.contains('primary')).toBe(true);
    m.close();
  });

  it('開いたら［すべてコピー］にフォーカスがある', () => {
    const m = showCode(sections);
    expect(document.activeElement?.textContent).toBe('すべてコピー');
    m.close();
  });

  it('［コピー］はそのモジュールだけ、［すべてコピー］は見出し付きで全部を書く', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const m = showCode(sections);
    (m.root.querySelectorAll<HTMLButtonElement>('.vba-section-head button')[1])!.click();
    expect(writeText).toHaveBeenLastCalledWith('Sub A()\r\nEnd Sub');
    m.root.querySelector<HTMLButtonElement>('footer button.primary')!.click();
    expect(writeText).toHaveBeenLastCalledWith(joinSections(sections));
    expect(joinSections(sections)).toContain("' ===== Module1 =====\r\nSub A()");
    m.close();
  });
});

describe('アイコンライブラリが空のとき', () => {
  it('要素を選んでいなければ［アイコンを作る…］は無効で、理由を出す', () => {
    vi.spyOn(app, 'store', 'get').mockReturnValue({ selection: null } as never);
    const box = buildEmptyState(() => undefined, false);
    const btn = box.querySelector<HTMLButtonElement>('button')!;
    expect(btn.textContent).toBe('アイコンを作る…');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('選んでください');
    expect(box.querySelector('.library-empty-reason')).not.toBeNull();
  });

  it('要素を選んでいれば有効', () => {
    vi.spyOn(app, 'store', 'get').mockReturnValue(storeSelecting('button') as never);
    const btn = buildEmptyState(() => undefined, false).querySelector<HTMLButtonElement>('button')!;
    expect(btn.disabled).toBe(false);
  });

  it('タブなど、アイコンを持てない要素を選んでいるときも無効で、理由を出す（総点検 C-7）', () => {
    vi.spyOn(app, 'store', 'get').mockReturnValue(storeSelecting('tab') as never);
    const box = buildEmptyState(() => undefined, false);
    expect(box.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    expect(box.querySelector('.library-empty-reason')).not.toBeNull();
  });

  it('［アイコンを作る…］は、選んでいる要素を渡された関数に伝える（iconDialog を直接 import しない）', () => {
    const st = storeSelecting('button');
    vi.spyOn(app, 'store', 'get').mockReturnValue(st as never);
    const opened: unknown[] = [];
    const closed: number[] = [];
    const btn = buildEmptyState(() => closed.push(1), false, (p) => opened.push(p)).querySelector<HTMLButtonElement>('button')!;
    btn.click();
    expect(opened).toEqual([st.selection]);
    expect(closed).toEqual([1]);
  });

  it('アイコンを選ぶために開いたときは、作る入口を出さず説明だけにする', () => {
    vi.spyOn(app, 'store', 'get').mockReturnValue(storeSelecting('button') as never);
    const box = buildEmptyState(() => undefined, true);
    expect(box.querySelector('button')).toBeNull();
    expect(box.textContent).toContain('ライブラリは空です');
  });
});

describe('D-10 構文エラーの間はレシピを挿入できない', () => {
  it('［挿入］は押せず理由がツールチップに出る。ダイアログも閉じない', async () => {
    app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: '<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui"><ribbon><tabs/></ribbon></customUI>', images: [] }] });
    app.store!.setText('<customUI><');
    expect(app.store!.syncError).not.toBeNull();
    await openRecipes(() => undefined);
    const insert = Array.from(document.querySelectorAll<HTMLButtonElement>('.modal footer button')).find((b) => b.textContent === '挿入')!;
    expect(insert.disabled).toBe(true);
    expect(insert.title).toContain('構文エラー');
    insert.click();
    expect(document.querySelector('.modal')).not.toBeNull();
    document.querySelector<HTMLElement>('.modal')?.remove();
  });
});
