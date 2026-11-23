import { describe, expect, it, vi } from 'vitest';
import { historyRows } from '../src/dialogs/historyDialog';
import { PartStore } from '../src/store';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">\n  <ribbon>\n    <tabs>\n      <tab id="t" label="T">\n        <group id="g" label="G">\n          <button id="b" label="0" />\n        </group>\n      </tab>\n    </tabs>\n  </ribbon>\n</customUI>\n`;

function storeWithEdits(n: number): PartStore {
  const s = new PartStore('office2010', XML, []);
  for (let i = 1; i <= n; i++) s.edit('inspector', (doc) => void doc.querySelector('button')!.setAttribute('label', String(i)), `ラベル ${i}`);
  return s;
}

const label = (s: PartStore) => s.doc.querySelector('button')!.getAttribute('label');

describe('操作の履歴', () => {
  it('古い順の名前と、今いる位置を返す（やり直せるものも並ぶ）', () => {
    const s = storeWithEdits(3);
    expect(s.history()).toEqual({ labels: ['ラベル 1', 'ラベル 2', 'ラベル 3'], index: 3 });
    s.undo();
    expect(s.history()).toEqual({ labels: ['ラベル 1', 'ラベル 2', 'ラベル 3'], index: 2 });
    expect(s.redoLabel).toBe('ラベル 3');
  });

  it('goTo で任意の位置へまとめて移り、通知は 1 回だけ', () => {
    const s = storeWithEdits(4);
    const listener = vi.fn();
    s.subscribe(listener);
    expect(s.goTo(1)).toBe(true);
    expect(label(s)).toBe('1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.history().index).toBe(1);
    expect(s.undoLabel).toBe('ラベル 1');
    expect(s.redoLabel).toBe('ラベル 2');
    // 先へ移る（やり直し）
    expect(s.goTo(3)).toBe(true);
    expect(label(s)).toBe('3');
    expect(s.history()).toEqual({ labels: ['ラベル 1', 'ラベル 2', 'ラベル 3', 'ラベル 4'], index: 3 });
    // 最初へ
    s.goTo(0);
    expect(label(s)).toBe('0');
    expect(s.canUndo).toBe(false);
    expect(s.dirty).toBe(false);
  });

  it('goTo は undo / redo を続けたのと同じ結果になる', () => {
    const a = storeWithEdits(5);
    const b = storeWithEdits(5);
    a.goTo(2);
    b.undo();
    b.undo();
    b.undo();
    expect(a.text).toBe(b.text);
    expect(a.history()).toEqual(b.history());
    a.goTo(4);
    b.redo();
    b.redo();
    expect(a.text).toBe(b.text);
    expect(a.undoLabel).toBe(b.undoLabel);
    expect(a.redoLabel).toBe(b.redoLabel);
  });

  it('今の位置・範囲の外は何もしない（範囲の外は端に丸める）', () => {
    const s = storeWithEdits(2);
    expect(s.goTo(2)).toBe(false);
    expect(s.goTo(99)).toBe(false);
    expect(s.goTo(-5)).toBe(true);
    expect(label(s)).toBe('0');
  });

  it('新しく編集すると、やり直せる分は消える', () => {
    const s = storeWithEdits(3);
    s.goTo(1);
    s.edit('inspector', (doc) => void doc.querySelector('button')!.setAttribute('label', 'x'), '別の編集');
    expect(s.history()).toEqual({ labels: ['ラベル 1', '別の編集'], index: 2 });
  });

  it('一覧の行は、記録の始まり → 古い順で、今の位置と取り消した操作に印を付ける', () => {
    const rows = historyRows({ labels: ['A', 'B', 'C'], index: 1 });
    expect(rows.map((r) => [r.position, r.label, r.current, r.undone])).toEqual([
      [0, '記録の始まり', false, false],
      [1, 'A', true, false],
      [2, 'B', false, true],
      [3, 'C', false, true],
    ]);
  });
});
