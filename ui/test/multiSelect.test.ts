// 複数選択とまとめて変更（仕様書 §19）のテスト。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { applyBulkAttr, bulkLabel, bulkValue, commonAttrDefs, kindSummary } from '../src/bulkEdit';
import {
  clipCount, copy, cut, duplicate, moveDisabledReason, moveSelected, moveToNewGroupSelected, newGroupDisabledReason, paste, removeSelected, setSizeSelected,
} from '../src/clipboard';
import { canDropInto, canDropManyAt, drop, draggedCount, endDrag, startDrag } from '../src/dnd';
import { elementAt, parseXml, pathOf, type Path } from '../src/model';
import { attrValueError } from '../src/attrValidate';
import { deleteMany, duplicateMany, moveBlock, moveManyTo, orderViolation, orderViolations, topLevelPaths } from '../src/multiEdit';
import { attributes } from '../src/schema';
import { PartStore, selectMany } from '../src/store';
import { clearToasts } from '../src/shell/toast';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g1" label="G1">
          <button id="b1" label="B1" size="large" />
          <button id="b2" label="B2" size="large" />
          <toggleButton id="tg" label="TG" />
          <button id="b3" label="B3" />
          <dialogBoxLauncher>
            <button id="dl" />
          </dialogBoxLauncher>
        </group>
        <group id="g2" label="G2">
          <button id="c1" label="C1" />
          <button id="c2" label="C2" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

const store = (): PartStore => app.store!;
const p = (id: string): Path => pathOf(store().doc.querySelector(`[id="${id}"]`)!);
const selIds = (): string[] => store().selections.map((x) => elementAt(store().doc, x)!.getAttribute('id') ?? elementAt(store().doc, x)!.localName);
const primaryId = (): string | null => store().selectedElement?.getAttribute('id') ?? null;
const kids = (groupId: string): string[] => Array.from(store().doc.querySelector(`[id="${groupId}"]`)!.children, (e) => e.getAttribute('id') ?? e.localName);

function pick(...ids: string[]): void {
  store().select(p(ids[0]!), 'canvas');
  for (const id of ids.slice(1)) store().toggleSelect(p(id), 'canvas');
}

beforeEach(() => {
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});
afterEach(() => {
  clearToasts();
  endDrag();
});

