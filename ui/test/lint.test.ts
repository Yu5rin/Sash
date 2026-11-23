import { describe, expect, it } from 'vitest';
import { lint, type LintContext } from '../src/lint';
import { parseXml } from '../src/model';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const ctx: LintContext = { version: 'office2010', imageIds: new Set(['img_ok']), knownIdMso: new Set(['TabHome', 'AutoSum']), missingImageMso: new Set(['NoSuchIcon']) };

function run(body: string, c: Partial<LintContext> = {}) {
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs>${body}</tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return lint(r.doc, { ...ctx, ...c }).map((p) => `${p.severity}:${p.message}`);
}

describe('lint', () => {
  it('正しい定義では何も出ない', () => {
    expect(run('<tab id="t" label="T"><group id="g" label="G"><button id="b" label="B" imageMso="AutoSum" onAction="Ribbon_b_onAction"/></group></tab>')).toEqual([]);
  });

  it('id の重複と未指定はエラー', () => {
    const r = run('<tab id="t"><group id="g"><button id="b"/><button id="b"/><button label="x"/></group></tab>');
    expect(r.filter((m) => m.includes('重複'))).toHaveLength(2);
    expect(r).toContain('error:<button> には id（または idMso / idQ）が必要です');
  });

  it('静的属性と get 系の同時指定はエラー', () => {
    expect(run('<tab id="t"><group id="g"><button id="b" label="a" getLabel="f"/></group></tab>')).toContain('error:label と getLabel は同時に指定できません');
  });

  it('ファイル内にない画像はエラー', () => {
    expect(run('<tab id="t"><group id="g"><button id="b" image="img_ng"/></group></tab>')).toContain('error:画像「img_ng」がファイル内にありません');
  });

  it('未知の idMso と存在しない imageMso は警告', () => {
    const r = run('<tab idMso="TabHomeX"><group id="g"><button id="b" imageMso="NoSuchIcon"/></group></tab>');
    expect(r).toContain('warning:idMso「TabHomeX」はExcelのコマンド一覧にありません');
    expect(r).toContain('warning:imageMso「NoSuchIcon」はExcelに存在しません');
  });

  it('keytip の重複は警告', () => {
    const r = run('<tab id="t"><group id="g"><button id="a" keytip="S"/><button id="b" keytip="s"/></group></tab>');
    expect(r.filter((m) => m.startsWith('warning:keytip'))).toHaveLength(2);
  });

  it('置けない場所の要素と使えない属性はエラー', () => {
    const r = run('<tab id="t"><button id="b" foo="1"/></tab>');
    expect(r).toContain('error:<tab> の中に <button> は置けません');
    expect(r).toContain('error:<button> に foo 属性は使えません');
  });

  it('列挙値と真偽値を検証する', () => {
    const r = run('<tab id="t"><group id="g"><button id="b" size="big" visible="yes"/></group></tab>');
    expect(r).toContain('error:size は normal / large のいずれかです');
    expect(r).toContain('error:visible は true か false で指定してください');
  });

  it('コントロールが多いグループは情報', () => {
    const buttons = Array.from({ length: 13 }, (_, i) => `<button id="b${i}"/>`).join('');
    expect(run(`<tab id="t"><group id="g">${buttons}</group></tab>`)).toContain('info:コントロールが 13 個あります。狭い画面ではグループが畳まれます');
  });

  it('名前空間が形式と合わなければエラー', () => {
    expect(run('', { version: 'office2007' }).some((m) => m.startsWith('error:名前空間'))).toBe(true);
  });
});

describe('コンテキストメニュー', () => {
  const runCtx = (body: string, version: 'office2007' | 'office2010' = 'office2010') => {
    const ns = version === 'office2010' ? NS : 'http://schemas.microsoft.com/office/2006/01/customui';
    const r = parseXml(`<customUI xmlns="${ns}"><contextMenus>${body}</contextMenus></customUI>`);
    if (!r.ok) throw new Error(r.message);
    return lint(r.doc, { ...ctx, version, knownIdMso: new Set(['ContextMenuCell']) }).map((p) => `${p.severity}:${p.message}`);
  };

  it('正しい定義では何も出ない', () => {
    expect(runCtx('<contextMenu idMso="ContextMenuCell"><button id="b" label="B" onAction="f"/><menuSeparator id="s"/></contextMenu>')).toEqual([]);
  });

  it('idMso がなければエラー、置けない要素もエラー', () => {
    const r = runCtx('<contextMenu><group id="g"/></contextMenu>');
    expect(r).toContain('error:<contextMenu> には id（または idMso / idQ）が必要です');
    expect(r).toContain('error:<contextMenu> の中に <group> は置けません');
  });

  it('2007形式では使えない', () => {
    expect(runCtx('<contextMenu idMso="ContextMenuCell"/>', 'office2007').some((m) => m.includes('2010以降の形式でのみ'))).toBe(true);
  });
});

