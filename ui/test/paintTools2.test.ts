import { describe, expect, it } from 'vitest';
import { PaintSession, type PointerInfo } from '../src/icon/paint/session';
import { flatten } from '../src/icon/paint/doc';
import { monochromeMasked, replaceColorMasked } from '../src/icon/paint/adjust';
import { getPixel } from '../src/icon/paint/pixels';
import { COLORS, fromTable, maskTable, toTable } from './helpers/paintTable';

const P = (x: number, y: number, o: Partial<PointerInfo> = {}): PointerInfo => ({ x, y, button: 0, shift: false, alt: false, ctrl: false, ...o });
const key = (k: string, o: { ctrl?: boolean; shift?: boolean; alt?: boolean; repeat?: boolean } = {}) => ({ key: k, ctrl: !!o.ctrl, shift: !!o.shift, alt: !!o.alt, repeat: o.repeat });
function drag(s: PaintSession, pts: [number, number][], o: Partial<PointerInfo> = {}): void {
  s.pointerDown(P(pts[0]![0], pts[0]![1], o));
  for (const [x, y] of pts.slice(1)) s.pointerMove(P(x, y, o));
  const last = pts.at(-1)!;
  s.pointerUp(P(last[0], last[1], o));
}
const rows = (s: PaintSession, n = 8, w = 8): string[] => toTable(flatten(s.doc)).slice(0, n).map((r) => r.slice(0, w));
const sel = (s: PaintSession, n = 8, w = 8): string[] => maskTable(s.doc.selection!, s.doc.size).slice(0, n).map((r) => r.slice(0, w));
const fresh = (tableRows?: string[]) => {
  const px = tableRows ? fromTable(tableRows.map((r) => r.padEnd(16, '.')).concat(Array(16 - tableRows.length).fill('.'.repeat(16)))) : undefined;
  const s = new PaintSession(16, px);
  s.setColor('primary', COLORS['r']!);
  s.setColor('secondary', COLORS['.']!);
  return s;
};

describe('ブラシ', () => {
  it('太さ 3・硬さ 100・ぼかしなしで、線を引ける。1 ドラッグ＝1 手', () => {
    const s = fresh();
    s.setTool('brush');
    s.setSettings({ brushSize: 3 });
    drag(s, [[2, 2], [5, 2]]);
    expect(rows(s, 5, 8)).toEqual(['........', '.rrrrrr.', '.rrrrrr.', '.rrrrrr.', '........']);
    expect(s.history.count).toBe(1);
  });
  it('1 回のストロークで同じ所を行き来しても、不透明度 50% が重なって濃くならない', () => {
    const s = fresh();
    s.setTool('brush');
    s.setSettings({ brushSize: 1, opacity: 50 });
    drag(s, [[2, 2], [6, 2], [2, 2], [6, 2]]);
    expect(getPixel(s.doc.pixels, 4, 2)).toEqual({ r: 255, g: 0, b: 0, a: 128 });
    // 別のストロークで重ねると濃くなる
    drag(s, [[4, 2]]);
    expect(getPixel(s.doc.pixels, 4, 2).a).toBeGreaterThan(128);
  });
  it('消しゴムは、不透明度の分だけ薄く消す', () => {
    const s = fresh(['rrrr']);
    s.setTool('eraser');
    s.setSettings({ opacity: 50 });
    drag(s, [[0, 0], [1, 0]]);
    expect(getPixel(s.doc.pixels, 0, 0).a).toBe(128);
    expect(getPixel(s.doc.pixels, 3, 0).a).toBe(255);
  });
  it('ブラシでも Alt でスポイトになる', () => {
    const s = fresh(['b']);
    s.setTool('brush');
    drag(s, [[0, 0]], { alt: true });
    expect(s.primary).toEqual(COLORS['b']);
    expect(s.history.count).toBe(0);
  });
  it('[ と ] で、いまのツールの太さを変える（範囲で止まる）', () => {
    const s = fresh();
    s.key(key(']'));
    expect(s.settings.size).toBe(2);
    s.setTool('brush');
    for (let i = 0; i < 30; i++) s.key(key(']'));
    expect(s.settings.brushSize).toBe(16);
    s.key(key('['));
    expect(s.settings.brushSize).toBe(15);
    s.setTool('rect');
    s.key(key(']'));
    expect(s.settings.shapeWidth).toBe(2);
    s.setTool('fill');
    expect(s.key(key(']'))).toBe(false);
  });
});