describe('ストアの複数選択', () => {
  it('select は1つだけにし、toggleSelect で足し引きする（主な選択は最後に足したもの）', () => {
    store().select(p('b1'), 'canvas');
    expect(store().selections).toEqual([p('b1')]);
    expect(store().isMulti).toBe(false);
    store().toggleSelect(p('b3'), 'canvas');
    store().toggleSelect(p('b2'), 'canvas');
    expect(selIds()).toEqual(['b1', 'b2', 'b3']); // 文書の順
    expect(primaryId()).toBe('b2');
    expect(store().isMulti).toBe(true);
    // 主な選択を外すと、残りの最後が主になる
    store().toggleSelect(p('b2'), 'canvas');
    expect(selIds()).toEqual(['b1', 'b3']);
    expect(primaryId()).toBe('b3');
    // 最後の1つまで外すと何も選ばない
    store().toggleSelect(p('b1'), 'canvas');
    store().toggleSelect(p('b3'), 'canvas');
    expect(store().selection).toBeNull();
    expect(store().selections).toEqual([]);
  });

  it('祖先と子孫は一緒に選ばない（足したほうを残す）', () => {
    pick('b1', 'b2');
    store().toggleSelect(p('g1'), 'tree');
    expect(selIds()).toEqual(['g1']);
    store().toggleSelect(p('c1'), 'tree');
    expect(selIds()).toEqual(['g1', 'c1']);
    // 子孫を足すと祖先が外れる
    store().toggleSelect(p('b3'), 'tree');
    expect(selIds()).toEqual(['b3', 'c1']);
  });

  it('selectRange は同じ親なら兄弟の範囲、親が違えば順序の範囲から祖先を外して選ぶ', () => {
    store().select(p('b1'), 'canvas');
    store().selectRange(p('b3'), 'canvas');
    expect(selIds()).toEqual(['b1', 'b2', 'tg', 'b3']);
    expect(primaryId()).toBe('b3');
    // 起点は変わらないので、範囲を縮められる
    store().selectRange(p('b2'), 'canvas');
    expect(selIds()).toEqual(['b1', 'b2']);
    // 親が違う：b3 から c1 まで（間のダイアログ起動ツールの中身と g2 は、祖先なので外れる）
    store().select(p('b3'), 'tree');
    store().selectRange(p('c1'), 'tree');
    expect(selIds()).toEqual(['b3', 'dl', 'c1']);
    // 見えている行の順を渡すと、その中だけで決める（畳んだ中身は選ばない）
    const rows = [p('g1'), p('b3'), p('g2'), p('c1')];
    store().select(p('b3'), 'tree');
    store().selectRange(p('c1'), 'tree', rows);
    expect(selIds()).toEqual(['b3', 'c1']);
  });

  it('selectAll は主な選択の兄弟をすべて選び、clearMulti で主な選択だけに戻す', () => {
    store().select(p('c2'), 'canvas');
    store().selectAll('canvas');
    expect(selIds()).toEqual(['c1', 'c2']);
    expect(primaryId()).toBe('c2');
    expect(store().clearMulti('canvas')).toBe(true);
    expect(selIds()).toEqual(['c2']);
    expect(store().clearMulti('canvas')).toBe(false);
  });

  it('選択の変更は selection の通知を出す', () => {
    const kinds: string[] = [];
    store().subscribe((c) => kinds.push([...c.kinds].join('+')));
    store().select(p('b1'), 'canvas');
    store().toggleSelect(p('b2'), 'canvas');
    store().selectRange(p('b3'), 'canvas');
    store().selectAll('canvas');
    store().clearMulti('canvas');
    expect(kinds).toEqual(['selection', 'selection', 'selection', 'selection', 'selection']);
  });

  it('前への挿入・削除・移動のあとも、同じ要素を選び直す（消えた要素は外す）', () => {
    pick('c1', 'c2');
    // 前のグループのボタンを消すと、パスは変わらないが要素はそのまま
    store().edit('other', (doc) => {
      doc.querySelector('[id="g1"]')!.remove();
      return undefined;
    });
    expect(selIds()).toEqual(['c1', 'c2']);
    // 前に新しいグループを挿入すると、パスがずれても同じ要素を指す
    store().edit('other', (doc) => {
      const tab = doc.querySelector('tab')!;
      const g = doc.createElementNS(NS, 'group');
      g.setAttribute('id', 'gNew');
      tab.insertBefore(g, tab.firstElementChild);
      return undefined;
    });
    expect(selIds()).toEqual(['c1', 'c2']);
    expect(primaryId()).toBe('c2');
    // 選んでいる要素の1つを消すと、それだけ外れる
    store().edit('other', (doc) => {
      doc.querySelector('[id="c1"]')!.remove();
      return undefined;
    });
    expect(selIds()).toEqual(['c2']);
  });

  it('元に戻す・やり直しで、選んでいた組も戻る', () => {
    pick('b1', 'b2', 'b3');
    store().edit('other', (doc) => {
      doc.querySelector('[id="c1"]')!.setAttribute('label', 'X');
      return p('c1');
    }, 'x');
    expect(selIds()).toEqual(['c1']);
    store().undo();
    expect(selIds()).toEqual(['b1', 'b2', 'b3']);
    expect(primaryId()).toBe('b3');
    store().redo();
    expect(selIds()).toEqual(['c1']);
    store().goTo(0);
    expect(selIds()).toEqual(['b1', 'b2', 'b3']);
  });

  it('edit の fn が selectMany を返すと、その組を選ぶ', () => {
    store().edit('other', () => selectMany([p('c1'), p('b1')], p('b1')), 'sel');
    expect(selIds()).toEqual(['b1', 'c1']);
    expect(primaryId()).toBe('b1');
  });

  it('XML を書き換えて指せなくなった選択は外す', () => {
    pick('c1', 'c2');
    store().setText(store().text.replace(/<group id="g2"[\s\S]*?<\/group>/, ''));
    expect(store().selections).toEqual([]);
    expect(store().selection).toBeNull();
  });
});

