import { describe, expect, it } from 'vitest';
import { applyImport, callbackUses, flatten, listCandidates, normalizePicks, planImages, previewIdRenames, usedImageIds } from '../src/ribbonImport';
import { parseXml } from '../src/model';
import { PartStore } from '../src/store';

// 別のブックから取り込む（仕様書 §23.3）

const NS10 = 'http://schemas.microsoft.com/office/2009/07/customui';
const NS07 = 'http://schemas.microsoft.com/office/2006/01/customui';

const SOURCE = `<customUI xmlns="${NS10}">
  <ribbon>
    <tabs>
      <tab id="tabA" label="経理">
        <group id="grpSum" label="月次">
          <button id="btnSum" label="集計" image="logo" onAction="Ribbon_btnSum_onAction"/>
          <button id="btnClose" label="締め" imageMso="LockCell" onAction="Ribbon_btnClose_onAction"/>
        </group>
        <group id="grpOut" label="出力"><button id="btnPdf" label="PDF" onAction="Ribbon_btnPdf_onAction"/></group>
      </tab>
      <tab idMso="TabHome"><group id="grpHome" label="よく使う"><button id="btnQuick" label="速い" onAction="Quick"/></group></tab>
    </tabs>
    <contextualTabs><tabSet idMso="TabSetChartTools"><tab id="tabChart" label="図"/></tabSet></contextualTabs>
  </ribbon>
  <backstage><tab id="bsTab" label="情報"/></backstage>
  <contextMenus><contextMenu idMso="ContextMenuCell"><button id="ctx1" label="メニュー" onAction="Ctx"/></contextMenu></contextMenus>
</customUI>`;

const TARGET = `<customUI xmlns="${NS10}"><ribbon><tabs><tab id="tabMine" label="自分"><group id="grpSum" label="既存"><button id="btnSum" label="既存ボタン"/></group></tab><tab idMso="TabHome"/></tabs></ribbon></customUI>`;

const parse = (xml: string): Document => {
  const r = parseXml(xml);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
};
const src = () => parse(SOURCE);
const logo = 'data:image/png;base64,AAAA';

function target(xml = TARGET, images: { id: string; dataUrl: string }[] = []): PartStore {
  return new PartStore('office2010', xml, images.map((i) => ({ ...i, isNew: false })));
}

describe('listCandidates', () => {
  it('タブ（中にグループ）・コンテキストタブ・右クリックメニュー・Backstage を挙げる', () => {
    const list = listCandidates(src(), target().doc);
    expect(list.map((c) => `${c.kind}:${c.title}`)).toEqual(['tab:経理', 'tab:TabHome', 'tabSet:TabSetChartTools', 'contextMenu:ContextMenuCell', 'backstage:Backstage']);
    expect(list[0]!.children.map((g) => g.title)).toEqual(['月次', '出力']);
    expect(list[0]!.detail).toBe('tabA');
    expect(flatten(list)).toHaveLength(8);
  });

  it('2007 形式の文書には、Backstage と右クリックメニューを取り込めない（理由つき）', () => {
    const t07 = target(`<customUI xmlns="${NS07}"><ribbon><tabs/></ribbon></customUI>`);
    const list = listCandidates(src(), t07.doc);
    expect(list.find((c) => c.kind === 'backstage')!.disabledReason).toContain('2007');
    expect(list.find((c) => c.kind === 'contextMenu')!.disabledReason).toContain('2007');
    expect(list.find((c) => c.kind === 'tab')!.disabledReason).toBeUndefined();
  });

  it('取り込み先にすでに Backstage があれば、Backstage は取り込めない', () => {
    const withBs = target(`<customUI xmlns="${NS10}"><ribbon><tabs/></ribbon><backstage/></customUI>`);
    expect(listCandidates(src(), withBs.doc).find((c) => c.kind === 'backstage')!.disabledReason).toContain('Backstage');
  });
});

describe('normalizePicks', () => {
  it('タブを選んでいれば、その中のグループは外す（二重に取り込まない）。取り込めないものも外す', () => {
    const list = listCandidates(src(), target().doc);
    const all = flatten(list);
    const key = (title: string) => all.find((c) => c.title === title)!.key;
    const picks = normalizePicks(all, new Set([key('経理'), key('月次'), key('出力'), key('よく使う')]));
    expect(picks.map((c) => c.title)).toEqual(['経理', 'よく使う']);
    const tab = all.find((c) => c.title === '経理')!;
    expect(normalizePicks([{ ...tab, disabledReason: '不可' }], new Set([tab.key]))).toEqual([]);
  });
});