describe('直線・四角形・楕円', () => {
  it('直線：ドラッグ中はプレビュー（絵に出る）、離すと確定。1 手', () => {
    const s = fresh();
    s.setTool('line');
    s.pointerDown(P(1, 1));
    s.pointerMove(P(5, 1));
    expect(rows(s, 2)[1]).toBe('.rrrrr..');
    s.pointerMove(P(3, 1));
    expect(rows(s, 2)[1]).toBe('.rrr....');
    s.pointerUp(P(3, 1));
    expect(s.history.count).toBe(1);
    s.undo();
    expect(rows(s, 2)[1]).toBe('........');
  });
  it('Shift の直線は 45° に揃う。太さを変えられる', () => {
    const s = fresh();
    s.setTool('line');
    drag(s, [[1, 1], [5, 3]], { shift: true });
    expect(rows(s, 6).map((r) => r.slice(0, 6))).toEqual(['......', '.r....', '..r...', '...r..', '....r.', '.....r']);
    const t = fresh();
    t.setTool('line');
    t.setSettings({ shapeWidth: 3 });
    drag(t, [[1, 3], [6, 3]]);
    expect(rows(t, 6)[2]).toBe('.rrrrrr.');
    expect(rows(t, 6)[4]).toBe('.rrrrrr.');
  });
  it('四角形：線だけ・塗りだけ・両方（線＝前景色・塗り＝背景色）。右ボタンは逆', () => {
    const s = fresh();
    s.setTool('rect');
    drag(s, [[1, 1], [4, 4]]);
    expect(rows(s, 6).slice(1, 5).map((r) => r.slice(1, 5))).toEqual(['rrrr', 'r..r', 'r..r', 'rrrr']);
    const f = fresh();
    f.setTool('rect');
    f.setSettings({ shapeFill: 'fill' });
    drag(f, [[1, 1], [4, 4]]);
    expect(rows(f, 6).slice(1, 5).map((r) => r.slice(1, 5))).toEqual(['rrrr', 'rrrr', 'rrrr', 'rrrr']);
    const b = fresh();
    b.setColor('secondary', COLORS['b']!);
    b.setTool('rect');
    b.setSettings({ shapeFill: 'both' });
    drag(b, [[1, 1], [4, 4]]);
    expect(rows(b, 6).slice(1, 5).map((r) => r.slice(1, 5))).toEqual(['rrrr', 'rbbr', 'rbbr', 'rrrr']);
    const r = fresh();
    r.setColor('secondary', COLORS['b']!);
    r.setTool('rect');
    r.setSettings({ shapeFill: 'both' });
    drag(r, [[1, 1], [4, 4]], { button: 2 });
    expect(rows(r, 6).slice(1, 5).map((x) => x.slice(1, 5))).toEqual(['bbbb', 'brrb', 'brrb', 'bbbb']);
  });
  it('Shift の四角形は正方形、Shift の楕円は正円', () => {
    const s = fresh();
    s.setTool('rect');
    s.setSettings({ shapeFill: 'fill' });
    drag(s, [[1, 1], [4, 2]], { shift: true });
    expect(rows(s, 6).slice(1, 5).map((r) => r.slice(1, 5))).toEqual(['rrrr', 'rrrr', 'rrrr', 'rrrr']);
    const e = fresh();
    e.setTool('ellipse');
    e.setSettings({ shapeFill: 'fill' });
    drag(e, [[0, 0], [6, 2]], { shift: true });
    expect(rows(e, 7, 7)).toEqual(['..rrr..', '.rrrrr.', 'rrrrrrr', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..']);
  });
  it('楕円の線だけ。絵の外までドラッグしても落ちない。Esc で取り消せる', () => {
    const s = fresh();
    s.setTool('ellipse');
    drag(s, [[0, 0], [6, 6]]);
    expect(rows(s, 7, 7)[3]).toBe('r.....r');
    s.setTool('rect');
    s.pointerDown(P(2, 2));
    s.pointerMove(P(40, 40));
    expect(s.escape()).toBe(true);
    expect(s.history.count).toBe(1);
    expect(rows(s, 7, 7)[3]).toBe('r.....r');
  });
  it('選択範囲の中にだけ描く。不透明度が効く', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[0, 0], [3, 3]]);
    s.setTool('rect');
    s.setSettings({ shapeFill: 'fill', opacity: 100 });
    drag(s, [[2, 2], [6, 6]]);
    expect(rows(s, 7, 7).slice(0, 5)).toEqual(['.......', '.......', '..rr...', '..rr...', '.......']);
  });
});

