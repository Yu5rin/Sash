import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { buildEmptyState } from '../src/dialogs/libraryDialog';
import { joinSections, showCode } from '../src/dialogs/recipeDialog';

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
    vi.spyOn(app, 'store', 'get').mockReturnValue({ selection: [0, 1] } as never);
    const btn = buildEmptyState(() => undefined, false).querySelector<HTMLButtonElement>('button')!;
    expect(btn.disabled).toBe(false);
  });

  it('アイコンを選ぶために開いたときは、作る入口を出さず説明だけにする', () => {
    vi.spyOn(app, 'store', 'get').mockReturnValue({ selection: [0] } as never);
    const box = buildEmptyState(() => undefined, true);
    expect(box.querySelector('button')).toBeNull();
    expect(box.textContent).toContain('ライブラリは空です');
  });
});