describe('インスペクタのまとめて変更（bulkEdit）', () => {
  it('共通の属性だけを出す（id・idMso・image と get 系は出さない）', () => {
    pick('b1', 'tg');
    const names = commonAttrDefs(store().selectedElements).map((d) => d.name);
    expect(names).toContain('size');
    expect(names).toContain('label');
    expect(names).toContain('imageMso');
    expect(names).toContain('onAction');
    expect(names).not.toContain('id');
    expect(names).not.toContain('idMso');
    expect(names).not.toContain('image');
    expect(names).not.toContain('getLabel');
    // トグルボタンにしかない getPressed は出さない
    expect(names).not.toContain('getPressed');
  });

  it('値がそろっていればその値、違えば「複数の値」として違う値の一覧を返す', () => {
    const size = attributes.get('size')!;
    pick('b1', 'b2');
    expect(bulkValue(store().selectedElements, size)).toEqual({ mixed: false, value: 'large' });
    pick('b1', 'b3');
    expect(bulkValue(store().selectedElements, size)).toEqual({ mixed: true, values: ['large', ''] });
    // 真偽値の 1 / 0 は true / false とそろえて比べる
    store().edit('other', (doc) => {
      doc.querySelector('[id="b1"]')!.setAttribute('showLabel', '0');
      doc.querySelector('[id="b3"]')!.setAttribute('showLabel', 'false');
      return undefined;
    });
    expect(bulkValue(store().selectedElements, attributes.get('showLabel')!)).toEqual({ mixed: false, value: 'false' });
  });

  it('applyBulkAttr はすべてに入れ、静的な値を入れたら組の get 系と別の種類のアイコンを外す', () => {
    const d = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a" getLabel="L" image="img" /><button id="b" label="x" /></group></tab></tabs></ribbon></customUI>`);
    if (!d.ok) throw new Error(d.message);
    const els = Array.from(d.doc.querySelectorAll('button'));
    expect(applyBulkAttr(els, attributes.get('label')!, 'Run')).toBe(2);
    expect(els.map((e) => e.getAttribute('label'))).toEqual(['Run', 'Run']);
    expect(els[0]!.hasAttribute('getLabel')).toBe(false);
    expect(applyBulkAttr(els, attributes.get('imageMso')!, 'FileSave')).toBe(2);
    expect(els[0]!.hasAttribute('image')).toBe(false);
    // 変わらなければ 0
    expect(applyBulkAttr(els, attributes.get('label')!, 'Run')).toBe(0);
    expect(applyBulkAttr(els, attributes.get('label')!, null)).toBe(2);
    expect(els.every((e) => !e.hasAttribute('label'))).toBe(true);
  });

  it('種類の内訳と履歴の名前', () => {
    pick('b1', 'b2', 'tg', 'b3');
    expect(kindSummary(store().selectedElements)).toBe('ボタン 3・トグルボタン 1');
    expect(bulkLabel(6, 'size', 'large')).toBe('6 個の size を large に変更');
    expect(bulkLabel(2, 'label', null)).toBe('2 個の label を削除');
  });

  it('size の一括変更は一度の編集で、size のない要素は飛ばす', () => {
    pick('b1', 'b2', 'b3', 'g2');
    expect(setSizeSelected('normal')).toBe(true);
    expect(store().undoLabel).toBe('3 個の size を normal に変更');
    for (const id of ['b1', 'b2', 'b3']) expect(store().doc.querySelector(`[id="${id}"]`)!.getAttribute('size')).toBe('normal');
    // 選択は保つ
    expect(selIds()).toEqual(['b1', 'b2', 'b3', 'g2']);
    store().undo();
    expect(store().doc.querySelector('[id="b1"]')!.getAttribute('size')).toBe('large');
    expect(store().canUndo).toBe(false);
  });
});