describe('選択ツール（楕円・なげなわ・自動選択）と合成', () => {
  it('楕円の選択', () => {
    const s = fresh();
    s.setTool('ellipseSelect');
    drag(s, [[0, 0], [6, 6]]);
    expect(sel(s, 7, 7)).toEqual(['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..']);
    drag(s, [[14, 14]]);
    expect(s.doc.selection).toBeNull();
  });
  it('なげなわ：なぞった囲みの中を選ぶ。1 手', () => {
    const s = fresh();
    s.setTool('lasso');
    drag(s, [[1, 1], [5, 1], [5, 5], [1, 5]]);
    expect(sel(s, 7, 7).slice(0, 7)).toEqual(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
    expect(s.history.count).toBe(1);
  });
  it('自動選択：同じ色のつながった領域（斜めは含まない）。許容差・全体も使える', () => {
    const s = fresh(['rr.rr', 'rr.rr', '..b..']);
    s.setTool('wand');
    drag(s, [[0, 0]]);
    expect(sel(s, 3, 5)).toEqual(['##...', '##...', '.....']);
    s.setSettings({ contiguous: false });
    drag(s, [[0, 0]]);
    expect(sel(s, 3, 5)).toEqual(['##.##', '##.##', '.....']);
    s.setSettings({ contiguous: true, tolerance: 100 });
    drag(s, [[0, 0]]);
    expect(s.doc.selection!.every((v) => v === 255)).toBe(true);
  });
  it('Shift で足す・Alt で引く（自動選択でも、四角形でも）', () => {
    const s = fresh(['rr.rr', 'rr.rr']);
    s.setTool('wand');
    drag(s, [[0, 0]]);
    drag(s, [[3, 0]], { shift: true });
    expect(sel(s, 2, 5)).toEqual(['##.##', '##.##']);
    drag(s, [[3, 0]], { alt: true });
    expect(sel(s, 2, 5)).toEqual(['##...', '##...']);
    s.setTool('select');
    drag(s, [[0, 0], [0, 1]], { alt: true });
    expect(sel(s, 2, 5)).toEqual(['.#...', '.#...']);
    drag(s, [[3, 0], [4, 1]], { shift: true });
    expect(sel(s, 2, 5)).toEqual(['.#.##', '.#.##']);
    expect(s.history.count).toBeGreaterThanOrEqual(5);
  });
  it('足す・引くで空になったら選択なし。何もない所を足す・引くクリックは、何も変えない', () => {
    const s = fresh(['rr']);
    s.setTool('wand');
    drag(s, [[0, 0]]);
    drag(s, [[0, 0]], { alt: true });
    expect(s.doc.selection).toBeNull();
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    const n = s.history.count;
    drag(s, [[8, 8]], { shift: true });
    expect(s.history.count).toBe(n);
    expect(s.doc.selection).not.toBeNull();
  });
  it('選択の中を足すモードでドラッグしても、動かさない（新しい選択を足す）', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [3, 3]], { shift: true });
    expect(s.doc.floating).toBeNull();
    expect(sel(s, 4, 4)[3]).toBe('####');
  });
  it('選択の反転と、反転した選択への塗り', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[0, 0], [14, 14]]);
    s.invertSelectionMask();
    expect(sel(s, 16, 16)[15]).toBe('################');
    expect(sel(s, 16, 16)[0]).toBe('...............#');
    s.undo();
    expect(sel(s, 16, 16)[15]).toBe('................');
  });
});

