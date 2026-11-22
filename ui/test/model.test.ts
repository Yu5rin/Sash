import { describe, expect, it } from 'vitest';
import {
  createElement, duplicateElement, elementAt, ensureTabs, moveElement, parseXml, pathOf, serialize, suggestId,
} from '../src/model';

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
