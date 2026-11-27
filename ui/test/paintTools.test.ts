import { describe, expect, it } from 'vitest';
import { PaintSession, type PointerInfo } from '../src/icon/paint/session';
import { flatten } from '../src/icon/paint/doc';
import { COLORS, fromTable, maskTable, toTable } from './helpers/paintTable';

const P = (x: number, y: number, o: Partial<PointerInfo> = {}): PointerInfo => ({ x, y, button: 0, shift: false, alt: false, ctrl: false, ...o });
const key = (k: string, o: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ key: k, ctrl: !!o.ctrl, shift: !!o.shift, alt: !!o.alt });

/** down → move … → up の並び。 */
function drag(s: PaintSession, pts: [number, number][], o: Partial<PointerInfo> = {}): void {
  s.pointerDown(P(pts[0]![0], pts[0]![1], o));
  for (const [x, y] of pts.slice(1)) s.pointerMove(P(x, y, o));
  const last = pts.at(-1)!;
  s.pointerUp(P(last[0], last[1], o));
}

// 16 のキャンバスの左上 4×4 だけを見る
const top = (s: PaintSession, rows = 4): string[] => toTable(flatten(s.doc)).slice(0, rows).map((r) => r.slice(0, 4));
const fresh = (rows?: string[]) => {
  const px = rows ? fromTable(rows.map((r) => r.padEnd(16, '.')).concat(Array(16 - rows.length).fill('.'.repeat(16)))) : undefined;
  const s = new PaintSession(16, px);
  s.setColor('primary', COLORS['r']!);
  s.setColor('secondary', COLORS['.']!);
  return s;
};

describe('鉛筆', () => {
  it('ドラッグで線が引け、1 回のドラッグが 1 手になる', () => {
    const s = fresh();
    drag(s, [[0, 0], [1, 1], [2, 2], [3, 3]]);
    expect(top(s)).toEqual(['r...', '.r..', '..r.', '...r']);
    expect(s.history.count).toBe(1);
    s.undo();
    expect(top(s)).toEqual(['....', '....', '....', '....']);
  });
  it('間の点が飛んでも線でつなぐ', () => {
    const s = fresh();
    drag(s, [[0, 1], [3, 1]]);
    expect(top(s)[1]).toBe('rrrr');
  });
  it('右ボタンは背景色（透明）で描く＝消える', () => {
    const s = fresh(['rrrr', 'rrrr']);
    drag(s, [[1, 0], [2, 0]], { button: 2 });
    expect(top(s, 2)).toEqual(['r..r', 'rrrr']);
  });
  it('Shift+クリックは、前の点から直線を引く', () => {
    const s = fresh();
    drag(s, [[0, 0]]);
    drag(s, [[3, 0]], { shift: true });
    expect(top(s)[0]).toBe('rrrr');
  });
  it('太さ 2 の四角で描く', () => {
    const s = fresh();
    s.setSettings({ size: 2 });
    drag(s, [[1, 1]]);
    expect(top(s)).toEqual(['....', '.rr.', '.rr.', '....']);
  });
  it('変化のない描画（同じ色の上）は履歴に積まない', () => {
    const s = fresh(['r']);
    drag(s, [[0, 0]]);
    expect(s.history.count).toBe(0);
  });
  it('選択があれば、その中にだけ描く', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[1, 0], [2, 1]]);
    s.setTool('pencil');
    drag(s, [[0, 0], [3, 0]]);
    expect(top(s, 2)).toEqual(['.rr.', '....']);
  });
  it('描いた色を最近使った色として知らせる（不透明の色だけ）', () => {
    const s = fresh();
    const used: string[] = [];
    s.onColorUsed = (h) => used.push(h);
    drag(s, [[0, 0]]);
    drag(s, [[1, 0]], { button: 2 });
    expect(used).toEqual(['#ff0000']);
  });
  it('ドラッグ中の Esc で取り消せる', () => {
    const s = fresh();
    s.pointerDown(P(0, 0));
    s.pointerMove(P(3, 0));
    expect(s.escape()).toBe(true);
    expect(top(s)[0]).toBe('....');
    expect(s.history.count).toBe(0);
    expect(s.dragging).toBe(false);
  });
});

