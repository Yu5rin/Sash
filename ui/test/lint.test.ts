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