describe('planImages', () => {
  it('なければ足し、同じ中身なら使い回し、同じ id で違う中身なら番号を付ける', () => {
    const plan = planImages(['a', 'b', 'c', 'x'], new Map([['a', 'A'], ['b', 'B'], ['c', 'C']]), new Map([['b', 'B'], ['c', 'OTHER'], ['c_2', 'Z']]));
    expect(plan.add).toEqual([{ id: 'a', dataUrl: 'A' }, { id: 'c_3', dataUrl: 'C' }]);
    expect(plan.map.get('b')).toBe('b');
    expect(plan.map.get('c')).toBe('c_3');
    expect(plan.renamed).toEqual([['c', 'c_3']]);
    expect(plan.missing).toEqual(['x']);
  });
});

describe('usedImageIds・callbackUses', () => {
  it('部品の中の image 属性とコールバックを集める', () => {
    const tab = listCandidates(src(), target().doc)[0]!;
    const el = src().documentElement.querySelector('[id="tabA"]')!;
    expect(tab.key).toBe('0.0.0');
    expect(usedImageIds([el])).toEqual(['logo']);
    expect(callbackUses([el]).map((u) => `${u.id}.${u.attr}=${u.name}`)).toEqual(['btnSum.onAction=Ribbon_btnSum_onAction', 'btnClose.onAction=Ribbon_btnClose_onAction', 'btnPdf.onAction=Ribbon_btnPdf_onAction']);
  });
});