describe('消しゴム', () => {
  it('透明にする', () => {
    const s = fresh(['rrrr']);
    s.setTool('eraser');
    drag(s, [[1, 0], [2, 0]]);
    expect(top(s, 1)).toEqual(['r..r']);
  });
  it('ペンの消しゴム側は、鉛筆でも消す', () => {
    const s = fresh(['rrrr']);
    drag(s, [[0, 0]], { eraser: true });
    expect(top(s, 1)).toEqual(['.rrr']);
  });
});

describe('塗りつぶし', () => {
  it('クリックした所と同じ色の範囲を塗る。1 手', () => {
    const s = fresh(Array(16).fill('..#')); // 縦に壁がある
    s.setTool('fill');
    drag(s, [[0, 0]]);
    expect(top(s, 2)).toEqual(['rr#.', 'rr#.']);
    expect(s.history.count).toBe(1);
  });
  it('許容差と「全体」を使える', () => {
    const s = fresh(Array(16).fill('..#'));
    s.setTool('fill');
    s.setSettings({ contiguous: false });
    drag(s, [[0, 0]]);
    expect(top(s, 2)).toEqual(['rr#r', 'rr#r']);
  });
  it('右クリックは背景色（透明）で塗る', () => {
    const s = fresh(['rrr.', 'rrr.']);
    s.setTool('fill');
    drag(s, [[0, 0]], { button: 2 });
    expect(top(s, 2)).toEqual(['....', '....']);
  });
  it('Alt を押している間は、塗りつぶしがスポイトになる', () => {
    const s = fresh(['b...']);
    s.setTool('fill');
    drag(s, [[0, 0]], { alt: true });
    expect(s.primary).toEqual(COLORS['b']);
    expect(top(s, 1)).toEqual(['b...']);
    expect(s.history.count).toBe(0);
  });
});

describe('スポイト', () => {
  it('左クリックで前景色、右クリックで背景色に取る。透明も取れる。履歴には積まない', () => {
    const s = fresh(['bg..']);
    s.setTool('picker');
    drag(s, [[0, 0]]);
    drag(s, [[1, 0]], { button: 2 });
    expect(s.primary).toEqual(COLORS['b']);
    expect(s.secondary).toEqual(COLORS['g']);
    drag(s, [[3, 0]]);
    expect(s.primary.a).toBe(0);
    expect(s.history.count).toBe(0);
  });
  it('絵の外では何も取らない', () => {
    const s = fresh();
    s.setTool('picker');
    drag(s, [[-1, 0]]);
    expect(s.primary).toEqual(COLORS['r']);
  });
  it('ドラッグしながら取り続ける', () => {
    const s = fresh(['bg..']);
    s.setTool('picker');
    drag(s, [[0, 0], [1, 0]]);
    expect(s.primary).toEqual(COLORS['g']);
  });
});

describe('四角形の選択と移動', () => {
  it('ドラッグで選択し、クリックで解除する。それぞれ 1 手', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[1, 1], [3, 2]]);
    expect(maskTable(s.doc.selection!, 16).slice(0, 4).map((r) => r.slice(0, 5))).toEqual(['.....', '.###.', '.###.', '.....']);
    expect(s.history.count).toBe(1);
    drag(s, [[10, 10]]);
    expect(s.doc.selection).toBeNull();
    expect(s.history.count).toBe(2);
  });
  it('絵の外までドラッグしても、範囲に収まる', () => {
    const s = fresh();
    s.setTool('select');
    drag(s, [[14, 14], [30, 30]]);
    expect(maskTable(s.doc.selection!, 16).slice(13).map((r) => r.slice(12))).toEqual(['....', '..##', '..##']);
  });
  it('選択の中をドラッグすると、中身が動く（元の場所は透明になる）。1 手', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [1, 1], [2, 2]]);
    expect(top(s)).toEqual(['....', '....', '..rr', '..rr']);
    expect(s.history.count).toBe(2);
    s.undo();
    expect(top(s)).toEqual(['rr..', 'rr..', '....', '....']);
    s.redo();
    expect(top(s)).toEqual(['....', '....', '..rr', '..rr']);
  });
  it('動かさずに離したら、持ち上げない（履歴も増えない）', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0]]);
    expect(s.doc.floating).toBeNull();
    expect(s.history.count).toBe(1);
  });
  it('Ctrl+ドラッグは複製', () => {
    const s = fresh(['r']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [2, 2]], { ctrl: true });
    expect(top(s)).toEqual(['r...', '....', '..r.', '....']);
  });
  it('選択の外をクリックすると、浮いた選択が確定する', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [3, 3]]);
    expect(s.doc.floating).not.toBeNull();
    drag(s, [[12, 12]]);
    expect(s.doc.floating).toBeNull();
    expect(top(s)).toEqual(['....', '....', '....', '...r']);
  });
  it('別のツールに替えると浮いた選択が確定する', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [2, 2]]);
    s.setTool('pencil');
    expect(s.doc.floating).toBeNull();
    expect(top(s)).toEqual(['....', '....', '..rr', '..rr']);
  });
});