describe('反転・回転・色の変更・キャンバスの大きさ', () => {
  it('選択範囲だけを左右反転・回転。選択がなければ全体。1 手ずつ戻せる', () => {
    const s = fresh(['rb', 'g.']);
    s.transform('flipH');
    expect(toTable(flatten(s.doc))[0].slice(0, 16)).toBe('.'.repeat(14) + 'br');
    s.transform('flipH');
    s.setTool('select');
    drag(s, [[0, 0], [1, 0]]);
    s.transform('flipH');
    expect(rows(s, 2, 2)).toEqual(['br', 'g.']);
    s.undo();
    expect(rows(s, 2, 2)).toEqual(['rb', 'g.']);
    expect(s.history.count).toBe(3);
  });
  it('色の変更：選択範囲だけに適用できる（プレビューは見た目だけ。適用で 1 手。元に戻せる）', () => {
    const s = fresh(['rrrr', 'rrrr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    const before = s.history.count;
    s.setPreview((px, m) => monochromeMasked(px, m, { r: 0, g: 0, b: 255 }));
    expect(toTable(s.displayPixels()).slice(0, 2).map((r) => r.slice(0, 4))).toEqual(['bbrr', 'bbrr']);
    expect(rows(s, 2, 4)).toEqual(['rrrr', 'rrrr']);
    s.applyColor('単色化', (px, m) => monochromeMasked(px, m, { r: 0, g: 0, b: 255 }));
    expect(s.history.count).toBe(before + 1);
    expect(rows(s, 2, 4)).toEqual(['bbrr', 'bbrr']);
    s.undo();
    expect(rows(s, 2, 4)).toEqual(['rrrr', 'rrrr']);
  });
  it('プレビューは、描き始める・Esc・元に戻すで捨てられ、通知が出る', () => {
    const s = fresh(['rr']);
    let dropped = 0;
    s.onPreviewDropped = () => dropped++;
    s.setPreview(() => undefined);
    s.pointerDown(P(5, 5));
    s.pointerUp(P(5, 5));
    expect(s.preview).toBeNull();
    expect(dropped).toBe(1);
    s.setPreview(() => undefined);
    expect(s.escape()).toBe(true);
    expect(dropped).toBe(2);
  });
  it('置き換え：許容差と範囲（選択がなければ全体）', () => {
    const s = fresh(['rrbb']);
    s.applyColor('置き換え', (px, m) => replaceColorMasked(px, m, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, 0));
    expect(getPixel(s.doc.pixels, 0, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(getPixel(s.doc.pixels, 3, 0)).toEqual(COLORS['b']);
  });
  it('キャンバスの大きさを変える（16 → 32 は最近傍で 2 倍）。戻せる。大きさは履歴に入る', () => {
    const s = fresh(['rb']);
    s.resizeCanvas(32, 'nearest');
    expect(s.doc.size).toBe(32);
    expect(toTable(flatten(s.doc))[1].slice(0, 4)).toBe('rrbb');
    expect(s.changed).toBe(true);
    s.undo();
    expect(s.doc.size).toBe(16);
    expect(s.doc.pixels.width).toBe(16);
    s.redo();
    expect(s.doc.size).toBe(32);
    s.resizeCanvas(16, 'smooth');
    expect(s.doc.size).toBe(16);
  });
  it('余白をカット：中央へ寄る', () => {
    const s = fresh(['rr', 'rr']);
    s.trimMargins();
    expect(toTable(flatten(s.doc))[7].slice(6, 10)).toBe('.rr.');
  });
});

describe('キーボードのカーソルで描く', () => {
  it('矢印でカーソルが動き（選択がないとき）、Enter を押している間が鉛筆の描画。離すと 1 手', () => {
    const s = fresh();
    expect(s.cursor).toBeNull();
    s.key(key('ArrowLeft'));
    expect(s.cursor).toEqual({ x: 7, y: 8 });
    s.key(key('Enter'));
    s.key(key('ArrowRight', { shift: true }));
    s.key(key('ArrowDown'));
    expect(s.dragging).toBe(true);
    s.keyUp('Enter');
    expect(s.dragging).toBe(false);
    expect(s.history.count).toBe(1);
    expect(toTable(flatten(s.doc))[8].slice(7, 12)).toBe('rrrrr');
    expect(getPixel(s.doc.pixels, 11, 9)).toEqual(COLORS['r']);
  });
  it('Space でも描く。Enter の繰り返し（押しっぱなし）は 1 回だけ', () => {
    const s = fresh();
    s.key(key(' ')); // 1 回目はカーソルを出すだけ
    s.keyUp(' ');
    s.key(key(' '));
    s.key(key(' ', { repeat: true }));
    s.keyUp(' ');
    expect(s.history.count).toBe(1);
    expect(getPixel(s.doc.pixels, 8, 8)).toEqual(COLORS['r']);
  });
  it('Shift+Enter で、前の点から直線。Ctrl+矢印は、選択があってもカーソルを動かす', () => {
    const s = fresh();
    s.key(key('Enter')); // カーソルを出す
    s.keyUp('Enter');
    s.key(key('Enter'));
    s.keyUp('Enter');
    s.key(key('ArrowRight', { ctrl: true, shift: true }));
    s.key(key('Enter', { shift: true }));
    s.keyUp('Enter');
    expect(toTable(flatten(s.doc))[8].slice(8, 13)).toBe('rrrrr');
    s.setTool('select');
    s.selectAllPixels();
    s.key(key('ArrowDown', { ctrl: true }));
    expect(s.doc.floating).toBeNull();
    expect(s.cursor!.y).toBe(9);
  });
  it('塗りつぶしはキーボードでも一度で終わる。カーソルは絵の中に収まる', () => {
    const s = fresh();
    s.setTool('fill');
    s.key(key('Enter')); // カーソルを出す
    s.key(key('Enter'));
    expect(s.dragging).toBe(false);
    expect(getPixel(s.doc.pixels, 0, 0)).toEqual(COLORS['r']);
    for (let i = 0; i < 20; i++) s.key(key('ArrowRight', { ctrl: true, shift: true }));
    expect(s.cursor!.x).toBe(15);
  });
  it('カーソルの位置と色を読み上げる', () => {
    const s = fresh(['r']);
    const said: string[] = [];
    s.onAnnounce = (m) => said.push(m);
    s.moveCursor(-8, -8);
    expect(said.at(-1)).toContain('x 0');
    expect(said.at(-1)).toContain('#ff0000');
  });
});

describe('ツールのショートカット（第 2 段階）', () => {
  it('B L R O W は道具、Shift+M は楕円の選択、Shift+L はなげなわ', () => {
    const s = fresh();
    for (const [k, id] of [['b', 'brush'], ['l', 'line'], ['r', 'rect'], ['o', 'ellipse'], ['w', 'wand'], ['m', 'select']] as const) {
      s.key(key(k));
      expect(s.tool).toBe(id);
    }
    s.key(key('M', { shift: true }));
    expect(s.tool).toBe('ellipseSelect');
    s.key(key('L', { shift: true }));
    expect(s.tool).toBe('lasso');
  });
  it('浮いた選択は、動かせる選択ツールの間は持ち続け、それ以外のツールへ替えると確定する', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [5, 5]]);
    s.setTool('lasso');
    expect(s.doc.floating).not.toBeNull();
    s.setTool('wand');
    expect(s.doc.floating).toBeNull();
  });
});

import { brushFootprint, newCoverage, stampBrush } from '../src/icon/paint/stroke';
import { setFloatingPos, transformContent } from '../src/icon/paint/selection';
import { createDoc } from '../src/icon/paint/doc';

describe('見直し（第 2 段階）', () => {
  it('色の変更をプレビューしただけでも「変わった」と数え、［完了］の適用（commitPreview）で確定する', () => {
    const s = fresh(['rr']);
    expect(s.changed).toBe(false);
    s.setPreview((px, m) => monochromeMasked(px, m, { r: 0, g: 0, b: 255 }));
    expect(s.changed).toBe(true);
    s.commitPreview('色の変更');
    expect(s.preview).toBeNull();
    expect(rows(s, 1, 4)).toEqual(['bb..']);
    expect(s.history.count).toBe(1);
  });
  it('キーボードで描いている途中に blur（releaseKeyboard）：そこまでを確定し、次のクリックでカーソルからの線を引かない', () => {
    const s = fresh();
    s.key(key('ArrowLeft'));
    s.key(key('Enter'));
    s.key(key('ArrowRight'));
    s.releaseKeyboard();
    expect(s.dragging).toBe(false);
    const n = s.history.count;
    expect(n).toBe(1);
    drag(s, [[2, 2]]);
    expect(rows(s, 3, 16).map((r) => r.replace(/\./g, '')).join('')).toBe('r');
    expect(getPixel(s.doc.pixels, 2, 2)).toEqual(COLORS['r']);
  });
  it('キーボードで描いている途中にマウスが押されたら、キーボードの描画を終えてからマウスの操作を始める', () => {
    const s = fresh();
    s.key(key('Enter')); // カーソルを出す
    s.keyUp('Enter');
    s.key(key('Enter'));
    s.pointerDown(P(2, 2));
    s.pointerUp(P(2, 2));
    s.keyUp('Enter');
    expect(s.history.count).toBe(2);
    expect(getPixel(s.doc.pixels, 2, 2)).toEqual(COLORS['r']);
    expect(getPixel(s.doc.pixels, 5, 2).a).toBe(0);
  });
  it('「線と塗り」で背景色が透明なら、塗らない（下の絵を消さない）。知らせる', () => {
    const s = fresh(['bbbbbb', 'bbbbbb', 'bbbbbb', 'bbbbbb']);
    const said: string[] = [];
    s.onAnnounce = (m) => said.push(m);
    s.setTool('rect');
    s.setSettings({ shapeFill: 'both' });
    drag(s, [[0, 0], [5, 3]]);
    expect(rows(s, 4, 6)).toEqual(['rrrrrr', 'rbbbbr', 'rbbbbr', 'rrrrrr']);
    expect(said.some((m) => m.includes('塗りは付きません'))).toBe(true);
  });
  it('選択がなければ Ctrl+X は処理しない（false）。あれば true', () => {
    const s = fresh(['rr']);
    expect(s.key(key('x', { ctrl: true }))).toBe(false);
    s.setTool('select');
    drag(s, [[0, 0], [1, 0]]);
    expect(s.key(key('x', { ctrl: true }))).toBe(true);
  });
  it('浮いた選択の回転：右 4 回・右と左で、位置が元に戻る（回すたびに丸めてずれない）', () => {
    const mk = () => {
      const d = createDoc(16, fromTable(['rrr'.padEnd(16, '.'), 'rrr'.padEnd(16, '.'), ...Array(14).fill('.'.repeat(16))]));
      d.selection = maskTable2(d);
      return d;
    };
    const maskTable2 = (d: ReturnType<typeof createDoc>) => {
      const m = new Uint8Array(256);
      for (let y = 2; y < 4; y++) for (let x = 2; x < 5; x++) m[y * 16 + x] = 255;
      d.pixels = fromTable(Array.from({ length: 16 }, (_, y) => (y >= 2 && y < 4 ? '..rrr'.padEnd(16, '.') : '.'.repeat(16))));
      return m;
    };
    const d = mk();
    transformContent(d, 'rotateCw');
    transformContent(d, 'rotateCcw');
    expect(d.floating).toMatchObject({ x: 2, y: 2 });
    for (let i = 0; i < 4; i++) transformContent(d, 'rotateCw');
    expect(d.floating).toMatchObject({ x: 2, y: 2 });
    expect(d.floating!.pixels.width).toBe(3);
  });
  it('回転ではみ出す選択は、絵の中に収まる位置へ寄せる（収まらないときは知らせる）', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[0, 15], [7, 15]]); // 下端の 8×1 の帯
    s.key(key('r', { ctrl: false }));
    s.setTool('select');
    s.transform('rotateCw');
    const f = s.doc.floating!;
    expect(f.pixels.width).toBe(1);
    expect(f.pixels.height).toBe(8);
    expect(f.y + f.pixels.height).toBeLessThanOrEqual(16);
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.x + f.pixels.width).toBeLessThanOrEqual(16);
  });
  it('ブラシの偶数の太さ：描かれる範囲・筆先の枠・鉛筆の丸い筆先が一致する', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const c = newCoverage(15);
      stampBrush(c, 15, 7, 7, { size: n, hardness: 100, antialias: false });
      const drawn = new Set<string>();
      for (let i = 0; i < c.length; i++) if (c[i]! >= 128) drawn.add(`${(i % 15) - 7},${Math.floor(i / 15) - 7}`);
      const foot = new Set(brushFootprint({ size: n, hardness: 100, antialias: false }).map(([x, y]) => `${x},${y}`));
      expect(foot).toEqual(drawn);
    }
    expect(brushFootprint({ size: 2, hardness: 100, antialias: false })).toHaveLength(4);
    expect(brushFootprint({ size: 4, hardness: 100, antialias: false })).toHaveLength(12);
    const s = fresh();
    s.setTool('brush');
    s.setSettings({ brushSize: 2 });
    expect(s.hoverCells).toHaveLength(4);
  });
});

