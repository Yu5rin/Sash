import { describe, expect, it } from 'vitest';
import { History } from '../src/icon/paint/history';
import { createDoc, restoreDoc, sameSnapshot, snapshotBytes, snapshotDoc, flatten } from '../src/icon/paint/doc';
import { liftSelection, selectRect, setFloatingPos } from '../src/icon/paint/selection';
import { fromTable, toTable } from './helpers/paintTable';

describe('履歴', () => {
  const h = (limits?: { maxEntries: number; maxBytes: number }) => new History<number>((n) => n, limits);
  it('戻す・やり直す。戻した後に新しく積むと、やり直しは消える', () => {
    const hist = h();
    hist.push({ label: 'a', before: 0, after: 1 });
    hist.push({ label: 'b', before: 1, after: 2 });
    expect(hist.undo()?.before).toBe(1);
    expect(hist.canRedo).toBe(true);
    expect(hist.redoLabel).toBe('b');
    expect(hist.redo()?.after).toBe(2);
    hist.undo();
    hist.push({ label: 'c', before: 1, after: 9 });
    expect(hist.canRedo).toBe(false);
    expect(hist.count).toBe(2);
    expect(hist.undoLabel).toBe('c');
  });
  it('何もないときは null', () => {
    const hist = h();
    expect(hist.undo()).toBeNull();
    expect(hist.redo()).toBeNull();
    expect(hist.canUndo).toBe(false);
  });
  it('手数の上限で古いものから消える', () => {
    const hist = h({ maxEntries: 3, maxBytes: 1e9 });
    for (let i = 0; i < 5; i++) hist.push({ label: String(i), before: i, after: i + 1 });
    expect(hist.count).toBe(3);
    const labels: string[] = [];
    for (let e = hist.undo(); e; e = hist.undo()) labels.push(e.label);
    expect(labels).toEqual(['4', '3', '2']);
  });
  it('バイト数の上限で古いものから消える。直前の 1 手は大きくても残る', () => {
    const hist = h({ maxEntries: 300, maxBytes: 10 });
    hist.push({ label: 'a', before: 2, after: 2 });
    hist.push({ label: 'b', before: 3, after: 3 });
    hist.push({ label: 'c', before: 4, after: 4 }); // 合計 4+6+8 = 18 > 10 → a, b を捨てる
    expect(hist.count).toBe(1);
    expect(hist.bytes).toBe(8);
    hist.push({ label: 'huge', before: 100, after: 100 });
    expect(hist.count).toBe(1);
    expect(hist.undoLabel).toBe('huge');
  });
  it('既定は 300 手・32MB', () => {
    const hist = new History<number>(() => 1);
    for (let i = 0; i < 350; i++) hist.push({ label: String(i), before: 0, after: 0 });
    expect(hist.count).toBe(300);
  });
});

describe('絵の複製', () => {
  it('複製して戻しても、履歴の中の複製を壊さない', () => {
    const doc = createDoc(16, undefined);
    doc.pixels = fromTable(['r...', '....', '....', '....']);
    doc.size = 16;
    const snap = snapshotDoc(doc);
    restoreDoc(doc, snap);
    doc.pixels.data[0] = 7;
    expect(snap.pixels.data[0]).toBe(255);
    expect(snapshotBytes(snap)).toBeGreaterThan(0);
  });
  it('選択・浮いた選択まで含めて比べる', () => {
    const doc = createDoc(16, undefined);
    const a = snapshotDoc(doc);
    selectRect(doc, 1, 1, 2, 2);
    expect(sameSnapshot(a, snapshotDoc(doc))).toBe(false);
    const b = snapshotDoc(doc);
    liftSelection(doc, false);
    expect(sameSnapshot(b, snapshotDoc(doc))).toBe(false);
    const c = snapshotDoc(doc);
    setFloatingPos(doc, 3, 3);
    expect(sameSnapshot(c, snapshotDoc(doc))).toBe(false);
    expect(sameSnapshot(c, snapshotDoc(restoreAndGet(c)))).toBe(true);
  });
  it('flatten は浮いた選択を重ねた絵を返し、doc は変えない', () => {
    const doc = createDoc(16, undefined);
    doc.pixels = fromTable(['rrrr', '....', '....', '....']);
    doc.size = 16;
    selectRect(doc, 0, 0, 1, 0);
    liftSelection(doc, false);
    setFloatingPos(doc, 0, 2);
    expect(toTable(flatten(doc))).toEqual(['..rr', '....', 'rr..', '....']);
    expect(doc.floating).not.toBeNull();
  });
});

function restoreAndGet(s: ReturnType<typeof snapshotDoc>) {
  const d = createDoc(16, undefined);
  restoreDoc(d, s);
  return d;
}