describe('applyImport', () => {
  const pick = (store: PartStore, doc: Document, title: string) => flatten(listCandidates(doc, store.doc)).find((c) => c.title === title)!;
  const opts = { renameIds: true, groupTarget: 'new' as const };

  it('タブを取り込む：id の重なりを振り直し、画像を運び、使うコールバックを返す。1 回の元に戻すで戻る', () => {
    const store = target();
    const doc = src();
    const out = applyImport(store, { doc, images: new Map([['logo', logo]]) }, [pick(store, doc, '経理')], opts)!;
    expect(out).not.toBeNull();
    const text = store.text;
    expect(text).toContain('id="tabA"');
    // 取り込み先の grpSum・btnSum と重なるので振り直す
    expect(out.renamedIds).toEqual([['grpSum', 'grpSum2'], ['btnSum', 'btnSum2']]);
    expect(text).toContain('id="grpSum2"');
    expect(text).toContain('id="btnSum2"');
    expect(text).toContain('id="btnSum" label="既存ボタン"');
    expect(out.addedImages).toEqual(['logo']);
    expect(store.images.get('logo')?.dataUrl).toBe(logo);
    expect(store.dirty).toBe(true);
    expect(out.callbacks.map((c) => c.name)).toEqual(['Ribbon_btnSum_onAction', 'Ribbon_btnClose_onAction', 'Ribbon_btnPdf_onAction']);
    expect(out.callbacks[0]!.uses).toEqual(['btnSum2.onAction']);
    expect(out.added).toHaveLength(1);
    expect(store.selection).toEqual(out.added[0]);
    store.undo();
    expect(store.text).toBe(TARGET);
    expect(store.images.size).toBe(0);
  });

  it('同じ id で違う中身の画像があれば、番号を付けて運び、ボタンの image も付け替える', () => {
    const store = target(TARGET, [{ id: 'logo', dataUrl: 'data:image/png;base64,ZZZZ' }]);
    const doc = src();
    const out = applyImport(store, { doc, images: new Map([['logo', logo]]) }, [pick(store, doc, '経理')], opts)!;
    expect(out.renamedImages).toEqual([['logo', 'logo_2']]);
    expect(store.images.get('logo')?.dataUrl).toBe('data:image/png;base64,ZZZZ');
    expect(store.images.get('logo_2')?.dataUrl).toBe(logo);
    expect(store.text).toContain('image="logo_2"');
  });

  it('取り込み元に画像がなければ（.xml だけを読んだとき）、参照はそのまま残し、missing に挙げる', () => {
    const store = target();
    const doc = src();
    const out = applyImport(store, { doc, images: new Map() }, [pick(store, doc, '経理')], opts)!;
    expect(out.missingImages).toEqual(['logo']);
    expect(store.text).toContain('image="logo"');
  });

  it('グループ：選んだタブへ足す／新しいタブを作って足す', () => {
    const store = target();
    const doc = src();
    const g = pick(store, doc, '出力');
    const mine = [0, 0, 0, 0];
    const out = applyImport(store, { doc, images: new Map() }, [g], { renameIds: true, groupTarget: [0, 0, 0] })!;
    expect(out.added).toHaveLength(1);
    const tab = store.doc.querySelector('[id="tabMine"]')!;
    expect(Array.from(tab.children).map((c) => c.getAttribute('id'))).toEqual(['grpSum', 'grpOut']);
    expect(mine).toBeTruthy();

    const store2 = target();
    applyImport(store2, { doc, images: new Map() }, [pick(store2, doc, '出力'), pick(store2, doc, '月次')], opts);
    const tabs = Array.from(store2.doc.querySelectorAll('tabs > tab'));
    expect(tabs).toHaveLength(3);
    const created = tabs.find((x) => x.getAttribute('label') === '取り込んだグループ')!;
    // 2 つのグループが同じ新しいタブに入る
    expect(Array.from(created.children).map((c) => c.getAttribute('label'))).toEqual(['出力', '月次']);
  });

  it('同じ idMso のタブ（TabHome）は 2 つ置かず、既存のタブへグループを足す', () => {
    const store = target();
    const doc = src();
    const out = applyImport(store, { doc, images: new Map() }, [pick(store, doc, 'TabHome')], opts)!;
    expect(out.mergedInto).toEqual(['TabHome']);
    expect(store.doc.querySelectorAll('tab[idMso="TabHome"]')).toHaveLength(1);
    expect(store.doc.querySelector('tab[idMso="TabHome"] > group')!.getAttribute('id')).toBe('grpHome');
  });

  it('id の振り直しを切ると、重なった id がそのまま入る', () => {
    const store = target();
    const doc = src();
    const out = applyImport(store, { doc, images: new Map() }, [pick(store, doc, '月次')], { renameIds: false, groupTarget: [0, 0, 0] })!;
    expect(out.renamedIds).toEqual([]);
    expect(store.doc.querySelectorAll('[id="grpSum"]')).toHaveLength(2);
  });

  it('コンテキストタブ・右クリックメニュー・Backstage を、なければ入れ物ごと作って取り込む', () => {
    const store = target();
    const doc = src();
    const out = applyImport(store, { doc, images: new Map() }, [pick(store, doc, 'TabSetChartTools'), pick(store, doc, 'ContextMenuCell'), pick(store, doc, 'Backstage')], opts)!;
    expect(out.added).toHaveLength(3);
    expect(store.doc.querySelector('ribbon > contextualTabs > tabSet')).not.toBeNull();
    expect(store.doc.querySelector('customUI > contextMenus > contextMenu[idMso="ContextMenuCell"]')).not.toBeNull();
    expect(store.doc.querySelector('customUI > backstage > tab')).not.toBeNull();
    // 要素の順序は customUI の決まり（ribbon → backstage → contextMenus）に収まる
    expect(Array.from(store.doc.documentElement.children).map((c) => c.localName)).toEqual(['ribbon', 'backstage', 'contextMenus']);
  });

  it('2007 形式のブックから取り込んでも、取り込み先の名前空間で入る', () => {
    const store = target();
    const doc = parse(`<customUI xmlns="${NS07}"><ribbon><tabs><tab id="old" label="旧"><group id="g7" label="G"><button id="b7" label="B"/></group></tab></tabs></ribbon></customUI>`);
    applyImport(store, { doc, images: new Map() }, [pick(store, doc, '旧')], opts);
    const el = store.doc.querySelector('[id="old"]')!;
    expect(el.namespaceURI).toBe(NS10);
    expect(el.querySelector('button')!.namespaceURI).toBe(NS10);
  });

  it('構文エラー中は取り込まず null', () => {
    const store = target();
    store.setText('<customUI');
    const doc = src();
    expect(applyImport(store, { doc, images: new Map() }, [pick(target(), doc, '経理')], opts)).toBeNull();
  });

  it('previewIdRenames は文書を変えずに、振り直しを見積もる', () => {
    const store = target();
    const doc = src();
    const before = store.text;
    expect(previewIdRenames(store.doc, doc, [pick(store, doc, '経理')])).toEqual([['grpSum', 'grpSum2'], ['btnSum', 'btnSum2']]);
    expect(store.text).toBe(before);
    expect(store.doc.querySelectorAll('[id="grpSum2"]')).toHaveLength(0);
  });
});