describe('キー', () => {
  it('Esc の順番：浮いた選択を確定 → 選択を解除 → 何もなければ false', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [2, 2]]);
    expect(s.escape()).toBe(true);
    expect(s.doc.floating).toBeNull();
    expect(s.doc.selection).not.toBeNull();
    expect(s.escape()).toBe(true);
    expect(s.doc.selection).toBeNull();
    expect(s.escape()).toBe(false);
  });
  it('Delete は選択の中を透明にする。選択がなければ処理しない', () => {
    const s = fresh(['rrrr', 'rrrr']);
    expect(s.key(key('Delete'))).toBe(false);
    s.setTool('select');
    drag(s, [[1, 0], [2, 1]]);
    expect(s.key(key('Delete'))).toBe(true);
    expect(top(s, 2)).toEqual(['r..r', 'r..r']);
  });
  it('Ctrl+A・Ctrl+D・Ctrl+Z・Ctrl+Y', () => {
    const s = fresh();
    s.key(key('a', { ctrl: true }));
    expect(s.doc.selection!.every((v) => v === 255)).toBe(true);
    s.key(key('d', { ctrl: true }));
    expect(s.doc.selection).toBeNull();
    s.key(key('z', { ctrl: true }));
    expect(s.doc.selection).not.toBeNull();
    s.key(key('y', { ctrl: true }));
    expect(s.doc.selection).toBeNull();
    s.key(key('z', { ctrl: true }));
    s.key(key('z', { ctrl: true, shift: true }));
    expect(s.doc.selection).toBeNull();
  });
  it('P E G I M で道具を替え、X で色を入れ替え、D で既定に戻す', () => {
    const s = fresh();
    for (const [k, id] of [['e', 'eraser'], ['g', 'fill'], ['i', 'picker'], ['m', 'select'], ['p', 'pencil']] as const) {
      expect(s.key(key(k))).toBe(true);
      expect(s.tool).toBe(id);
    }
    s.key(key('x'));
    expect(s.primary.a).toBe(0);
    expect(s.secondary).toEqual(COLORS['r']);
    s.key(key('d'));
    expect(s.primary).toEqual({ r: 0x42, g: 0x42, b: 0x42, a: 255 });
    expect(s.secondary.a).toBe(0);
  });
  it('知らないキー・修飾キーつきは処理しない', () => {
    const s = fresh();
    expect(s.key(key('q'))).toBe(false);
    expect(s.key(key('v', { ctrl: true }))).toBe(false);
    expect(s.key(key('Home'))).toBe(false);
  });
  it('矢印で選択を 1 画素（Shift で 4 画素）動かす。連続した分は 1 手', () => {
    let t = 0;
    const s = new PaintSession(16, fromTable(['r'.padEnd(16, '.'), ...Array(15).fill('.'.repeat(16))]), { now: () => t });
    s.setTool('select');
    drag(s, [[0, 0], [0, 1]]);
    s.setTool('select');
    const n = s.history.count;
    s.key(key('ArrowRight'));
    t += 100;
    s.key(key('ArrowRight'));
    t += 100;
    s.key(key('ArrowDown', { shift: true }));
    expect(s.doc.floating).toMatchObject({ x: 2, y: 4 });
    // 向きが違うので、別の手
    expect(s.history.count).toBe(n + 2);
    t += 1000;
    s.key(key('ArrowDown'));
    expect(s.history.count).toBe(n + 3);
    s.undo();
    expect(s.doc.floating).toMatchObject({ x: 2, y: 4 });
  });
  it('Enter は浮いた選択を確定する', () => {
    const s = fresh(['rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 0]]);
    drag(s, [[0, 0], [3, 3]]);
    expect(s.key(key('Enter'))).toBe(true);
    expect(s.doc.floating).toBeNull();
  });
});