describe('まとめての操作（clipboard）', () => {
  it('まとめて削除は一度の編集で、元に戻すと選択も戻る', () => {
    pick('b1', 'tg', 'c2');
    expect(removeSelected()).toBe(true);
    expect(kids('g1')).toEqual(['b2', 'b3', 'dialogBoxLauncher']);
    expect(kids('g2')).toEqual(['c1']);
    expect(store().undoLabel).toBe('3 個の要素を削除');
    // 削除のあとは、最後に消した要素の後ろ（なければ前）の兄弟を選ぶ
    expect(primaryId()).toBe('c1');
    store().undo();
    expect(kids('g1')).toEqual(['b1', 'b2', 'tg', 'b3', 'dialogBoxLauncher']);
    expect(selIds()).toEqual(['b1', 'tg', 'c2']);
  });

  it('まとめてコピーと貼り付け：文書の順で、選択の後ろに続けて入れ、id を振り直す', () => {
    pick('b2', 'b1');
    expect(copy()).toBe(true);
    expect(clipCount()).toBe(2);
    store().select(p('c1'), 'canvas');
    expect(paste()).toBe(true);
    expect(kids('g2')).toEqual(['c1', 'b4', 'b5', 'c2']);
    expect(store().undoLabel).toBe('2 個の要素を貼り付け');
    expect(selIds()).toEqual(['b4', 'b5']);
    const labels = Array.from(store().doc.querySelectorAll('[id="g2"] > *'), (e) => e.getAttribute('label'));
    expect(labels).toEqual(['C1', 'B1', 'B2', 'C2']);
  });

  it('まとめて切り取りと貼り付け（元に戻す・やり直し）', () => {
    pick('b1', 'b2');
    expect(cut()).toBe(true);
    expect(kids('g1')).toEqual(['tg', 'b3', 'dialogBoxLauncher']);
    expect(store().undoLabel).toBe('2 個の要素を切り取り');
    store().select(p('c2'), 'canvas');
    expect(paste()).toBe(true);
    // id が空いたので、元の id のまま入る
    expect(kids('g2')).toEqual(['c1', 'c2', 'b1', 'b2']);
    store().undo();
    store().undo();
    expect(kids('g1')).toEqual(['b1', 'b2', 'tg', 'b3', 'dialogBoxLauncher']);
    store().redo();
    store().redo();
    expect(kids('g2')).toEqual(['c1', 'c2', 'b1', 'b2']);
  });

  it('1つでも置けないものがあれば、何も貼り付けない', () => {
    pick('b1', 'g2');
    copy();
    store().select(p('c1'), 'canvas');
    // 置き場所は最初の要素（ボタン）で決まり、c1 の後ろになる。そこへグループは置けないので、ボタンも貼り付けない
    const before = store().text;
    expect(paste()).toBe(false);
    expect(store().text).toBe(before);
  });

  it('まとめて複製：親ごとに、選んだ最後の要素の後ろへ元の順で並べる', () => {
    pick('b1', 'b3', 'c1');
    expect(duplicate()).toBe(true);
    expect(kids('g1')).toEqual(['b1', 'b2', 'tg', 'b3', 'b4', 'b5', 'dialogBoxLauncher']);
    expect(kids('g2')).toEqual(['c1', 'c3', 'c2']);
    expect(selIds()).toEqual(['b4', 'b5', 'c3']);
    expect(store().undoLabel).toBe('3 個の要素を複製');
  });

  it('複製できないもの（ダイアログ起動ツール）が混ざっていれば断る', () => {
    store().select(p('b1'), 'canvas');
    store().toggleSelect(pathOf(store().doc.querySelector('dialogBoxLauncher')!), 'canvas');
    const before = store().text;
    expect(duplicate()).toBe(false);
    expect(store().text).toBe(before);
  });

  it('まとめて上下に動かす（同じ親のときだけ）', () => {
    pick('b2', 'b3');
    expect(moveDisabledReason(-1)).toBeNull();
    expect(moveSelected(-1)).toBe(true);
    expect(kids('g1')).toEqual(['b2', 'b1', 'b3', 'tg', 'dialogBoxLauncher']);
    expect(selIds()).toEqual(['b2', 'b3']);
    expect(primaryId()).toBe('b3');
    expect(store().undoLabel).toBe('2 個の要素を上へ移動');
    // 下へ：b3 は tg と入れ替わって元に戻る。その下はダイアログ起動ツールなので、それ以上は動かせない
    expect(moveSelected(1)).toBe(true);
    expect(kids('g1')).toEqual(['b1', 'b2', 'tg', 'b3', 'dialogBoxLauncher']);
    expect(moveSelected(1)).toBe(false);
    expect(moveDisabledReason(1)).toMatch(/置けません/);
    // 先頭からは上へ動かせない
    pick('b1', 'b2');
    expect(moveDisabledReason(-1)).toBe('これより上には動かせません');
    // 親が違えば理由を出す
    pick('b1', 'c1');
    expect(moveDisabledReason(-1)).toBe('親の違う要素はまとめて上下に動かせません');
    expect(moveSelected(-1)).toBe(false);
  });

  it('新しいグループに移す：最後の要素のグループの後ろにグループを作って移す', () => {
    pick('b2', 'tg', 'c1');
    expect(newGroupDisabledReason()).toBeNull();
    expect(moveToNewGroupSelected()).toBe(true);
    const groups = Array.from(store().doc.querySelectorAll('tab > group'), (g) => g.getAttribute('id'));
    expect(groups).toHaveLength(3);
    expect(groups.slice(0, 2)).toEqual(['g1', 'g2']);
    const newId = groups[2]!;
    expect(kids(newId)).toEqual(['b2', 'tg', 'c1']);
    expect(selIds()).toEqual(['b2', 'tg', 'c1']);
    expect(store().undoLabel).toBe('3 個の要素を新しいグループに移動');
    store().undo();
    expect(store().doc.querySelectorAll('tab > group')).toHaveLength(2);
    // グループの中ではないもの（グループ自体）は移せない
    pick('g1', 'g2');
    expect(newGroupDisabledReason()).toBe('リボンのグループの中のコントロールを選ぶと使えます');
  });
});

