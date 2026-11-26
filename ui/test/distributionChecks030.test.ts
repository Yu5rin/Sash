import { describe, expect, it } from 'vitest';
import {
  attentionCount, collectChecks, hasInvalidateCall, isCommonTabLabel, isGenericCallback, isGenericId, onLoadHoldsRibbon, suggestionCount,
  type CheckInput, type CheckSection,
} from '../src/distributionCheck';
import { analyzePixels, dataUrlBytes, pngSize, type ImageInfo, type PixelStats } from '../src/imageStats';
import { lint, type Problem } from '../src/lint';
import { parseXml } from '../src/model';
import { matchCallbacks, type VbaModule } from '../src/vba';

// 配布前チェックの追加項目（仕様書 §23.5）

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';

function doc(body: string, rootAttrs = ''): Document {
  const r = parseXml(`<customUI xmlns="${NS}" ${rootAttrs}><ribbon><tabs>${body}</tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

function input(d: Document, extra: Partial<CheckInput> = {}): CheckInput {
  const problems: Problem[] = lint(d, { version: 'office2010', imageIds: new Set(extra.imageIds ?? []), knownIdMso: new Set(), missingImageMso: new Set() });
  return { doc: d, problems, statuses: [], vbaChecked: false, imageIds: [], fit: null, ...extra };
}

const section = (s: CheckSection[], id: CheckSection['id']) => s.find((x) => x.id === id)!;

describe('名前の判定', () => {
  it('接頭辞のない一般的な id・コールバック名・タブ名だけを対象にする', () => {
    for (const id of ['btn1', 'Button2', 'tab_1', 'grp', 'chk-3', 'dropDown1', 'Menu']) expect(isGenericId(id), id).toBe(true);
    for (const id of ['acct_btnSum', 'btnSummary', 'tabMonthly', 'button1x', 'b1']) expect(isGenericId(id), id).toBe(false);
    for (const n of ['Button1_Click', 'OnAction', 'Macro1', 'Main', 'modMain.Run']) expect(isGenericCallback(n), n).toBe(true);
    for (const n of ['Ribbon_onAction', 'Ribbon_btnSum_onAction', 'acct_Run', 'CSV出力']) expect(isGenericCallback(n), n).toBe(false);
    for (const l of ['ホーム', 'Add-ins', 'アドイン', ' ツール ', 'ＨＯＭＥ', 'New Tab']) expect(isCommonTabLabel(l), l).toBe(true);
    for (const l of ['経理ツール', 'Acct Tools']) expect(isCommonTabLabel(l), l).toBe(false);
  });
});

describe('ほかのアドインと重なりやすい名前', () => {
  it('一般的な id・タブ名・コールバック名を挙げる。固有の接頭辞のあるもの・item は挙げない', () => {
    const d = doc(`<tab id="tab1" label="アドイン"><group id="acct_g" label="G"><button id="btn1" label="A" onAction="Button1_Click"/><button id="acct_b" label="B" onAction="acct_Run"/><dropDown id="dd1" label="D"><item id="item1" label="x"/></dropDown></group></tab>`);
    const items = section(collectChecks(input(d)), 'commonNames').items;
    expect(items.map((i) => i.text)).toEqual([
      'id「tab1」は、ほかのアドインと重なりやすい名前です',
      'タブ名「アドイン」は、Excel やほかのアドインのタブと紛らわしい名前です',
      'id「btn1」は、ほかのアドインと重なりやすい名前です',
      'id「dd1」は、ほかのアドインと重なりやすい名前です',
      'コールバック名「Button1_Click」は、ほかのアドインと重なりやすい名前です',
    ]);
    expect(items.every((i) => i.level === 'should' && i.target === 'element')).toBe(true);
  });

  it('組み込みのタブ（idMso）や、固有の名前だけなら何も出ない。配ってよいかの数には入らない', () => {
    const d = doc('<tab idMso="TabHome" label="ホーム"><group id="acct_g" label="G"/></tab><tab id="acct_tab" label="経理ツール"/>');
    const s = collectChecks(input(d));
    expect(section(s, 'commonNames').items).toEqual([]);
    expect(attentionCount(collectChecks(input(doc('<tab id="tab1" label="x"/>'))))).toBe(0);
  });
});

describe('onLoad と Invalidate の入れ忘れ', () => {
  const dyn = '<tab id="t" label="T"><group id="g" label="G"><button id="b" label="B" getEnabled="Ribbon_b_getEnabled" onAction="Ribbon_b_onAction"/></group></tab>';

  it('get〜 の動的な属性があるのに onLoad がなければ、customUI を指して知らせる', () => {
    const items = section(collectChecks(input(doc(dyn))), 'ribbonHolder').items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ level: 'should', path: [], target: 'element' });
    expect(items[0]!.text).toContain('getEnabled');
    expect(items[0]!.text).toContain('onLoad がありません');
  });

  it('動的な属性がなければ、確かめない', () => {
    const s = collectChecks(input(doc('<tab id="t" label="T"><group id="g" label="G"><button id="b" label="B" onAction="Run"/></group></tab>')));
    expect(section(s, 'ribbonHolder').items).toEqual([]);
    expect(section(s, 'ribbonHolder').note).toContain('確かめる必要はありません');
  });

  function withVba(modules: VbaModule[], d = doc(dyn, 'onLoad="Ribbon_onLoad"')) {
    const statuses = matchCallbacks(d, modules);
    return section(collectChecks(input(d, { statuses, vbaChecked: true, modules })), 'ribbonHolder').items;
  }
  const mod = (code: string): VbaModule => ({ name: 'modRibbon', type: 1, code });
  const getEnabled = 'Public Sub Ribbon_b_getEnabled(control As IRibbonControl, ByRef returnedVal)\r\n    returnedVal = True\r\nEnd Sub\r\nPublic Sub Ribbon_b_onAction(control As IRibbonControl)\r\nEnd Sub\r\n';

  it('onLoad の Sub が、受け取った ribbon を使っていなければ知らせる（コメントだけ・TODO のとき）', () => {
    const items = withVba([mod(`Public Sub Ribbon_onLoad(ribbon As IRibbonUI)\r\n    ' TODO: ribbon を保持する\r\nEnd Sub\r\n${getEnabled}`)]);
    expect(items.map((i) => i.text)).toEqual([
      expect.stringContaining('onLoad の Sub「Ribbon_onLoad」が、受け取った ribbon を保持していません'),
      expect.stringContaining('Invalidate を呼ぶところがありません'),
    ]);
  });

  it('ribbon を変数に保持していて、どこかで Invalidate を呼んでいれば何も出ない', () => {
    const items = withVba([mod(`Public gRibbon As IRibbonUI\r\nPublic Sub Ribbon_onLoad(ribbon As IRibbonUI)\r\n    Set gRibbon = ribbon\r\nEnd Sub\r\nPublic Sub Refresh()\r\n    gRibbon.Invalidate\r\nEnd Sub\r\n${getEnabled}`)]);
    expect(items).toEqual([]);
  });

  it('共通コード（modRibbonCore）の中の InvalidateRibbon の定義は、呼び出しに数えない', () => {
    const core: VbaModule = { name: 'modRibbonCore', type: 1, code: 'Public Sub SaveRibbonPointer(ByVal ribbon As IRibbonUI)\r\nEnd Sub\r\nPublic Sub InvalidateRibbon(Optional ByVal controlId As String = "")\r\n    GetRibbon.Invalidate\r\nEnd Sub\r\n' };
    const onLoad = mod(`Public Sub Ribbon_onLoad(ribbon As IRibbonUI)\r\n    SaveRibbonPointer ribbon\r\nEnd Sub\r\n${getEnabled}`);
    // onLoad は保持している。呼び出しは共通コードの定義だけなので、Invalidate を呼ぶところがない
    expect(withVba([core, onLoad]).map((i) => i.text)).toEqual([expect.stringContaining('Invalidate を呼ぶところがありません')]);
    // どこかが InvalidateRibbon を呼んでいれば出ない
    const caller = mod(`Public Sub Ribbon_onLoad(ribbon As IRibbonUI)\r\n    SaveRibbonPointer ribbon\r\nEnd Sub\r\nPublic Sub X()\r\n    InvalidateRibbon\r\nEnd Sub\r\n${getEnabled}`);
    expect(withVba([core, caller])).toEqual([]);
  });

  it('VBA と照合していなければ、onLoad の中身は確かめず、そのことを注記する', () => {
    const s = section(collectChecks(input(doc(dyn, 'onLoad="Ribbon_onLoad"'))), 'ribbonHolder');
    expect(s.items).toEqual([]);
    expect(s.note).toContain('照合していない');
  });

  it('onLoadHoldsRibbon・hasInvalidateCall の細部：コメントの中の名前は数えない', () => {
    const m = [{ name: 'm', type: 1, code: "Public Sub L(r As IRibbonUI)\r\n    ' r を保持する\r\n    Dim x\r\nEnd Sub\r\nSub A()\r\n    ' ribbon.Invalidate\r\nEnd Sub\r\n" }];
    expect(onLoadHoldsRibbon(m, 'L', 'm')).toBe(false);
    expect(onLoadHoldsRibbon(m, 'Nothing', 'm')).toBeNull();
    expect(hasInvalidateCall(m, 'core')).toBe(false);
  });
});