describe('最終確認の指摘', () => {
  const band = (size: number, x0: number, y0: number, x1: number, y1: number) => {
    const rowsT = Array.from({ length: size }, (_, y) => (y >= y0 && y <= y1 ? '.'.repeat(x0) + 'r'.repeat(x1 - x0 + 1) : '').padEnd(size, '.'));
    const d = createDoc(size as 16, fromTable(rowsT));
    const m = new Uint8Array(size * size);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * size + x] = 255;
    d.selection = m;
    return d;
  };
  it('端の近くの範囲でも、回転が元に戻る（右 4 回・右左・左右）', () => {
    for (const [x0, y0, x1, y1] of [[0, 0, 15, 0], [0, 0, 2, 5], [10, 0, 14, 1], [0, 13, 15, 15]] as const) {
      for (const seq of [['rotateCw', 'rotateCw', 'rotateCw', 'rotateCw'], ['rotateCw', 'rotateCcw'], ['rotateCcw', 'rotateCw']] as const) {
        const d = band(16, x0, y0, x1, y1);
        for (const k of seq) transformContent(d, k);
        expect(d.floating, `${x0},${y0}-${x1},${y1} ${seq.join()}`).toMatchObject({ x: x0, y: y0 });
        expect(d.floating!.pixels.width).toBe(x1 - x0 + 1);
      }
    }
  });
  it('選択を動かしたら、回転の中心は捨てる', () => {
    const d = band(16, 2, 2, 4, 3);
    transformContent(d, 'rotateCw');
    expect(d.floating!.center).toBeDefined();
    setFloatingPos(d, 5, 5);
    expect(d.floating!.center).toBeUndefined();
  });
  it('はみ出しの知らせは、回転のときだけ（反転では出さない）', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[0, 15], [7, 15]]);
    const said: string[] = [];
    s.onAnnounce = (m) => said.push(m);
    s.transform('flipH');
    expect(said.some((m) => m.includes('はみ出'))).toBe(false);
  });
  it('選択を矢印で動かしても、キーボードのカーソルは作られない（Space を離したときに中央で描かないため）', () => {
    const s = fresh(['rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 0]]);
    s.key(key('ArrowRight'));
    expect(s.cursor).toBeNull();
    s.key(key('Enter'));
    expect(s.cursor).toBeNull();
  });
});