describe('multiEdit の純粋な操作', () => {
  function d(): Document {
    const r = parseXml(XML);
    if (!r.ok) throw new Error(r.message);
    return r.doc;
  }
  const q = (doc: Document, id: string) => pathOf(doc.querySelector(`[id="${id}"]`)!);

  it('topLevelPaths は重なりと子孫を外して文書の順に並べる', () => {
    expect(topLevelPaths([[0, 0, 1], [0, 0], [0, 0, 1], [0, 1]])).toEqual([[0, 0], [0, 1]]);
  });

  it('deleteMany は次に選ぶ要素を返す', () => {
    const doc = d();
    const next = deleteMany(doc, [q(doc, 'c1'), q(doc, 'c2')]);
    // 兄弟がなければ親
    expect(elementAt(doc, next!)!.getAttribute('id')).toBe('g2');
  });

  it('duplicateMany と moveBlock のあとも並び順の決まりを守る', () => {
    const doc = d();
    const r = duplicateMany(doc, [q(doc, 'b3')]);
    expect('paths' in r).toBe(true);
    expect(orderViolation(doc.querySelector('[id="g1"]')!)).toBeNull();
    const m = moveBlock(doc, [q(doc, 'b3'), q(doc, 'b4')], 1);
    expect('error' in m).toBe(true);
  });

  it('moveManyTo はグループの末尾に落としても、ダイアログ起動ツールの前に入れる', () => {
    const doc = d();
    const g1 = doc.querySelector('[id="g1"]')!;
    const r = moveManyTo(doc, [q(doc, 'c1'), q(doc, 'c2')], g1, g1.children.length);
    expect('paths' in r).toBe(true);
    expect(Array.from(g1.children, (e) => e.getAttribute('id') ?? e.localName)).toEqual(['b1', 'b2', 'tg', 'b3', 'c1', 'c2', 'dialogBoxLauncher']);
    // 自分の中へは移せない
    const bad = moveManyTo(doc, [q(doc, 'g1'), q(doc, 'g2')], doc.querySelector('[id="g2"]')!, 0);
    expect('error' in bad).toBe(true);
  });
});

describe('まとめてのドラッグ＆ドロップ（dnd）', () => {
  const fakeDrag = { dataTransfer: null } as unknown as DragEvent;

  it('選んでいる要素の1つをつかむと、まとめて運んで別のグループへ落とせる', () => {
    pick('b1', 'b3');
    startDrag(fakeDrag, { kind: 'move', path: p('b3') });
    expect(draggedCount()).toBe(2);
    const g2 = store().doc.querySelector('[id="g2"]')!;
    expect(canDropInto(store().doc, g2)).toBe(true);
    expect(canDropManyAt(store().doc, pathOf(g2), 1)).toBe(true);
    drop(pathOf(g2), 1, 'canvas');
    expect(kids('g2')).toEqual(['c1', 'b1', 'b3', 'c2']);
    expect(kids('g1')).toEqual(['b2', 'tg', 'dialogBoxLauncher']);
    expect(selIds()).toEqual(['b1', 'b3']);
    expect(primaryId()).toBe('b3');
    expect(store().undoLabel).toBe('2 個の要素を移動');
    store().undo();
    expect(kids('g1')).toEqual(['b1', 'b2', 'tg', 'b3', 'dialogBoxLauncher']);
  });

  it('選んでいない要素をつかんだら、その1つだけを運ぶ', () => {
    pick('b1', 'b3');
    startDrag(fakeDrag, { kind: 'move', path: p('c1') });
    expect(draggedCount()).toBe(1);
  });

  it('1つでも置けなければ、何も動かさない', () => {
    pick('b1', 'g2');
    startDrag(fakeDrag, { kind: 'move', path: p('b1') });
    const g1 = store().doc.querySelector('[id="g1"]')!;
    // グループはグループの中に入れられない
    expect(canDropInto(store().doc, g1)).toBe(false);
    const before = store().text;
    drop(pathOf(g1), 0, 'tree');
    expect(store().text).toBe(before);
    // 運ぶ要素の中へは落とせない
    pick('b1', 'b2');
    startDrag(fakeDrag, { kind: 'move', path: p('b1') });
    expect(canDropManyAt(store().doc, p('b1'), 0)).toBe(false);
  });
});

