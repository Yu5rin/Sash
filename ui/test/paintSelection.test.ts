import { describe, expect, it } from 'vitest';
import { createDoc } from '../src/icon/paint/doc';
import {
  copySelection, deleteSelection, deselect, dropFloating, inSelection, liftSelection, maskBounds, maskRect, pasteAsFloating, sampleDoc,
  selectAll, selectRect, setFloatingPos,
} from '../src/icon/paint/selection';
import { blendOver, blendColor, createPixels, getPixel } from '../src/icon/paint/pixels';
import { COLORS, fromTable, maskTable, toTable } from './helpers/paintTable';

const docOf = (rows: string[]) => createDoc(rows.length as 16, fromTable(rows));

describe('合成（ストレートアルファの source-over）', () => {
  it('不透明は上書き、完全に透明は何も変えない', () => {
    expect(blendColor({ r: 1, g: 2, b: 3, a: 255 }, { r: 9, g: 8, b: 7, a: 255 })).toEqual({ r: 9, g: 8, b: 7, a: 255 });
    expect(blendColor({ r: 1, g: 2, b: 3, a: 200 }, { r: 9, g: 8, b: 7, a: 0 })).toEqual({ r: 1, g: 2, b: 3, a: 200 });
  });
  it('下が透明なら、上の色がそのまま半透明で残る', () => {
    expect(blendColor({ r: 0, g: 0, b: 0, a: 0 }, { r: 10, g: 20, b: 30, a: 100 })).toEqual({ r: 10, g: 20, b: 30, a: 100 });
  });
  it('半透明の丸めを固定する（赤 50% を白の上、白 50% を透明の上、赤 50% を青 50% の上）', () => {
    // 255*128 + 255*255*(127/255)... = round((255·128 + 255·255·127/255)/255) の R 成分
    expect(blendColor({ r: 255, g: 255, b: 255, a: 255 }, { r: 255, g: 0, b: 0, a: 128 })).toEqual({ r: 255, g: 127, b: 127, a: 255 });
    // dst b=255 a=128、src r=255 a=128：dw = 128·127/255 = 63.74…、outA = 191.74…
    expect(blendColor({ r: 0, g: 0, b: 255, a: 128 }, { r: 255, g: 0, b: 0, a: 128 })).toEqual({ r: 170, g: 0, b: 85, a: 192 });
  });
  it('blendOver は範囲の外を捨て、mask の外には重ねない', () => {
    const dst = createPixels(3, 1);
    const src = fromTable(['rr']);
    blendOver(dst, src, 2, 0);
    expect(toTable(dst)).toEqual(['..r']);
    blendOver(dst, src, 0, 0, Uint8Array.from([0, 255, 255]));
    expect(toTable(dst)).toEqual(['.rr']);
  });
});

describe('選択のマスク', () => {
  it('四角形の選択と囲み', () => {
    const m = maskRect(5, 3, 3, 1, 0);
    expect(maskTable(m, 5)).toEqual(['.###.', '.###.', '.###.', '.###.', '.....']);
    expect(maskBounds(m, 5)).toEqual({ x: 1, y: 0, width: 3, height: 4 });
    expect(maskBounds(new Uint8Array(25), 5)).toBeNull();
  });
  it('選択がないときは全体が対象、あるときは中だけ', () => {
    const d = docOf(['....', '....', '....', '....']);
    expect(inSelection(d, 3, 3)).toBe(true);
    expect(inSelection(d, 4, 0)).toBe(false);
    selectRect(d, 1, 1, 2, 2);
    expect(inSelection(d, 1, 1)).toBe(true);
    expect(inSelection(d, 0, 0)).toBe(false);
    selectAll(d);
    expect(inSelection(d, 0, 0)).toBe(true);
    deselect(d);
    expect(d.selection).toBeNull();
  });
});