describe('画像の画素の集計', () => {
  const px = (w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
    return analyzePixels(data, w, h);
  };

  it('透明な背景に黒一色：暗い・透明あり・背景なし', () => {
    const st = px(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(st.opaque).toBe(64);
    expect(st.meanLuma).toBe(0);
    expect(st.darkShare).toBe(1);
    expect(st.hasTransparency).toBe(true);
    expect(st.solidBackground).toBeNull();
  });

  it('四隅が白で透明がない：白い背景', () => {
    const st = px(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [20, 90, 55, 255] : [255, 255, 255, 255]));
    expect(st.solidBackground).toBe('light');
    expect(st.hasTransparency).toBe(false);
  });

  it('四隅が黒で透明がない：黒い背景。色が揃っていなければ背景とみなさない', () => {
    expect(px(8, 8, () => [0, 0, 0, 255]).solidBackground).toBe('dark');
    expect(px(8, 8, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])).solidBackground).toBeNull();
  });

  it('PNG のヘッダーから大きさを、base64 の長さからバイト数を求める', () => {
    const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect(pngSize(png1x1)).toEqual({ width: 1, height: 1 });
    expect(pngSize('data:image/jpeg;base64,AAAA')).toBeNull();
    expect(pngSize('data:image/png;base64,AAAA')).toBeNull();
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/png;base64,AAA=')).toBe(2);
    expect(dataUrlBytes('data:image/png;base64,AA==')).toBe(1);
  });
});

