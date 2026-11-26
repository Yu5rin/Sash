import { describe, expect, it } from 'vitest';
import { attentionCount, collectChecks, errorCount, readyToDistribute, suggestionCount, summaryLevel, summaryText, unverifiedCallbacks, type CheckInput, type CheckSection } from '../src/distributionCheck';
import { lint, type Problem } from '../src/lint';
import { parseXml } from '../src/model';
import { matchCallbacks } from '../src/vba';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';

function doc(body: string): Document {
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs>${body}</tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

function input(d: Document, extra: Partial<CheckInput> = {}): CheckInput {
  const problems: Problem[] = lint(d, { version: 'office2010', imageIds: new Set(extra.imageIds ?? []), knownIdMso: new Set(), missingImageMso: new Set() });
  return { doc: d, problems, statuses: [], vbaChecked: false, imageIds: [], fit: null, ...extra };
}

const section = (s: CheckSection[], id: CheckSection['id']) => s.find((x) => x.id === id)!;

describe('配布前チェック', () => {
  it('問題がなく、コールバックも照合できていれば「配ってよい状態です」', () => {
    const d = doc('<tab id="t" label="T"><group id="g" label="G" imageMso="HappyFace"><button id="b" label="実行" imageMso="MacroPlay" screentip="実行します" onAction="Run" /></group></tab>');
    const statuses = matchCallbacks(d, [{ name: 'Module1', type: 1, code: 'Sub Run(control As IRibbonControl)\r\nEnd Sub\r\n' }]);
    const s = collectChecks(input(d, { statuses, vbaChecked: true }));
    expect(readyToDistribute(s)).toBe(true);
    expect(attentionCount(s)).toBe(0);
    expect(summaryText(s)).toBe('配ってよい状態です');
    expect(section(s, 'noScreentip').items).toEqual([]);
    expect(section(s, 'noIcon').items).toEqual([]);
  });

  it('ヒント・アイコンのない自作のボタンを数える（組み込み・メニューの中は数えない）', () => {
    const d = doc(`<tab id="t" label="T"><group id="g" label="G">
      <button id="b1" label="A" />
      <button idMso="Copy" />
      <menu id="m" label="M" imageMso="HappyFace" screentip="m"><button id="inMenu" label="X" /></menu>
      <splitButton id="sp"><button id="spb" label="S" /><menu id="spm"><button id="spi" label="Y" /></menu></splitButton>
    </group></tab>`);
    const s = collectChecks(input(d));
    expect(section(s, 'noScreentip').items.map((i) => i.text)).toEqual(['A（button）', 'S（button）', 'spm（menu）']);
    expect(section(s, 'noIcon').items.map((i) => i.path)).toEqual([[0, 0, 0, 0, 0], [0, 0, 0, 0, 3, 0], [0, 0, 0, 0, 3, 1]]);
    expect(section(s, 'noIcon').items.every((i) => i.level === 'should')).toBe(true);
    // 見直すとよいものは、配ってよいかの件数には数えない
    expect(attentionCount(s)).toBe(0);
    expect(suggestionCount(s)).toBe(6);
  });

  it('エラーは must。キーヒントの重複と長いラベルは別の分類に分ける', () => {
    const d = doc(`<tab id="t" label="T"><group id="g" label="G">
      <button id="a" label="A" keytip="K" imageMso="X" screentip="s" />
      <button id="b" label="B" keytip="K" imageMso="X" screentip="s" />
      <button id="c" label="とても長いラベルの大きいボタンです" size="large" imageMso="X" screentip="s" />
      <button id="a" label="dup" imageMso="X" screentip="s" />
    </group></tab>`);
    const s = collectChecks(input(d));
    expect(section(s, 'keytips').items).toHaveLength(2);
    expect(section(s, 'longLabels').items).toHaveLength(1);
    const problems = [...section(s, 'errors').items, ...section(s, 'warnings').items];
    // id の重複（エラー）は問題の分類に。キーヒントと長いラベルは二重に数えない
    expect(problems.some((i) => i.severity === 'error')).toBe(true);
    expect(problems.some((i) => i.text.includes('keytip'))).toBe(false);
    expect(attentionCount(s)).toBe(problems.length + 2);
    // エラーがあるときは「確認が必要」ではなく、配ってはいけないと伝える
    expect(summaryLevel(s)).toBe('error');
    expect(errorCount(s)).toBeGreaterThan(0);
    expect(summaryText(s)).toBe(`このまま配ると、Excel でリボンが表示されません（エラー ${errorCount(s)} 件）`);
    // must を含む分類が上に来る
    expect(s[0]!.items.some((i) => i.level === 'must')).toBe(true);
  });

  it('VBA と照合していなければ、コールバックは数えずに理由を出す', () => {
    const d = doc('<tab id="t" label="T"><group id="g" label="G"><button id="b" label="B" imageMso="X" screentip="s" onAction="Ribbon_b_onAction" /></group></tab>');
    const statuses = matchCallbacks(d, null);
    const s = collectChecks(input(d, { statuses, vbaChecked: false, vbaNote: 'Excel で開かれていません' }));
    expect(section(s, 'callbacks').items).toEqual([]);
    expect(section(s, 'callbacks').note).toContain('Excel で開かれていません');
  });

  it('コールバックがあるのに VBA と照合できていなければ、「配ってよい」とは言わず、その分類を一番上に出す', () => {
    const d = doc('<tab id="t" label="T"><group id="g" label="G" imageMso="HappyFace"><button id="b" label="B" imageMso="X" screentip="s" onAction="Run" /><button id="c" label="C" imageMso="X" screentip="s" onAction="Run" getEnabled="En" /></group></tab>');
    const s = collectChecks(input(d, { statuses: matchCallbacks(d, null), vbaChecked: false }));
    expect(attentionCount(s)).toBe(0);
    expect(unverifiedCallbacks(s)).toBe(2);
    expect(readyToDistribute(s)).toBe(false);
    expect(summaryText(s)).toBe('VBA と照合できていません（コールバック 2 件は未確認）');
    expect(s[0]!.id).toBe('callbacks');
    // エラー（id の重複）があれば、照合の未確認より先にそれを伝える（配ってはいけない状態）
    const d2 = doc('<tab id="t" label="T"><group id="g" label="G"><button id="a" label="A" imageMso="X" screentip="s" onAction="Run" /><button id="a" label="B" imageMso="X" screentip="s" /></group></tab>');
    const s2 = collectChecks(input(d2, { vbaChecked: false }));
    expect(summaryText(s2)).toMatch(/^このまま配ると、Excel でリボンが表示されません（エラー \d+ 件）$/);
    expect(unverifiedCallbacks(s2)).toBe(1);
  });

  it('VBA にないコールバックは must で、Lint の同じ警告は問題の分類から除く', () => {
    const d = doc('<tab id="t" label="T"><group id="g" label="G"><button id="b" label="B" imageMso="X" screentip="s" onAction="Ribbon_b_onAction" /></group></tab>');
    const statuses = matchCallbacks(d, [{ name: 'Module1', type: 1, code: 'Sub Other()\r\nEnd Sub\r\n' }]);
    const base = input(d);
    // callbacks.ts の problemProviders と同じ形の警告を足す
    const problems: Problem[] = [...base.problems, { severity: 'warning', message: 'コールバック Ribbon_b_onAction がVBAにありません', path: [0, 0, 0, 0, 0], attr: 'onAction' }];
    const s = collectChecks({ ...base, problems, statuses, vbaChecked: true });
    expect(section(s, 'callbacks').items.map((i) => [i.level, i.target])).toEqual([['must', 'callbacks']]);
    expect(section(s, 'errors').items).toEqual([]);
    expect(section(s, 'warnings').items).toEqual([]);
    expect(attentionCount(s)).toBe(1);
    // 警告だけ（エラーなし）なら、赤ではなく「要確認」の段
    expect(summaryLevel(s)).toBe('attention');
  });

  it('エラーと警告は別の節に分け、エラーの節が先頭に来る（総点検 D-1）', () => {
    const d = doc('<tab id="t" label="T"><group id="g" label="G"><button id="a" label="A" imageMso="X" screentip="s" /><button id="a" label="B" imageMso="X" screentip="s" /></group></tab>');
    const s = collectChecks(input(d));
    expect(section(s, 'errors').items.every((i) => i.severity === 'error' && i.level === 'must')).toBe(true);
    expect(section(s, 'errors').items.length).toBeGreaterThan(0);
    expect(section(s, 'warnings').items.every((i) => i.severity !== 'error')).toBe(true);
    expect(s[0]!.id).toBe('errors');
  });

  it('使っていない画像を挙げる', () => {
    const d = doc('<tab id="t" label="T"><group id="g" label="G"><button id="b" label="B" image="used" screentip="s" /></group></tab>');
    const s = collectChecks(input(d, { imageIds: ['used', 'old'] }));
    expect(section(s, 'unusedImages').items.map((i) => [i.text, i.target])).toEqual([['old', 'images']]);
  });

  it('VBA で決まる文言を参考として挙げる', () => {
    const d = doc('<tab id="t" getLabel="L1"><group id="g" label="G"><button id="b" getLabel="L2" getScreentip="L3" imageMso="X" /></group></tab>');
    const items = section(collectChecks(input(d)), 'dynamicText').items;
    expect(items.map((i) => i.text)).toEqual(['getLabel="L1"', 'getLabel="L2"', 'getScreentip="L3"']);
    expect(items.every((i) => i.level === 'info')).toBe(true);
  });

  it('幅を測っていなければ案内を出し、測っていれば収まらないものを must にする', () => {
    const d = doc('<tab id="t" label="T"><group id="g1" label="G1" /><group id="g2" label="G2" /></tab>');
    expect(section(collectChecks(input(d)), 'fit').note).toBe('キャンバスで幅を選ぶと確認できます');
    const fit = {
      entries: [
        { path: [0, 0, 0, 0], id: 'g1', label: 'G1', collapsedAt: 1366, noIcon: true },
        { path: [0, 0, 0, 1], id: 'g2', label: 'G2', clippedAt: 1280, noIcon: false },
      ],
      widthLabel: (w: number) => `${w} 幅`,
      widths: '1920 幅、1366 幅',
    };
    const s = collectChecks(input(d, { fit }));
    expect(section(s, 'fit').items.map((i) => [i.level, i.text])).toEqual([
      ['should', '1366 幅で［G1］が畳まれます（目安）'],
      ['must', '1280 幅で［G2］が収まりません（目安）'],
      ['should', '1 グループで畳まれたときのアイコンが未設定です'],
    ]);
    expect(attentionCount(s)).toBe(1);
  });
});