describe('浮いた選択', () => {
  it('持ち上げると元の場所が透明になり、動かして確定すると重なる', () => {
    const d = docOf(['rr..', 'rr..', '....', '....']);
    selectRect(d, 0, 0, 1, 1);
    expect(liftSelection(d, false)).toBe(true);
    expect(toTable(d.pixels)).toEqual(['....', '....', '....', '....']);
    setFloatingPos(d, 2, 2);
    expect(maskTable(d.selection!, 4)).toEqual(['....', '....', '..##', '..##']);
    expect(dropFloating(d)).toBe(true);
    expect(toTable(d.pixels)).toEqual(['....', '....', '..rr', '..rr']);
    expect(d.floating).toBeNull();
    expect(maskTable(d.selection!, 4)).toEqual(['....', '....', '..##', '..##']);
  });
  it('複製（Alt）なら元の場所が残る', () => {
    const d = docOf(['r...', '....', '....', '....']);
    selectRect(d, 0, 0, 0, 0);
    liftSelection(d, true);
    setFloatingPos(d, 3, 3);
    dropFloating(d);
    expect(toTable(d.pixels)).toEqual(['r...', '....', '....', '...r']);
  });
  it('はみ出した部分は確定のときに捨てる。全部はみ出したら選択も消える', () => {
    const d = docOf(['rr..', 'rr..', '....', '....']);
    selectRect(d, 0, 0, 1, 1);
    liftSelection(d, false);
    setFloatingPos(d, 3, 3);
    dropFloating(d);
    expect(toTable(d.pixels)).toEqual(['....', '....', '....', '...r']);
    const e = docOf(['rr..', 'rr..', '....', '....']);
    selectRect(e, 0, 0, 1, 1);
    liftSelection(e, false);
    setFloatingPos(e, 10, 10);
    dropFloating(e);
    expect(e.selection).toBeNull();
  });
  it('透明な部分は、重ねた先の絵を消さない', () => {
    const d = docOf(['r.b.', '....', '....', '....']);
    selectRect(d, 0, 0, 1, 0);
    liftSelection(d, false); // 'r.' を持ち上げる（右の透明は下の青を消さない）
    setFloatingPos(d, 1, 0);
    dropFloating(d);
    expect(toTable(d.pixels)[0]).toBe('.rb.');
  });
  it('選択がない・空・すでに浮いているときは持ち上げない', () => {
    const d = docOf(['r...', '....', '....', '....']);
    expect(liftSelection(d, false)).toBe(false);
    selectRect(d, 0, 0, 0, 0);
    liftSelection(d, false);
    expect(liftSelection(d, false)).toBe(false);
  });
});

describe('削除・コピー・貼り付け', () => {
  it('削除は選択の中だけを透明にする。浮いていれば浮いたものを捨てる', () => {
    const d = docOf(['rrrr', 'rrrr', 'rrrr', 'rrrr']);
    selectRect(d, 1, 1, 2, 2);
    expect(deleteSelection(d)).toBe(true);
    expect(toTable(d.pixels)).toEqual(['rrrr', 'r..r', 'r..r', 'rrrr']);
    expect(deleteSelection(d)).toBe(false);
    selectAll(d);
    liftSelection(d, false);
    expect(deleteSelection(d)).toBe(true);
    expect(d.floating).toBeNull();
  });
  it('選択がなければ削除は何もしない', () => {
    const d = docOf(['rr', 'rr']);
    expect(deleteSelection(d)).toBe(false);
  });
  it('コピーは選択の囲みの大きさで、選択の外は透明', () => {
    const d = docOf(['rrrr', 'rbbr', 'rrrr', 'rrrr']);
    selectRect(d, 1, 1, 2, 1);
    expect(toTable(copySelection(d)!)).toEqual(['bb']);
    deselect(d);
    expect(copySelection(d)).toBeNull();
  });
  it('貼り付けは中央に浮いた選択として置く。大きければ収まる大きさに縮める', () => {
    const d = docOf(['....', '....', '....', '....']);
    pasteAsFloating(d, fromTable(['r']));
    expect(d.floating).toMatchObject({ x: 1, y: 1 });
    expect(maskTable(d.selection!, 4)).toEqual(['....', '.#..', '....', '....']);
    const big = createPixels(8, 8);
    big.data.fill(255);
    pasteAsFloating(d, big); // 先に浮いていたものは確定する
    expect(toTable(d.pixels)[1]).toBe('.r..');
    expect(d.floating!.pixels.width).toBe(4);
    expect(getPixel(d.floating!.pixels, 0, 0)).toEqual(COLORS['w']);
  });
  it('スポイトは浮いた選択も含めた見たままの色を返す', () => {
    const d = docOf(['r...', '....', '....', '....']);
    selectRect(d, 0, 0, 0, 0);
    liftSelection(d, false);
    setFloatingPos(d, 2, 2);
    expect(sampleDoc(d, 2, 2)).toEqual(COLORS['r']);
    expect(sampleDoc(d, 0, 0)).toEqual(COLORS['.']);
    expect(sampleDoc(d, -3, 9)).toEqual(COLORS['.']);
  });
});