describe('コピー・切り取り・貼り付け', () => {
  it('コピーして貼り付けると、中央に浮いた選択になり、選択ツールに替わる', () => {
    const s = fresh(['rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 0]]);
    s.key(key('c', { ctrl: true }));
    expect(s.clipboard).not.toBeNull();
    expect(s.pasteInternal()).toBe(true);
    expect(s.tool).toBe('select');
    expect(s.doc.floating).toMatchObject({ x: 7, y: 7 });
    expect(top(s, 1)).toEqual(['rr..']);
  });
  it('切り取りは、コピーして透明にする', () => {
    const s = fresh(['rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 0]]);
    s.key(key('x', { ctrl: true }));
    expect(top(s, 1)).toEqual(['....']);
    expect(s.clipboard).not.toBeNull();
  });
  it('選択がなければ絵の全体をコピーする。クリップボードが空なら貼り付けない。選択がなければ切り取らない', () => {
    const s = fresh(['rr']);
    expect(s.pasteInternal()).toBe(false);
    expect(s.cut()).toBe(false);
    expect(s.copy()).toBe(true);
    expect(s.clipboard!.width).toBe(16);
    expect(toTable(s.clipboard!)[0].slice(0, 4)).toBe('rr..');
  });
  it('OS の画像（pastePixels）も浮いた選択になる。貼り付けも 1 手', () => {
    const s = fresh();
    s.pastePixels(fromTable(['bb', 'bb']));
    expect(s.doc.floating).toMatchObject({ x: 7, y: 7 });
    expect(s.history.count).toBe(1);
    s.undo();
    expect(s.doc.floating).toBeNull();
  });
});

describe('元に戻す・やり直し', () => {
  it('描いた順に戻せ、戻した後に描くとやり直しは消える', () => {
    const s = fresh();
    drag(s, [[0, 0]]);
    drag(s, [[1, 0]]);
    s.undo();
    s.undo();
    expect(top(s, 1)).toEqual(['....']);
    s.redo();
    expect(top(s, 1)).toEqual(['r...']);
    drag(s, [[2, 0]]);
    expect(s.history.canRedo).toBe(false);
  });
  it('開いたときと違うかを、選択だけの操作では数えない', () => {
    const s = fresh();
    expect(s.changed).toBe(false);
    s.selectAllPixels();
    expect(s.changed).toBe(false);
    drag(s, [[0, 0]]);
    expect(s.changed).toBe(true);
    s.undo();
    expect(s.changed).toBe(false);
  });
  it('読み上げの文を出す', () => {
    const s = fresh();
    const said: string[] = [];
    s.onAnnounce = (m) => said.push(m);
    drag(s, [[0, 0]]);
    s.undo();
    expect(said.at(-1)).toContain('鉛筆');
  });
});

describe('見直しの指摘（第 1 段階）', () => {
  it('ドラッグのあとの Shift+クリックは、ドラッグの終点から直線を引く', () => {
    const s = fresh();
    drag(s, [[0, 0], [2, 0]]);
    drag(s, [[2, 2]], { shift: true });
    expect(top(s)).toEqual(['rrr.', '..r.', '..r.', '....']);
  });
  it('浮いた選択を絵の外へ全部出して Delete しても、空の選択は残らず、描ける', () => {
    const s = fresh(['rr', 'rr']);
    s.setTool('select');
    drag(s, [[0, 0], [1, 1]]);
    drag(s, [[0, 0], [30, 30]]);
    expect(s.key(key('Delete'))).toBe(true);
    expect(s.doc.selection).toBeNull();
    s.setTool('pencil');
    drag(s, [[3, 3]]);
    expect(top(s)[3]).toBe('...r');
  });
});