describe('レビューの指摘の修正（仕様書 §19）', () => {
  function docOf(xml: string): Document {
    const r = parseXml(xml);
    if (!r.ok) throw new Error(r.message);
    return r.doc;
  }
  const q = (doc: Document, id: string) => pathOf(doc.querySelector(`[id="${id}"]`)!);
  const ids = (el: Element) => Array.from(el.children, (e) => e.getAttribute('id') ?? e.localName);

  it('selectRange：見えている行の順を渡すと、同じ親でも隠れている兄弟は選ばない', () => {
    // ツリーを絞り込んで b1 と b3 だけが見えている状態（b2・tg は隠れている）
    const rows = [p('t'), p('g1'), p('b1'), p('b3')];
    store().select(p('b1'), 'tree');
    store().selectRange(p('b3'), 'tree', rows);
    expect(selIds()).toEqual(['b1', 'b3']);
    expect(primaryId()).toBe('b3');
    // 順を渡さなければ、これまでどおり間の兄弟をすべて選ぶ
    store().select(p('b1'), 'canvas');
    store().selectRange(p('b3'), 'canvas');
    expect(selIds()).toEqual(['b1', 'b2', 'tg', 'b3']);
  });

  it('selectAll：見えている要素を渡すと、その中の兄弟だけを選ぶ（続く削除で隠れた要素を消さない）', () => {
    store().select(p('b1'), 'tree');
    store().selectAll('tree', [p('g1'), p('b1'), p('b3')]);
    expect(selIds()).toEqual(['b1', 'b3']);
    removeSelected('tree');
    expect(kids('g1')).toEqual(['b2', 'tg', 'dialogBoxLauncher']);
    // 主な選択が渡した中になくても、主な選択は残す
    store().select(p('c1'), 'tree');
    store().selectAll('tree', [p('c2')]);
    expect(selIds()).toEqual(['c1', 'c2']);
  });

  it('編集のあとで指せなくなったパスは selections から外し、主な選択もそろえる', () => {
    pick('c1', 'c2');
    // 主な選択（c2、g2 の最後の子）を消す編集。選択は変えない（undefined を返す）
    store().edit('canvas', (doc) => {
      doc.querySelector('[id="c2"]')!.remove();
    });
    expect(selIds()).toEqual(['c1']);
    expect(primaryId()).toBe('c1');
    expect(store().selections.every((x) => elementAt(store().doc, x) !== null)).toBe(true);
    // 編集が指せないパスを返しても、それは選ばない
    store().edit('canvas', (doc) => {
      doc.querySelector('[id="c1"]')!.setAttribute('label', 'X');
      return selectMany([p('b1'), [0, 0, 0, 9, 9]], [0, 0, 0, 9, 9]);
    });
    expect(selIds()).toEqual(['b1']);
    expect(primaryId()).toBe('b1');
  });

  it('orderViolation：操作の前から並び順の崩れた親でも、新しい崩れがなければ断らない', () => {
    const doc = docOf(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T">
      <group id="g" label="G"><button id="a" /><dialogBoxLauncher><button id="dl" /></dialogBoxLauncher><button id="z" /><foo id="u" /></group>
      <group id="h" label="H"><button id="m" /></group>
    </tab></tabs></ribbon></customUI>`);
    const g = doc.querySelector('[id="g"]')!;
    // 位置のずれたダイアログ起動ツール・後ろのボタン・知らない要素が、もとから決まりに合っていない
    expect(orderViolation(g)).not.toBeNull();
    const before = new Set(orderViolations(g));
    expect(orderViolation(g, before)).toBeNull();
    // そこへの複製・移動は、新しい崩れがなければ通す
    const dup = duplicateMany(doc, [q(doc, 'a')]);
    expect('paths' in dup).toBe(true);
    expect(ids(g)).toHaveLength(5);
    expect([ids(g)[0], ids(g)[2], ids(g)[3], ids(g)[4]]).toEqual(['a', 'dialogBoxLauncher', 'z', 'u']);
    const mv = moveManyTo(doc, [q(doc, 'm')], g, 0);
    expect('paths' in mv).toBe(true);
    expect(ids(g)[0]).toBe('m');
    // 動かした要素が決まりに合わない（新しい崩れになる）なら、これまでどおり断る（ダイアログ起動ツールを 2 つにする）
    const doc2 = docOf(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T">
      <group id="g" label="G"><dialogBoxLauncher><button id="d1" /></dialogBoxLauncher><foo id="u" /></group>
      <group id="h" label="H"><dialogBoxLauncher><button id="d2" /></dialogBoxLauncher></group>
    </tab></tabs></ribbon></customUI>`);
    const bad = moveManyTo(doc2, [pathOf(doc2.querySelector('[id="h"] > dialogBoxLauncher')!)], doc2.querySelector('[id="g"]')!, 0);
    expect('error' in bad).toBe(true);
  });

  it('duplicateMany：並び順の決まりのある親では、1つずつ置ける位置に収める（dropDown の item と button）', () => {
    const doc = docOf(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G">
      <dropDown id="dd" label="D"><item id="i1" /><item id="i2" /><button id="k1" /><button id="k2" /></dropDown>
    </group></tab></tabs></ribbon></customUI>`);
    const dd = doc.querySelector('[id="dd"]')!;
    const r = duplicateMany(doc, [q(doc, 'i1'), q(doc, 'k1')]);
    expect('paths' in r).toBe(true);
    const tags = Array.from(dd.children, (e) => e.localName);
    expect(tags).toEqual(['item', 'item', 'item', 'button', 'button', 'button']);
    // item の複製は item の最後に、button の複製は選んだ button（k1）の後ろに入る
    expect(ids(dd)[0]).toBe('i1');
    expect(ids(dd)[1]).toBe('i2');
    expect(ids(dd)[3]).toBe('k1');
    expect(ids(dd)[5]).toBe('k2');
    expect(orderViolation(dd)).toBeNull();
    // 置ける位置なら、これまでどおり選んだ要素の最後の後ろにまとめて置く（A B → A B A' B'）
    const doc2 = docOf(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G">
      <dropDown id="dd" label="D"><item id="i1" /><item id="i2" /><item id="i3" /><button id="k1" /></dropDown>
    </group></tab></tabs></ribbon></customUI>`);
    const dd2 = doc2.querySelector('[id="dd"]')!;
    const r2 = duplicateMany(doc2, [q(doc2, 'i1'), q(doc2, 'i2')]);
    expect('paths' in r2).toBe(true);
    const copies = (r2 as { paths: Path[] }).paths.map((x) => elementAt(doc2, x)!);
    expect(Array.from(dd2.children).indexOf(copies[0]!)).toBe(2);
    expect(Array.from(dd2.children).indexOf(copies[1]!)).toBe(3);
    expect(ids(dd2).slice(4)).toEqual(['i3', 'k1']);
  });

  it('attrValueError：コールバック名・整数・keytip の長さを確かめる（単独とまとめてで共通）', () => {
    expect(attrValueError(attributes.get('onAction')!, '1 bad name!')).toBe('VBA の Sub 名として使えない文字があります');
    expect(attrValueError(attributes.get('onAction')!, 'Module1.OnRun')).toBeNull();
    expect(attrValueError(attributes.get('onAction')!, '')).toBeNull();
    expect(attrValueError({ name: 'columns', kind: 'int' }, '1e')).toBe('0 以上の整数で入力してください');
    expect(attrValueError({ name: 'columns', kind: 'int' }, '3')).toBeNull();
    expect(attrValueError(attributes.get('keytip')!, 'ABCD')).toBe('keytip は3文字以内で指定してください');
    expect(attrValueError(attributes.get('keytip')!, 'ZY')).toBeNull();
  });
});
