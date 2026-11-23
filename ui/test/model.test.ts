import { describe, expect, it } from 'vitest';
import {
  allowedInsertIndex, canDuplicate, createElement, duplicateElement, elementAt, ensureTabs, escapeAttr, insertSmart, moveElement, parseXml, pathOf, serialize, suggestId,
} from '../src/model';
import { lint } from '../src/lint';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';

function doc(xml: string): Document {
  const r = parseXml(xml);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

describe('parseXml', () => {
  it('構文エラーを返す', () => {
    const r = parseXml('<customUI><ribbon></customUI>');
    expect(r.ok).toBe(false);
  });
});

describe('serialize', () => {
  it('コメントと属性の順序を保って整形する', () => {
    const d = doc(`<customUI xmlns="${NS}"><!-- メモ --><ribbon><tabs><tab label="A" id="t1"/></tabs></ribbon></customUI>`);
    expect(serialize(d)).toBe(
      [
        `<customUI xmlns="${NS}">`,
        '  <!-- メモ -->',
        '  <ribbon>',
        '    <tabs>',
        '      <tab label="A" id="t1" />',
        '    </tabs>',
        '  </ribbon>',
        '</customUI>',
        '',
      ].join('\n'),
    );
  });

  it('属性値をエスケープする', () => {
    const d = doc(`<customUI xmlns="${NS}" onLoad="a&amp;&quot;b" />`);
    expect(serialize(d)).toContain('onLoad="a&amp;&quot;b"');
  });
});

describe('パス', () => {
  it('pathOf と elementAt が対応する', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="a"/><tab id="b"/></tabs></ribbon></customUI>`);
    const b = d.querySelector('[id="b"]')!;
    expect(pathOf(b)).toEqual([0, 0, 1]);
    expect(elementAt(d, [0, 0, 1])).toBe(b);
    expect(elementAt(d, [0, 5])).toBeNull();
  });
});

describe('suggestId', () => {
  it('日本語のラベルなら種類＋連番にする', () => {
    expect(suggestId('button', '集計する', new Set(['btn1']))).toBe('btn2');
  });
  it('英数字のラベルなら単語をつなげる', () => {
    expect(suggestId('button', 'Export CSV', new Set())).toBe('btnExportCsv');
    expect(suggestId('button', 'Export CSV', new Set(['btnExportCsv']))).toBe('btnExportCsv2');
  });
});

describe('編集操作', () => {
  it('分割ボタンは中身ごと作られ、id が重ならない', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="tab1"><group id="grp1"><button id="btn1"/></group></tab></tabs></ribbon></customUI>`);
    const el = createElement(d, 'splitButton');
    expect(el.children[0]!.localName).toBe('button');
    expect(el.children[0]!.getAttribute('id')).toBe('btn2');
    expect(el.children[1]!.localName).toBe('menu');
    expect(el.namespaceURI).toBe(NS);
  });

  it('ensureTabs は ribbon と tabs を作る', () => {
    const d = doc(`<customUI xmlns="${NS}" />`);
    const tabs = ensureTabs(d);
    expect(pathOf(tabs)).toEqual([0, 0]);
    expect(serialize(d)).toContain('<tabs />');
  });

  it('同じ親の中で後ろへ移動できる', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a"/><button id="b"/><button id="c"/></group></tab></tabs></ribbon></customUI>`);
    const g = d.querySelector('[id="g"]')!;
    const a = d.querySelector('[id="a"]')!;
    expect(moveElement(a, g, 3)).toBe(true);
    expect(Array.from(g.children).map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('置けない場所へは移動しない', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a"/></group></tab></tabs></ribbon></customUI>`);
    const t = d.querySelector('[id="t"]')!;
    const a = d.querySelector('[id="a"]')!;
    expect(moveElement(a, t, 0)).toBe(false);
  });

  it('複製すると id が振り直される', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="btn1" label="X"/></group></tab></tabs></ribbon></customUI>`);
    const copy = duplicateElement(d.querySelector('[id="btn1"]')!);
    expect(copy.getAttribute('id')).toBe('btn2');
    expect(copy.getAttribute('label')).toBe('X');
    expect(copy.previousElementSibling!.getAttribute('id')).toBe('btn1');
  });
});

describe('コンテキストメニューの作成', () => {
  it('idMso 付きで、項目を1つ持って作られる', () => {
    const d = doc(`<customUI xmlns="${NS}" />`);
    const el = createElement(d, 'contextMenu');
    expect(el.getAttribute('idMso')).toBe('ContextMenuCell');
    expect(el.hasAttribute('id')).toBe(false);
    expect(el.children[0]!.localName).toBe('button');
  });
});

describe('Backstage の作成', () => {
  it('Backstage は タブ・列・グループ・ボタンまで作る', () => {
    const d = doc(`<customUI xmlns="${NS}" />`);
    const el = createElement(d, 'backstage');
    d.documentElement.append(el);
    expect(serialize(d)).toContain('<firstColumn>');
    expect(el.querySelector('topItems > button')).not.toBeNull();
  });

  it('同じ group でも Backstage の中なら Backstage の形で作る', () => {
    const d = doc(`<customUI xmlns="${NS}"><backstage><tab id="t"><firstColumn/></tab></backstage></customUI>`);
    const col = d.querySelector('firstColumn')!;
    const g = createElement(d, 'group', col);
    expect(g.querySelector('topItems')).not.toBeNull();
    const ribbonGroup = createElement(d, 'group');
    expect(ribbonGroup.children.length).toBe(0);
  });
});

const lintCtx = { version: 'office2010' as const, imageIds: new Set<string>(), knownIdMso: new Set<string>(), missingImageMso: new Set<string>() };
const errorsOf = (d: Document) => lint(d, lintCtx).filter((p) => p.severity === 'error').map((p) => p.message);

describe('escapeAttr', () => {
  it('改行・復帰・タブ・> も文字参照にし、読み直すと同じ値に戻る', () => {
    expect(escapeAttr('a\r\n\tb>c<"&')).toBe('a&#13;&#10;&#9;b&gt;c&lt;&quot;&amp;');
    const d = doc(`<customUI xmlns="${NS}" />`);
    d.documentElement.setAttribute('onLoad', 'x\r\n\ty>');
    const back = doc(serialize(d));
    expect(back.documentElement.getAttribute('onLoad')).toBe('x\r\n\ty>');
  });
});

describe('子要素の順序と個数', () => {
  const g = () => doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a"/><dialogBoxLauncher><button id="d"/></dialogBoxLauncher></group></tab></tabs></ribbon></customUI>`).querySelector('group')!;

  it('dialogBoxLauncher は末尾にしか置けず、2つ目は置けない', () => {
    const group = g();
    expect(allowedInsertIndex(group, 'button', 5)).toBe(1);
    expect(allowedInsertIndex(group, 'dialogBoxLauncher', 0)).toBeNull();
    const empty = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a"/></group></tab></tabs></ribbon></customUI>`).querySelector('group')!;
    expect(allowedInsertIndex(empty, 'dialogBoxLauncher', 0)).toBe(1);
  });

  it('移動も順序に収める（ボタンを dialogBoxLauncher の後ろに落としても前に入る）', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a"/><dialogBoxLauncher><button id="d"/></dialogBoxLauncher></group><group id="h"><button id="x"/></group></tab></tabs></ribbon></customUI>`);
    const group = d.querySelector('[id="g"]')!;
    expect(moveElement(d.querySelector('[id="x"]')!, group, 2)).toBe(true);
    expect(Array.from(group.children).map((c) => c.localName)).toEqual(['button', 'button', 'dialogBoxLauncher']);
    expect(errorsOf(d)).toEqual([]);
  });

  it('個数の上限に達しているものは複製できない', () => {
    const group = g();
    expect(canDuplicate(group.querySelector('dialogBoxLauncher')!)).toBe(false);
    expect(canDuplicate(group.querySelector('[id="d"]')!)).toBe(false);
    expect(canDuplicate(group.querySelector('[id="a"]')!)).toBe(true);
    expect(canDuplicate(group.ownerDocument.querySelector('ribbon')!)).toBe(false);
    expect(() => duplicateElement(group.querySelector('dialogBoxLauncher')!)).toThrow();
  });

  it('ensureTabs は qat の後ろ、contextualTabs の前に tabs を作る', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><qat/><contextualTabs/></ribbon></customUI>`);
    ensureTabs(d);
    expect(Array.from(d.querySelector('ribbon')!.children).map((c) => c.localName)).toEqual(['qat', 'tabs', 'contextualTabs']);
  });
});

describe('insertSmart', () => {
  const base = (body = '') => doc(`<customUI xmlns="${NS}"><ribbon><tabs>${body}</tabs></ribbon></customUI>`);

  it('グループを選んでいればその中に、ボタンを選んでいればその後ろに入れる', () => {
    const d = base('<tab id="t"><group id="g"><button id="a"/><button id="b"/></group></tab>');
    const r1 = insertSmart(d, d.querySelector('[id="a"]'), 'button');
    expect('el' in r1 && r1.el.previousElementSibling?.id).toBe('a');
    const r2 = insertSmart(d, d.querySelector('[id="g"]'), 'checkBox');
    expect('el' in r2 && r2.el.parentElement!.lastElementChild).toBe('el' in r2 && r2.el);
  });

  it('ボタンを dialogBoxLauncher より前に入れる', () => {
    const d = base('<tab id="t"><group id="g"><button id="a"/><dialogBoxLauncher><button id="d"/></dialogBoxLauncher></group></tab>');
    const r = insertSmart(d, d.querySelector('[id="g"]'), 'button');
    expect('el' in r).toBe(true);
    expect(Array.from(d.querySelector('[id="g"]')!.children).map((c) => c.localName)).toEqual(['button', 'button', 'dialogBoxLauncher']);
  });

  it('タブを選んでボタンを入れると、そのタブにグループを作る', () => {
    const d = base('<tab id="t"/>');
    const r = insertSmart(d, d.querySelector('tab'), 'button');
    if (!('el' in r)) throw new Error(r.error);
    expect(r.el.parentElement!.localName).toBe('group');
    expect(r.el.parentElement!.parentElement!.id).toBe('t');
  });

  it('何も選んでいなければ、タブとグループを作ってボタンを入れる', () => {
    const d = doc(`<customUI xmlns="${NS}" />`);
    const r = insertSmart(d, null, 'button');
    if (!('el' in r)) throw new Error(r.error);
    expect(pathOf(r.el)).toEqual([0, 0, 0, 0, 0]);
    expect(errorsOf(d)).toEqual([]);
  });

  it('グループは何も選んでいなければ最初の自作タブに入れる', () => {
    const d = base('<tab idMso="TabHome"/><tab id="mine"/>');
    const r = insertSmart(d, null, 'group');
    expect('el' in r && r.el.parentElement!.id).toBe('mine');
  });

  it('置けない場所では理由を返す', () => {
    const d = doc(`<customUI xmlns="${NS}"><contextMenus><contextMenu idMso="ContextMenuCell"/></contextMenus></customUI>`);
    const r = insertSmart(d, d.querySelector('contextMenu'), 'group');
    expect('error' in r && r.error).toContain('グループはタブの中');
    const r2 = insertSmart(d, d.querySelector('contextMenu'), 'dropDown');
    expect('error' in r2 && r2.error).toContain('グループの中に置きます');
  });

  it('Backstage は1つだけ。2007形式では作らない', () => {
    const d = doc(`<customUI xmlns="${NS}"><contextMenus/></customUI>`);
    const r = insertSmart(d, null, 'backstage');
    expect('el' in r).toBe(true);
    expect(Array.from(d.documentElement.children).map((c) => c.localName)).toEqual(['backstage', 'contextMenus']);
    expect('error' in insertSmart(d, null, 'backstage')).toBe(true);
    const old = doc('<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui" />');
    expect('error' in insertSmart(old, null, 'backstage')).toBe(true);
  });

  it('タブはタブ一覧に、コンテキストメニューは一覧に入れる', () => {
    const d = doc(`<customUI xmlns="${NS}" />`);
    const t = insertSmart(d, null, 'tab');
    expect('el' in t && t.el.parentElement!.localName).toBe('tabs');
    const c = insertSmart(d, null, 'contextMenu');
    expect('el' in c && c.el.parentElement!.localName).toBe('contextMenus');
  });

  it('Backstage の menu は menuGroup の中にボタンを作る', () => {
    const d = doc(`<customUI xmlns="${NS}"><backstage><tab id="t"><firstColumn><group id="g"><primaryItem/></group></firstColumn></tab></backstage></customUI>`);
    const r = insertSmart(d, d.querySelector('primaryItem'), 'menu');
    if (!('el' in r)) throw new Error(r.error);
    expect(r.el.firstElementChild!.localName).toBe('menuGroup');
    expect(r.el.querySelector('menuGroup > button')).not.toBeNull();
    expect(errorsOf(d)).toEqual([]);
  });
});

describe('接頭辞つきの文書', () => {
  const MSO = `<mso:customUI xmlns:mso="${NS}"><mso:ribbon><mso:tabs><mso:tab id="t" label="T"/></mso:tabs></mso:ribbon></mso:customUI>`;

  it('作る要素に同じ接頭辞を付け、書き出して読み直しても名前空間が保たれる', () => {
    const d = doc(MSO);
    const r = insertSmart(d, d.getElementsByTagNameNS(NS, 'tab')[0]!, 'button');
    if (!('el' in r)) throw new Error(r.error);
    expect(r.el.tagName).toBe('mso:button');
    const text = serialize(d);
    expect(text).toContain('<mso:group');
    expect(text).toContain('<mso:button');
    const back = doc(text);
    expect(errorsOf(back)).toEqual([]);
  });

  it('ensureTabs と createElement も接頭辞を付ける', () => {
    const d = doc(`<mso:customUI xmlns:mso="${NS}"/>`);
    ensureTabs(d);
    expect(serialize(d)).toContain('<mso:ribbon>');
    expect(createElement(d, 'splitButton').children[0]!.tagName).toBe('mso:button');
  });
});

describe('日本語の id', () => {
  it('ラベルが日本語なら連番、id に日本語を使っても Lint は通る', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="集計タブ" label="T"><group id="グループ1" label="G"><button id="ボタン_合計" onAction="Ribbon_ボタン_合計_onAction"/></group></tab></tabs></ribbon></customUI>`);
    expect(errorsOf(d)).toEqual([]);
  });
});