describe('テーマで見えにくいアイコンと、大きすぎる画像', () => {
  const stats = (over: Partial<PixelStats>): PixelStats => ({ width: 32, height: 32, opaque: 400, total: 1024, meanLuma: 128, darkShare: 0.2, lightShare: 0.2, hasTransparency: true, solidBackground: null, ...over });
  const info = (over: Partial<ImageInfo> = {}, st?: Partial<PixelStats>): ImageInfo => ({ bytes: 1000, width: 32, height: 32, ...(st ? { stats: stats(st) } : {}), ...over });
  const btn = (img: string) => `<tab id="t" label="T"><group id="g" label="G"><button id="b${img}" label="${img}" image="${img}"/></group></tab>`;
  const d = doc(`<tab id="t" label="T"><group id="g" label="G">${['dark', 'light', 'whiteBg', 'colorful', 'big', 'heavy'].map((img) => `<button id="b${img}" label="${img}" image="${img}"/>`).join('')}</group></tab>`);
  const ids = ['dark', 'light', 'whiteBg', 'colorful', 'big', 'heavy', 'unused'];
  const images = new Map<string, ImageInfo>([
    ['dark', info({}, { meanLuma: 10, darkShare: 0.98 })],
    ['light', info({}, { meanLuma: 245, lightShare: 0.97 })],
    ['whiteBg', info({}, { solidBackground: 'light', hasTransparency: false })],
    ['colorful', info({}, { meanLuma: 110 })],
    ['big', info({ width: 128, height: 128 })],
    ['heavy', info({ bytes: 80 * 1024 })],
    // 使っていない画像は、ここでは見ない（「使っていない画像」の分類に出る）
    ['unused', info({ width: 512, height: 512 }, { meanLuma: 0, darkShare: 1 })],
  ]);
  const s = collectChecks(input(d, { images, imageIds: ids }));

  it('暗い単色・白に近い単色・不透明な背景を挙げ、ふつうの色の画像は挙げない', () => {
    const items = section(s, 'themeIcons').items;
    expect(items.map((i) => i.detail)).toEqual(['dark', 'light', 'whiteBg']);
    expect(items[0]!.text).toContain('黒・濃い灰色のテーマで背景に沈みます');
    expect(items[1]!.text).toContain('白・明るいテーマ');
    expect(items[2]!.text).toContain('白い背景が透明になっていません');
    expect(items.every((i) => i.level === 'should' && i.target === 'images')).toBe(true);
  });

  it('大きすぎる画像は、寸法とバイト数を添えて挙げる', () => {
    const items = section(s, 'bigImages').items;
    expect(items.map((i) => i.detail)).toEqual(['big', 'heavy']);
    expect(items[0]!.text).toContain('128×128 px');
    expect(items[1]!.text).toContain('80 KB');
  });

  it('色を調べ終えていない画像（stats なし）は挙げず、調べている旨を注記する。寸法・バイト数は調べ終えなくても見られる', () => {
    const only = new Map<string, ImageInfo>([['dark', info({ width: 200, height: 10 })]]);
    const s2 = collectChecks(input(doc(btn('dark')), { images: only, imageIds: ['dark'] }));
    expect(section(s2, 'themeIcons').items).toEqual([]);
    expect(section(s2, 'themeIcons').note).toContain('調べています');
    expect(section(s2, 'bigImages').items).toHaveLength(1);
  });

  it('これらは見直すとよいもの（should）で、配ってよいかの数には入らない', () => {
    expect(attentionCount(s)).toBe(0);
    expect(suggestionCount(s)).toBeGreaterThanOrEqual(5);
  });
});

describe('配布先でのマクロのブロック', () => {
  const d = doc('<tab id="t" label="T"/>');

  it('いつでも案内を 1 行出す（件数には数えない）', () => {
    const s = section(collectChecks(input(d)), 'macroBlock');
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ level: 'info', target: 'none' });
    expect(s.note).toContain('Mark of the Web');
    expect(s.note).toContain('信頼できる場所');
    expect(suggestionCount(collectChecks(input(d)))).toBe(0);
  });

  it('このブック自体に印があれば、見直すものとして先頭に出す', () => {
    const s = collectChecks(input(d, { webMark: true }));
    const items = section(s, 'macroBlock').items;
    expect(items.map((i) => i.level)).toEqual(['should', 'info']);
    expect(items[0]!.text).toContain('インターネットから取得した印');
    expect(suggestionCount(s)).toBe(1);
    expect(attentionCount(s)).toBe(0);
  });
});