describe('キーボードのカーソルの状態（session.cursor だけ）の遷移', () => {
  /** 画面が見ているカーソル（onChange のたびに写す）と、実際のカーソルが、いつも同じか。 */
  const watch = (s: PaintSession) => {
    const seen = { v: s.cursor ? `${s.cursor.x},${s.cursor.y}` : '' };
    s.onChange = () => (seen.v = s.cursor ? `${s.cursor.x},${s.cursor.y}` : '');
    return () => {
      const now = s.cursor ? `${s.cursor.x},${s.cursor.y}` : '';
      expect(seen.v, '画面のカーソルと実際のカーソルが食い違っている').toBe(now);
    };
  };
  const shown = (s: PaintSession) => {
    s.key(key('ArrowRight', { ctrl: true }));
    expect(s.cursor).not.toBeNull();
  };
  const pixelsOf = (s: PaintSession) => [...s.doc.pixels.data];

  it('カーソルが出ていないときの Enter・Space は、カーソルを出すだけで、ツールを使わない（見えない場所に描かない）', () => {
    for (const k of ['Enter', ' ']) {
      const s = fresh();
      const same = watch(s);
      const before = pixelsOf(s);
      s.key(key(k));
      s.keyUp(k);
      expect(s.cursor).toEqual({ x: 8, y: 8 });
      expect(pixelsOf(s)).toEqual(before);
      expect(s.history.count).toBe(0);
      same();
      // 2 回目から使う
      s.key(key(k));
      s.keyUp(k);
      expect(s.history.count).toBe(1);
      expect(getPixel(s.doc.pixels, 8, 8)).toEqual(COLORS['r']);
      same();
    }
  });
  it('出すときは、前回の位置から始める', () => {
    const s = fresh();
    s.key(key('ArrowLeft'));
    s.key(key('ArrowDown'));
    const at = { ...s.cursor! };
    s.dropCursor();
    expect(s.cursor).toBeNull();
    s.key(key('Enter'));
    expect(s.cursor).toEqual(at);
  });
  it('再現 a1：カーソルで点 → Ctrl+Z ×2 → マウスで線 → Enter は、古い位置 (7,8) に描かない', () => {
    const s = fresh();
    s.key(key('ArrowLeft'));
    s.key(key(' '));
    s.keyUp(' ');
    s.undo();
    s.undo();
    drag(s, [[3, 3], [5, 3]]);
    const n = s.history.count;
    s.key(key('Enter'));
    s.keyUp('Enter');
    expect(s.history.count).toBe(n);
    expect(getPixel(s.doc.pixels, 7, 8).a).toBe(0);
  });
  it('再現 a7：カーソル → Ctrl+Z → 四角形選択をマウスで作り → Enter は、選択を消さない', () => {
    const s = fresh();
    s.key(key('ArrowLeft'));
    s.key(key(' '));
    s.keyUp(' ');
    s.undo();
    s.setTool('select');
    drag(s, [[2, 2], [5, 5]]);
    const sel = [...s.doc.selection!];
    s.key(key('Enter'));
    s.keyUp('Enter');
    expect(s.doc.selection).not.toBeNull();
    expect([...s.doc.selection!]).toEqual(sel);
  });
  it('再現 a6：塗りつぶしをカーソルで使ったあとも、カーソルは出たまま・画面と一致（もう一度で、見える位置にまた塗る）', () => {
    const s = fresh();
    const same = watch(s);
    s.setTool('fill');
    s.key(key('ArrowLeft'));
    s.key(key('Enter'));
    s.keyUp('Enter');
    expect(s.cursor).not.toBeNull();
    same();
    expect(s.history.count).toBe(1);
  });
  it('自動選択をカーソルで使ったあとも、カーソルは出たまま', () => {
    const s = fresh();
    const same = watch(s);
    s.setTool('wand');
    s.key(key('ArrowLeft'));
    s.key(key('Enter'));
    s.keyUp('Enter');
    expect(s.doc.selection).not.toBeNull();
    expect(s.cursor).not.toBeNull();
    same();
  });
  it('消える操作：マウス・ホバー・ツール・履歴を作る操作・元に戻す／やり直す（履歴が空でも）・処理した Esc・選択範囲の矢印移動・確定。画面とも一致', () => {
    const acts: [string, (s: PaintSession) => void][] = [
      ['マウス', (s) => drag(s, [[1, 1], [3, 1]])],
      ['ホバー', (s) => s.dropCursor()],
      ['ツール', (s) => s.setTool('brush')],
      ['空の元に戻す', (s) => { s.undo(); }],
      ['空のやり直し', (s) => { s.redo(); }],
      ['すべて選択', (s) => s.selectAllPixels()],
      ['反転', (s) => s.transform('flipH')],
      ['色の変更', (s) => s.applyColor('x', () => undefined)],
      ['キャンバスの大きさ', (s) => s.resizeCanvas(32, 'nearest')],
      ['貼り付け', (s) => { s.clipboard = fromTable(['r']); s.pasteInternal(); }],
      ['選択範囲の矢印移動', (s) => { s.setTool('select'); drag(s, [[0, 0], [1, 1]]); s.key(key('ArrowLeft', { ctrl: true })); s.key(key('ArrowDown')); }],
      ['Esc（選択の解除）', (s) => { s.selectAllPixels(); s.key(key('ArrowLeft', { ctrl: true })); s.escape(); }],
    ];
    for (const [name, act] of acts) {
      const s = fresh();
      const same = watch(s);
      shown(s);
      act(s);
      expect(s.cursor, name).toBeNull();
      same();
    }
  });
  it('何も処理しない Esc（閉じる確認へ進む）では、カーソルに触らない', () => {
    const s = fresh();
    const same = watch(s);
    shown(s);
    expect(s.escape()).toBe(false);
    expect(s.cursor).not.toBeNull();
    same();
  });
  it('Enter で浮いた選択を確定しても、カーソルは出ない（以前に使っていても）', () => {
    const s = fresh(['rr']);
    s.key(key('ArrowLeft'));
    s.setTool('select');
    drag(s, [[0, 0], [1, 0]]);
    s.key(key('ArrowDown'));
    expect(s.doc.floating).not.toBeNull();
    expect(s.cursor).toBeNull();
    s.key(key('Enter'));
    expect(s.cursor).toBeNull();
  });
  it('カーソルを動かしながら描いている途中は、カーソルが消えない（描画が終わるまで）', () => {
    const s = fresh();
    s.key(key('ArrowLeft'));
    s.key(key('Enter'));
    s.key(key('ArrowRight'));
    s.key(key('ArrowRight'));
    expect(s.cursor).not.toBeNull();
    s.keyUp('Enter');
    expect(s.history.count).toBe(1);
    expect(s.cursor).not.toBeNull();
  });
  it('Space+矢印：カーソルが出ているときだけ、描き始める（ダイアログの処理）。マウスが押されたら、キーボードの描画は終わる', () => {
    const s = fresh();
    s.key(key('Enter')); // 出すだけ
    s.key(key('Enter'));
    s.pointerDown(P(2, 2));
    s.pointerUp(P(2, 2));
    s.keyUp('Enter');
    expect(s.cursor).toBeNull();
    expect(s.history.count).toBe(2);
  });
});

describe('浮いた選択を押して離すだけ（動かさない）では、回転の中心を捨てない', () => {
  it('回す → 選択をクリック（移動量 0）→ 戻す で、位置が元に戻る', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[0, 0], [15, 0]]);
    s.transform('rotateCw');
    expect(s.doc.floating!.center).toBeDefined();
    drag(s, [[8, 1]]); // 浮いた選択の中で、押して離すだけ
    expect(s.doc.floating!.center).toBeDefined();
    s.transform('rotateCcw');
    expect(s.doc.floating).toMatchObject({ x: 0, y: 0 });
  });
});

describe('キャンバスの大きさを変えたあとのカーソル', () => {
  it('カーソルは消え、次に出すときは、前回の位置ではなく新しい絵の中央から', () => {
    const s = fresh();
    s.key(key('ArrowLeft')); // (7,8)
    expect(s.cursor).toEqual({ x: 7, y: 8 });
    s.resizeCanvas(32, 'nearest');
    expect(s.cursor).toBeNull();
    s.key(key(' '));
    s.keyUp(' ');
    expect(s.cursor).toEqual({ x: 16, y: 16 });
    expect(s.history.count).toBe(1); // 大きさの変更だけ（カーソルを出しただけで描かない）
  });
});
