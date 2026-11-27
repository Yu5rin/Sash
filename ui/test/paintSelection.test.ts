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

import { combineMask, invertSelection, maskEllipse, maskPolygon, previewColorOp, applyColorOp, transformContent } from '../src/icon/paint/selection';
import { monochromeMasked } from '../src/icon/paint/adjust';

describe('楕円・なげなわ・合成・反転（第 2 段階）', () => {
  it('楕円のマスク（2 つの角に内接）', () => {
    expect(maskTable(maskEllipse(7, 0, 0, 6, 6), 7)).toEqual(['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..']);
    // 角の順序は問わない・絵の外は切る
    expect(maskTable(maskEllipse(7, 6, 6, 0, 0), 7)).toEqual(maskTable(maskEllipse(7, 0, 0, 6, 6), 7));
    expect(maskBounds(maskEllipse(4, -3, -3, 1, 1), 4)).not.toBeNull();
  });
  it('なげなわ（多角形）のマスク：三角形・凹んだ形・3 点未満は空', () => {
    expect(maskTable(maskPolygon(6, [[0, 0], [5, 0], [0, 5]]), 6)).toEqual(['######', '#####.', '####..', '###...', '##....', '#.....']);
    const concave = maskPolygon(8, [[0, 0], [7, 0], [7, 7], [5, 7], [5, 3], [2, 3], [2, 7], [0, 7]]);
    expect(maskTable(concave, 8)[5]).toBe('###..###');
    expect(maskBounds(maskPolygon(5, [[0, 0], [4, 4]]), 5)).toBeNull();
  });
  it('選択の合成：置き換え・足す・引く。選択がないときの足す／引く。結果が空なら null', () => {
    const a = maskRect(4, 0, 0, 1, 1);
    const b = maskRect(4, 1, 1, 2, 2);
    expect(maskTable(combineMask(a, b, 'replace', 4)!, 4)).toEqual(['....', '.##.', '.##.', '....']);
    expect(maskTable(combineMask(a, b, 'add', 4)!, 4)).toEqual(['##..', '###.', '.##.', '....']);
    expect(maskTable(combineMask(a, b, 'subtract', 4)!, 4)).toEqual(['##..', '#...', '....', '....']);
    expect(maskTable(combineMask(null, b, 'add', 4)!, 4)).toEqual(['....', '.##.', '.##.', '....']);
    expect(combineMask(null, b, 'subtract', 4)).toBeNull();
    expect(combineMask(a, a, 'subtract', 4)).toBeNull();
  });
  it('選択範囲の反転：もう一度で元に戻る。選択がなければ何もしない。全部を反転すると選択なし', () => {
    const d = docOf(['....', '....', '....', '....']);
    expect(invertSelection(d)).toBe(false);
    selectRect(d, 0, 0, 1, 1);
    invertSelection(d);
    expect(maskTable(d.selection!, 4)).toEqual(['..##', '..##', '####', '####']);
    invertSelection(d);
    expect(maskTable(d.selection!, 4)).toEqual(['##..', '##..', '....', '....']);
    selectAll(d);
    invertSelection(d);
    expect(d.selection).toBeNull();
  });
});

describe('選択範囲（なければ全体）の反転・回転', () => {
  it('選択がなければ絵の全体を反転・回転する。4 回回すと元に戻る', () => {
    const d = docOf(['rb..', '....', '....', '....']);
    transformContent(d, 'flipH');
    expect(toTable(d.pixels)[0]).toBe('..br');
    transformContent(d, 'flipH');
    transformContent(d, 'flipV');
    expect(toTable(d.pixels)[3]).toBe('rb..');
    transformContent(d, 'flipV');
    for (let i = 0; i < 4; i++) transformContent(d, 'rotateCw');
    expect(toTable(d.pixels)[0]).toBe('rb..');
    transformContent(d, 'rotateCw');
    expect(toTable(d.pixels)).toEqual(['...r', '...b', '....', '....']);
    transformContent(d, 'rotateCcw');
    expect(toTable(d.pixels)[0]).toBe('rb..');
  });
  it('選択があれば中身だけを持ち上げて変形し、浮いたまま。中心は動かない', () => {
    const d = docOf(['rb..', '....', 'gg..', '....']);
    selectRect(d, 0, 0, 1, 0);
    expect(transformContent(d, 'flipH')).toBe(true);
    expect(d.floating).not.toBeNull();
    dropFloating(d);
    expect(toTable(d.pixels)).toEqual(['br..', '....', 'gg..', '....']);
    selectRect(d, 0, 0, 1, 0);
    transformContent(d, 'rotateCw'); // 2×1 → 1×2。中心 (1, 0.5) を保つ
    expect(d.floating!.pixels.width).toBe(1);
    expect(d.floating!.pixels.height).toBe(2);
    expect(maskTable(d.selection!, 4).join('/')).toBe('.#../.#../..../....');
    dropFloating(d);
    expect(toTable(d.pixels).map((r) => r[1]).join('').slice(0, 2)).toBe('br');
  });
});

describe('色の変更の適用とプレビュー', () => {
  const mono = (px: Parameters<typeof monochromeMasked>[0], m: Parameters<typeof monochromeMasked>[1]) => monochromeMasked(px, m, { r: 0, g: 0, b: 255 });
  it('選択範囲の中だけに適用し、プレビューは doc を変えない', () => {
    const d = docOf(['rrrr', 'rrrr', '....', '....']);
    selectRect(d, 0, 0, 1, 1);
    const view = previewColorOp(d, mono);
    expect(toTable(view).slice(0, 2)).toEqual(['bbrr', 'bbrr']);
    expect(toTable(d.pixels).slice(0, 2)).toEqual(['rrrr', 'rrrr']);
    applyColorOp(d, mono);
    expect(toTable(d.pixels).slice(0, 2)).toEqual(['bbrr', 'bbrr']);
  });
  it('選択がなければ全体、浮いた選択があればその中身', () => {
    const d = docOf(['rr..', '....', '....', '....']);
    applyColorOp(d, mono);
    expect(toTable(d.pixels)[0]).toBe('bb..');
    const e = docOf(['rr..', 'rr..', '....', '....']);
    selectRect(e, 0, 0, 0, 1);
    liftSelection(e, false);
    applyColorOp(e, mono);
    expect(toTable(e.pixels).slice(0, 2)).toEqual(['.r..', '.r..']);
    expect(toTable(e.floating!.pixels)).toEqual(['b', 'b']);
  });
});