describe('Backstage', () => {
  const runBs = (body: string) => {
    const r = parseXml(`<customUI xmlns="${NS}"><backstage>${body}</backstage></customUI>`);
    if (!r.ok) throw new Error(r.message);
    return lint(r.doc, ctx).map((p) => `${p.severity}:${p.message}`);
  };

  it('Backstage の構造をリボンと区別して検証する', () => {
    expect(runBs('<tab id="t" label="T"><firstColumn><group id="g" label="G" style="warning" helperText="説明"><primaryItem><button id="p" label="P" isDefinitive="true"/></primaryItem><topItems><hyperlink id="h" label="H" target="https://example.com"/></topItems></group></firstColumn></tab><button id="fast" label="F" onAction="f"/>')).toEqual([]);
  });

  it('Backstage のタブにリボンのグループの中身は置けない', () => {
    expect(runBs('<tab id="t"><group id="g"/></tab>')).toContain('error:<tab> の中に <group> は置けません');
  });
});

describe('子要素の順序と個数', () => {
  it('dialogBoxLauncher はグループの末尾に1つだけ', () => {
    const r = run('<tab id="t"><group id="g"><dialogBoxLauncher><button id="d"/></dialogBoxLauncher><button id="b"/></group></tab>');
    expect(r).toContain('error:<button> は <dialogBoxLauncher> より前に置いてください');
    const two = run('<tab id="t"><group id="g"><dialogBoxLauncher><button id="d"/></dialogBoxLauncher><dialogBoxLauncher><button id="e"/></dialogBoxLauncher></group></tab>');
    expect(two).toContain('error:<group> の中に置ける <dialogBoxLauncher> は 1 個までです');
  });

  it('splitButton は button（か toggleButton）1つと menu 1つ', () => {
    expect(run('<tab id="t"><group id="g"><splitButton id="s"><menu id="m"/><button id="b"/></splitButton></group></tab>')).toContain('error:<button> は <menu> より前に置いてください');
    expect(run('<tab id="t"><group id="g"><splitButton id="s"><button id="b"/></splitButton></group></tab>')).toContain('error:<splitButton> には <menu> が必要です');
    expect(run('<tab id="t"><group id="g"><splitButton id="s"><button id="a"/><toggleButton id="b"/><menu id="m"/></splitButton></group></tab>')).toContain('error:<splitButton> の中に置ける <button / toggleButton> は 1 個までです');
  });

  it('customUI と ribbon の中の順序', () => {
    const p = parseXml(`<customUI xmlns="${NS}"><contextMenus/><ribbon><tabs/><qat/></ribbon></customUI>`);
    if (!p.ok) throw new Error(p.message);
    const r = lint(p.doc, ctx).map((x) => x.message);
    expect(r).toContain('<ribbon> は <contextMenus> より前に置いてください');
    expect(r).toContain('<qat> は <tabs> より前に置いてください');
  });

  it('Backstage のタブは firstColumn → secondColumn の順', () => {
    const p = parseXml(`<customUI xmlns="${NS}"><backstage><tab id="t"><secondColumn/><firstColumn/></tab></backstage></customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx).map((x) => x.message)).toContain('<firstColumn> は <secondColumn> より前に置いてください');
  });
});

describe('スキーマの細かな規則', () => {
  it('メニューやボタングループの中のコントロールに size は使えない', () => {
    const r = run('<tab id="t"><group id="g"><menu id="m"><button id="b" size="large"/></menu><buttonGroup id="bg"><button id="c" getSize="f"/></buttonGroup><button id="ok" size="large"/></group></tab>');
    expect(r).toContain('error:<button> に size 属性は使えません');
    expect(r).toContain('error:<button> に getSize 属性は使えません');
    expect(r.filter((m) => /size/i.test(m))).toHaveLength(2);
  });

  it('QAT には control・button・separator だけ', () => {
    const p = parseXml(`<customUI xmlns="${NS}"><ribbon startFromScratch="true"><qat><documentControls><button id="b"/><checkBox id="c"/></documentControls></qat></ribbon></customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx).map((x) => x.message)).toContain('<documentControls> の中に <checkBox> は置けません');
  });

  it('officeMenu は 2007 形式でだけ使える', () => {
    const p = parseXml(`<customUI xmlns="${NS}"><ribbon><officeMenu/></ribbon></customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx).map((x) => x.message)).toContain('<officeMenu> は2007形式（customUI）でのみ使えます');
  });

  it('gallery の showInRibbon は使える。item の id は省略できる', () => {
    expect(run('<tab id="t"><group id="g"><gallery id="ga" showInRibbon="false"><item label="A"/></gallery></group></tab>')).toEqual([]);
  });

  it('Backstage の menu の直下にボタンは置けない', () => {
    const p = parseXml(`<customUI xmlns="${NS}"><backstage><tab id="t"><firstColumn><group id="g"><primaryItem><menu id="m"><button id="b"/></menu></primaryItem></group></firstColumn></tab></backstage></customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx).map((x) => x.message)).toContain('<menu> の中に <button> は置けません');
  });

  it('box・buttonGroup・separator に idMso は使えない', () => {
    const r = run('<tab id="t"><group id="g"><box idMso="X"/><separator idMso="Y"/></group></tab>');
    expect(r).toContain('error:<box> に idMso 属性は使えません');
    expect(r).toContain('error:<separator> に idMso 属性は使えません');
  });

  it('keytip は3文字まで、maxLength は1以上', () => {
    const r = run('<tab id="t" keytip="ABCD"><group id="g"><editBox id="e" maxLength="0"/></group></tab>');
    expect(r).toContain('error:keytip は3文字以内で指定してください');
    expect(r).toContain('error:maxLength は 1〜1024 の整数で指定してください');
  });

  it('invalidateContentOnDrop は2010以降', () => {
    const p = parseXml('<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui"><ribbon><tabs><tab id="t"><group id="g"><dynamicMenu id="d" getContent="f" invalidateContentOnDrop="true"/></group></tab></tabs></ribbon></customUI>');
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, { ...ctx, version: 'office2007' }).map((x) => x.message)).toContain('invalidateContentOnDrop は2010以降の形式でのみ使えます');
  });

  it('loadImage があれば、image の値はファイル内の画像でなくてよい', () => {
    const p = parseXml(`<customUI xmlns="${NS}" loadImage="LoadImage"><ribbon><tabs><tab id="t"><group id="g"><button id="b" image="C:\\icons\\a.png"/></group></tab></tabs></ribbon></customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx).filter((x) => x.message.includes('ファイル内にありません'))).toEqual([]);
  });

  it('日本語の id とコールバック名を受け付ける', () => {
    expect(run('<tab id="集計" label="T"><group id="グループ" label="G"><button id="合計ボタン" onAction="Ribbon_合計_onAction"/></group></tab>')).toEqual([]);
    expect(run('<tab id="t"><group id="g"><button id="b" onAction="Module1.Run"/><button id="c" onAction="1abc"/></group></tab>')).toEqual(['error:コールバック名「1abc」はVBAのSub名として使えません']);
  });
});

describe('名前空間', () => {
  it('接頭辞つきの文書でも、同じ名前空間なら正しい', () => {
    const p = parseXml(`<mso:customUI xmlns:mso="${NS}"><mso:ribbon><mso:tabs><mso:tab id="t" label="T"/></mso:tabs></mso:ribbon></mso:customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx)).toEqual([]);
  });

  it('名前空間の違う要素はエラー', () => {
    const p = parseXml(`<mso:customUI xmlns:mso="${NS}"><mso:ribbon><tabs/></mso:ribbon></mso:customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx).some((x) => x.message.startsWith('<tabs> の名前空間が customUI と違います'))).toBe(true);
  });
});

describe('keytip の重複の範囲', () => {
  it('別のタブ・メニューの中なら重複にしない', () => {
    const r = run('<tab id="t1" keytip="A"><group id="g1"><button id="a" keytip="X"/><menu id="m" keytip="M"><button id="ma" keytip="X"/></menu></group></tab><tab id="t2" keytip="B"><group id="g2"><button id="b" keytip="X"/></group></tab>');
    expect(r.filter((m) => m.includes('keytip'))).toEqual([]);
  });

  it('リボンのタブと Backstage のタブは別に数える', () => {
    const p = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" keytip="F"/></tabs></ribbon><backstage><tab id="bt" keytip="F"/></backstage></customUI>`);
    if (!p.ok) throw new Error(p.message);
    expect(lint(p.doc, ctx).filter((x) => x.message.includes('keytip'))).toEqual([]);
  });
});
