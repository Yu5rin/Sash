// ペイントの操作の状態（ツール・色・履歴・ポインタとキーの処理）。DOM に触らないので、疑似のポインタの並びで試せる。
// 座標は絵の上の整数の画素（外の点も来る）。ポインタの位置からの換算は view.ts が行う。

import { t } from '../../i18n';
import type { ColorOp } from './adjust';
import { TRANSPARENT, rgbaToHex, sameRgba, type Rgba } from './color';
import { createDoc, flatten, restoreDoc, sameSnapshot, snapshotBytes, snapshotDoc, type CanvasSize, type DocSnapshot, type PaintDoc } from './doc';
import { floodFill, regionMask } from './fill';
import { History } from './history';
import { clonePixels, equalPixels, type Pixels } from './pixels';
import { brushOffsets, type Brush } from './raster';
import {
  applyColorOp, combineMask, copySelection, deleteSelection, deselect, dropFloating, inSelection, invertSelection, liftSelection, maskEllipse, maskPolygon, maskRect,
  pasteAsFloating, previewColorOp, sampleDoc, selectAll, setFloatingPos, transformContent, type SelectMode, type TransformKind,
} from './selection';
import {
  brushFootprint, constrainLine, constrainSquare, ellipseCoverage, lineCoverage, newCoverage, rectCoverage, renderCoverage, strokeBrushLine, strokePencilLine, type Coverage, type ShapeFill,
} from './stroke';
import { resizeSquare, trimToCenter, type ResizeMode } from './transform';

export type ToolId = 'pencil' | 'brush' | 'eraser' | 'fill' | 'picker' | 'line' | 'rect' | 'ellipse' | 'select' | 'ellipseSelect' | 'lasso' | 'wand';
/** ツールの並び（描く・図形・選択の順）。 */
export const TOOL_IDS: readonly ToolId[] = ['pencil', 'brush', 'eraser', 'fill', 'picker', 'line', 'rect', 'ellipse', 'select', 'ellipseSelect', 'lasso', 'wand'];

/** 選択を作るツール（持ち上げて動かせるものと、自動選択）。 */
const MARQUEE_TOOLS: readonly ToolId[] = ['select', 'ellipseSelect', 'lasso'];
const SELECT_TOOLS: readonly ToolId[] = [...MARQUEE_TOOLS, 'wand'];
const SHAPE_TOOLS: readonly ToolId[] = ['line', 'rect', 'ellipse'];

export interface ToolSettings {
  /** 鉛筆・消しゴムの筆先の太さ（1〜8）。 */
  size: number;
  /** 鉛筆・消しゴムの筆先を丸くするか。 */
  round: boolean;
  /** 塗りつぶし・自動選択の許容差（0〜100）。 */
  tolerance: number;
  /** 塗りつぶし・自動選択を、つながった所だけにするか（false は全体）。 */
  contiguous: boolean;
  /** ブラシの太さ（1〜16）。 */
  brushSize: number;
  /** ブラシの硬さ（0〜100）。 */
  hardness: number;
  /** 不透明度（0〜100）。鉛筆・ブラシ・消しゴム・図形・塗りつぶしに効く。 */
  opacity: number;
  /** ブラシと直線・楕円をなめらか（アンチエイリアス）にするか。既定は切る（ドット絵ではくっきりが大事なため）。 */
  antialias: boolean;
  /** 図形の線の太さ（1〜8）。 */
  shapeWidth: number;
  /** 図形の塗り：線だけ／塗りだけ／両方。 */
  shapeFill: ShapeFill;
}

export interface PointerInfo {
  x: number;
  y: number;
  /** 0＝左（前景色）、2＝右（背景色）。 */
  button: 0 | 2;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** ペンの消しゴム側。 */
  eraser?: boolean;
}

export interface KeyInfo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** キーを押し続けて繰り返し届いたもの。 */
  repeat?: boolean;
}

export const DEFAULT_PRIMARY: Readonly<Rgba> = Object.freeze({ r: 0x42, g: 0x42, b: 0x42, a: 255 });

type Drag =
  | { kind: 'stroke'; tool: 'pencil' | 'brush' | 'eraser'; color: Rgba; cov: Coverage; base: Pixels; last: { x: number; y: number }; label: string }
  | { kind: 'shape'; tool: 'line' | 'rect' | 'ellipse'; button: 0 | 2; ax: number; ay: number; base: Pixels; end: { x: number; y: number }; label: string }
  | { kind: 'pick'; which: 'primary' | 'secondary' }
  | { kind: 'sel'; tool: 'select' | 'ellipseSelect' | 'lasso'; ax: number; ay: number; moved: boolean; mode: SelectMode; baseMask: Uint8Array | null; points: [number, number][] }
  | { kind: 'move'; sx: number; sy: number; ox: number; oy: number; duplicate: boolean };

export interface SessionOptions {
  /** 時刻（矢印キーの連続した移動を 1 手にまとめる判定に使う。テストで差し替える）。 */
  now?: () => number;
}

/** 矢印キーの連続した移動を 1 手にまとめる間隔（ミリ秒）。 */
const ARROW_MERGE_MS = 500;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class PaintSession {
  readonly doc: PaintDoc;
  readonly history = new History<DocSnapshot>(snapshotBytes);
  tool: ToolId = 'pencil';
  primary: Rgba = { ...DEFAULT_PRIMARY };
  secondary: Rgba = { ...TRANSPARENT };
  settings: ToolSettings = {
    size: 1, round: false, tolerance: 0, contiguous: true, brushSize: 4, hardness: 100, opacity: 100, antialias: false, shapeWidth: 1, shapeFill: 'outline',
  };
  /** アプリの中のクリップボード。 */
  clipboard: Pixels | null = null;
  /** この画面の中でコピーしたばかりか（OS のクリップボードの画像より先に使う）。 */
  clipboardFresh = false;
  /** キーボードのカーソル（矢印で動かす）。まだ使っていなければ null。 */
  cursor: { x: number; y: number } | null = null;
  /**
   * キーボードのカーソルが「いま生きている」か。直前の操作が、カーソルを矢印で動かす・Enter／Space で使う、のどれかのときだけ true。
   * それ以外の操作（マウス・ツールの切り替え・選択の作成／確定／解除・選択範囲の矢印移動・元に戻す／やり直し・色の変更・Esc）が来たら false。
   * Space を離したときに描くのは、これが true のときだけ（SPEC §25.14 の遷移表）。
   */
  cursorLive = false;
  /** 色の変更のプレビュー（適用するまで、見た目だけに出す）。 */
  preview: ColorOp | null = null;
  /** 状態が変わったとき（画面の描き直しと、ボタンの表示の更新）。 */
  onChange: () => void = () => undefined;
  /** 読み上げ・状態の行に出す短い文。 */
  onAnnounce: (message: string) => void = () => undefined;
  /** 色を使ったとき（最近使った色に覚える）。#rrggbb。 */
  onColorUsed: (hex: string) => void = () => undefined;
  /** 適用していないプレビューが、ほかの操作で捨てられたとき（パネルの値を戻す）。 */
  onPreviewDropped: () => void = () => undefined;

  private before: DocSnapshot | null = null;
  private drag: Drag | null = null;
  private lastPoint: { x: number; y: number } | null = null;
  private arrow: { at: number; key: string; entry: unknown } | null = null;
  private kbdActive = false;
  private readonly now: () => number;
  /** 開いたときの絵。 */
  private readonly initial: Pixels;

  constructor(size: CanvasSize, pixels?: Pixels, opts: SessionOptions = {}) {
    this.doc = createDoc(size, pixels);
    this.initial = clonePixels(this.doc.pixels);
    this.now = opts.now ?? (() => Date.now());
  }

  /** 描いた内容が開いたときと違うか（閉じる前の確認に使う。選択だけの操作は数えない）。 */
  get changed(): boolean {
    return !equalPixels(this.displayPixels(), this.initial);
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** 画面に出す絵（浮いた選択と、色の変更のプレビューを含む）。 */
  displayPixels(): Pixels {
    return this.preview ? previewColorOp(this.doc, this.preview) : flatten(this.doc);
  }

  // ---- 履歴 ----

  private begin(): void {
    this.cursorLive = false;
    this.dropPreview();
    this.before = snapshotDoc(this.doc);
  }

  private commit(label: string): void {
    const before = this.before;
    this.before = null;
    if (!before) return;
    const after = snapshotDoc(this.doc);
    if (sameSnapshot(before, after)) return;
    this.history.push({ label, before, after });
  }

  private abort(): void {
    if (this.before) restoreDoc(this.doc, this.before);
    this.before = null;
    this.drag = null;
    this.kbdActive = false;
  }

  private dropPreview(): void {
    if (!this.preview) return;
    this.preview = null;
    this.onPreviewDropped();
  }

  undo(): boolean {
    if (this.drag) return false;
    this.cursorLive = false;
    this.dropPreview();
    const e = this.history.undo();
    this.arrow = null;
    if (!e) {
      this.onAnnounce(t('元に戻す操作はありません'));
      return false;
    }
    restoreDoc(this.doc, e.before);
    this.onAnnounce(t('元に戻しました：{label}', { label: e.label }));
    this.onChange();
    return true;
  }

  redo(): boolean {
    if (this.drag) return false;
    this.cursorLive = false;
    this.dropPreview();
    const e = this.history.redo();
    this.arrow = null;
    if (!e) {
      this.onAnnounce(t('やり直す操作はありません'));
      return false;
    }
    restoreDoc(this.doc, e.after);
    this.onAnnounce(t('やり直しました：{label}', { label: e.label }));
    this.onChange();
    return true;
  }

  // ---- ツールと色 ----

  setTool(id: ToolId): void {
    if (this.drag || id === this.tool) return;
    this.cursorLive = false;
    // 浮いた選択は、動かせる選択ツールの間だけ持ち続ける（ほかのツールで描くと、枠の中に重ねて描けてしまうため）
    if (!MARQUEE_TOOLS.includes(id) && this.doc.floating) this.commitFloating();
    this.tool = id;
    this.onAnnounce(t('ツール：{name}', { name: toolName(id) }));
    this.onChange();
  }

  setColor(which: 'primary' | 'secondary', c: Rgba): void {
    if (which === 'primary') this.primary = { ...c };
    else this.secondary = { ...c };
    this.onChange();
  }

  swapColors(): void {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    this.onChange();
  }

  resetColors(): void {
    this.primary = { ...DEFAULT_PRIMARY };
    this.secondary = { ...TRANSPARENT };
    this.onChange();
  }

  setSettings(patch: Partial<ToolSettings>): void {
    const n = { ...this.settings, ...patch };
    n.size = clamp(Math.round(n.size), 1, 8);
    n.brushSize = clamp(Math.round(n.brushSize), 1, 16);
    n.hardness = clamp(Math.round(n.hardness), 0, 100);
    n.opacity = clamp(Math.round(n.opacity), 0, 100);
    n.tolerance = clamp(Math.round(n.tolerance), 0, 100);
    n.shapeWidth = clamp(Math.round(n.shapeWidth), 1, 8);
    this.settings = n;
    this.onChange();
  }

  /** いまのツールの大きさ（太さ）を 1 つ変える（[ と ]）。大きさを持たないツールでは何もしない。 */
  adjustSize(delta: number): boolean {
    if (this.tool === 'pencil' || this.tool === 'eraser') this.setSettings({ size: this.settings.size + delta });
    else if (this.tool === 'brush') this.setSettings({ brushSize: this.settings.brushSize + delta });
    else if (SHAPE_TOOLS.includes(this.tool)) this.setSettings({ shapeWidth: this.settings.shapeWidth + delta });
    else return false;
    return true;
  }

  /** 鉛筆・消しゴムの筆先。 */
  get brush(): Brush {
    return { size: this.settings.size, round: this.settings.round };
  }

  /** 画面に出す筆先の枠（中心の画素からのずれの一覧）。描かれる範囲と同じ形にする。 */
  get hoverCells(): [number, number][] | null {
    if (this.tool === 'pencil' || this.tool === 'eraser') return brushOffsets(this.brush);
    if (this.tool === 'brush') return brushFootprint({ size: this.settings.brushSize, hardness: this.settings.hardness, antialias: this.settings.antialias });
    if (this.tool === 'fill' || this.tool === 'picker' || this.tool === 'wand' || SHAPE_TOOLS.includes(this.tool)) return [[0, 0]];
    return null;
  }

  // ---- ポインタ ----

  /** 指定のポインタで実際に使うツール（Alt でスポイト、ペンの消しゴム側で消しゴム）。 */
  private effectiveTool(p: PointerInfo): ToolId {
    if (SELECT_TOOLS.includes(this.tool) || this.tool === 'picker') return this.tool;
    if (p.alt && (this.tool === 'pencil' || this.tool === 'brush' || this.tool === 'fill')) return 'picker';
    if (p.eraser && (this.tool === 'pencil' || this.tool === 'brush')) return 'eraser';
    return this.tool;
  }

  private colorFor(p: { button: 0 | 2 }): Rgba {
    return p.button === 2 ? this.secondary : this.primary;
  }

  pointerDown(p: PointerInfo): void {
    // キーボードで描いている途中にマウスが押されたら、キーボードの描画を終える（そこまでを確定する）
    if (this.kbdActive) this.releaseKeyboard();
    if (this.drag) return;
    this.cursorLive = false;
    this.arrow = null;
    const tool = this.effectiveTool(p);
    if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') this.downStroke(p, tool);
    else if (tool === 'fill') this.downFill(p);
    else if (tool === 'picker') this.downPick(p);
    else if (tool === 'wand') this.downWand(p);
    else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') this.downShape(p, tool);
    else this.downSelect(p, tool as 'select' | 'ellipseSelect' | 'lasso');
    this.onChange();
  }

  pointerMove(p: PointerInfo): void {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'stroke') {
      this.addStroke(d, d.last.x, d.last.y, p.x, p.y);
      d.last = { x: p.x, y: p.y };
      // Shift+クリックの直線は、ドラッグの終点から引く
      this.lastPoint = { x: p.x, y: p.y };
      this.renderStroke(d);
    } else if (d.kind === 'shape') {
      d.end = { x: p.x, y: p.y };
      this.renderShape(d, p.shift);
    } else if (d.kind === 'pick') {
      this.pick(p.x, p.y, d.which);
    } else if (d.kind === 'sel') {
      this.moveSelection(d, p);
    } else {
      const dx = p.x - d.sx;
      const dy = p.y - d.sy;
      if (!this.doc.floating) {
        if (dx === 0 && dy === 0) return;
        liftSelection(this.doc, d.duplicate);
        // liftSelection が doc を書き換えるので、型の絞り込みを通さず読み直す
        const lifted = this.doc.floating as PaintDoc['floating'];
        if (lifted) {
          d.ox = lifted.x;
          d.oy = lifted.y;
        }
      }
      setFloatingPos(this.doc, d.ox + dx, d.oy + dy);
    }
    this.onChange();
  }

  pointerUp(p: PointerInfo): void {
    const d = this.drag;
    if (!d) return;
    this.pointerMove(p);
    this.drag = null;
    this.kbdActive = false;
    if (d.kind === 'stroke') {
      this.commit(d.label);
      this.colorUsed(d.color);
    } else if (d.kind === 'shape') {
      this.commit(d.label);
      this.colorUsed(this.colorFor(d));
    } else if (d.kind === 'sel') {
      // 動かさずに離した（クリックだけ）ときは、選択を外す。外した状態を 1 手として積む（足す・引くでは、何も変えない）
      if (!d.moved && d.mode === 'replace') deselect(this.doc);
      this.commit(d.moved ? (d.mode === 'add' ? t('選択に追加') : d.mode === 'subtract' ? t('選択から除外') : t('選択')) : t('選択を解除'));
    } else if (d.kind === 'move') {
      this.commit(t('選択範囲の移動'));
    } else {
      this.before = null;
    }
    this.onChange();
  }

  /** ドラッグを取り消す（Esc・ポインタの取り消し）。 */
  cancelDrag(): boolean {
    if (!this.drag) return false;
    this.abort();
    this.onChange();
    return true;
  }

  private colorUsed(c: Rgba): void {
    const hex = rgbaToHex(c);
    if (hex && c.a === 255) this.onColorUsed(hex);
  }

  // ---- 鉛筆・ブラシ・消しゴム ----

  private addStroke(d: Extract<Drag, { kind: 'stroke' }>, x0: number, y0: number, x1: number, y1: number): void {
    const size = this.doc.size;
    if (d.tool === 'brush') strokeBrushLine(d.cov, size, x0, y0, x1, y1, { size: this.settings.brushSize, hardness: this.settings.hardness, antialias: this.settings.antialias });
    else strokePencilLine(d.cov, size, x0, y0, x1, y1, this.brush);
  }

  /** ストロークを始める前の絵に、いまのカバレッジで色を重ね直す（1 回のストロークの中で、重ね塗りで濃くならない）。 */
  private renderStroke(d: Extract<Drag, { kind: 'stroke' }>): void {
    this.doc.pixels.data.set(d.base.data);
    renderCoverage(this.doc.pixels, d.cov, d.color, this.settings.opacity, this.doc.selection);
  }

  private downStroke(p: PointerInfo, tool: 'pencil' | 'brush' | 'eraser'): void {
    this.begin();
    dropFloating(this.doc);
    const color = tool === 'eraser' ? TRANSPARENT : this.colorFor(p);
    const label = tool === 'eraser' ? t('消しゴム') : tool === 'brush' ? t('ブラシ') : t('鉛筆');
    const from = p.shift && this.lastPoint ? this.lastPoint : p;
    const d: Extract<Drag, { kind: 'stroke' }> = { kind: 'stroke', tool, color, cov: newCoverage(this.doc.size), base: clonePixels(this.doc.pixels), last: { x: p.x, y: p.y }, label };
    this.addStroke(d, from.x, from.y, p.x, p.y);
    this.lastPoint = { x: p.x, y: p.y };
    this.renderStroke(d);
    this.drag = d;
  }

  // ---- 塗りつぶし・スポイト ----

  private downFill(p: PointerInfo): void {
    this.begin();
    dropFloating(this.doc);
    const base = this.colorFor(p);
    const color = base.a === 0 ? base : { ...base, a: Math.round((base.a * this.settings.opacity) / 100) };
    floodFill(this.doc.pixels, p.x, p.y, color, this.settings.tolerance, this.settings.contiguous, this.doc.selection);
    this.commit(t('塗りつぶし'));
    this.colorUsed(base);
  }

  private downPick(p: PointerInfo): void {
    const which = p.button === 2 ? 'secondary' : 'primary';
    this.pick(p.x, p.y, which);
    this.drag = { kind: 'pick', which };
  }

  private pick(x: number, y: number, which: 'primary' | 'secondary'): void {
    if (x < 0 || y < 0 || x >= this.doc.size || y >= this.doc.size) return;
    const c = sampleDoc(this.doc, x, y);
    const current = which === 'primary' ? this.primary : this.secondary;
    if (sameRgba(current, c)) return;
    if (which === 'primary') this.primary = c;
    else this.secondary = c;
    const hex = rgbaToHex(c);
    this.onAnnounce(hex ? t('スポイト：{color}', { color: hex }) : t('スポイト：透明'));
  }

  // ---- 図形 ----

  private downShape(p: PointerInfo, tool: 'line' | 'rect' | 'ellipse'): void {
    this.begin();
    dropFloating(this.doc);
    const label = tool === 'line' ? t('直線') : tool === 'rect' ? t('四角形') : t('楕円');
    const d: Extract<Drag, { kind: 'shape' }> = { kind: 'shape', tool, button: p.button, ax: p.x, ay: p.y, base: clonePixels(this.doc.pixels), end: { x: p.x, y: p.y }, label };
    this.drag = d;
    if (this.settings.shapeFill === 'both' && (p.button === 2 ? this.primary : this.secondary).a === 0) this.onAnnounce(t('背景色が透明なので、塗りは付きません。塗りたいときは、背景色を選んでください'));
    this.renderShape(d, p.shift);
  }

  /** 図形を、始める前の絵の上に描き直す（ドラッグの間はプレビュー、離すと確定）。Shift で 45° の直線・正方形・正円。 */
  private renderShape(d: Extract<Drag, { kind: 'shape' }>, shift: boolean): void {
    const size = this.doc.size;
    const s = this.settings;
    let [x1, y1] = [d.end.x, d.end.y];
    if (shift) [x1, y1] = d.tool === 'line' ? constrainLine(d.ax, d.ay, x1, y1) : constrainSquare(d.ax, d.ay, x1, y1);
    this.doc.pixels.data.set(d.base.data);
    // 左ボタンは前景色が線・背景色が塗り、右ボタンはその逆
    const lineColor = d.button === 2 ? this.secondary : this.primary;
    const fillColor = d.button === 2 ? this.primary : this.secondary;
    if (d.tool === 'line') {
      renderCoverage(this.doc.pixels, lineCoverage(size, d.ax, d.ay, x1, y1, s.shapeWidth, s.antialias), lineColor, s.opacity, this.doc.selection);
      return;
    }
    const cov = d.tool === 'rect' ? rectCoverage(size, d.ax, d.ay, x1, y1, s.shapeWidth) : ellipseCoverage(size, d.ax, d.ay, x1, y1, s.shapeWidth, s.antialias);
    // 線と塗りで、塗りの色（背景色）が透明なら、塗らない（透明で塗ると、下の絵が消えてしまう）
    if (s.shapeFill === 'fill') renderCoverage(this.doc.pixels, cov.fill, lineColor, s.opacity, this.doc.selection);
    else {
      if (s.shapeFill === 'both' && fillColor.a > 0) renderCoverage(this.doc.pixels, cov.fill, fillColor, s.opacity, this.doc.selection);
      renderCoverage(this.doc.pixels, cov.outline, lineColor, s.opacity, this.doc.selection);
    }
  }

  // ---- 選択 ----

  private modeOf(p: PointerInfo): SelectMode {
    return p.shift ? 'add' : p.alt ? 'subtract' : 'replace';
  }

  private downWand(p: PointerInfo): void {
    this.begin();
    dropFloating(this.doc);
    const region = regionMask(this.doc.pixels, p.x, p.y, this.settings.tolerance, this.settings.contiguous, null);
    this.doc.selection = combineMask(this.doc.selection, region, this.modeOf(p), this.doc.size);
    this.commit(t('自動選択'));
  }

  private downSelect(p: PointerInfo, tool: 'select' | 'ellipseSelect' | 'lasso'): void {
    this.begin();
    const mode = this.modeOf(p);
    if (mode === 'replace' && this.doc.selection && inSelection(this.doc, p.x, p.y)) {
      const f = this.doc.floating;
      // Ctrl を押しながらなら、複製（元の場所を残す）
      this.drag = { kind: 'move', sx: p.x, sy: p.y, ox: f?.x ?? 0, oy: f?.y ?? 0, duplicate: p.ctrl };
      return;
    }
    dropFloating(this.doc);
    const size = this.doc.size;
    const x = clamp(p.x, 0, size - 1);
    const y = clamp(p.y, 0, size - 1);
    this.drag = { kind: 'sel', tool, ax: x, ay: y, moved: false, mode, baseMask: this.doc.selection ? new Uint8Array(this.doc.selection) : null, points: [[x, y]] };
  }

  private moveSelection(d: Extract<Drag, { kind: 'sel' }>, p: PointerInfo): void {
    const size = this.doc.size;
    const x = clamp(p.x, 0, size - 1);
    const y = clamp(p.y, 0, size - 1);
    if (d.tool === 'lasso') {
      const last = d.points.at(-1)!;
      if (last[0] !== x || last[1] !== y) {
        d.points.push([x, y]);
        d.moved = true;
      }
    } else if (x !== d.ax || y !== d.ay) d.moved = true;
    if (!d.moved) return;
    const shape = d.tool === 'select' ? maskRect(size, d.ax, d.ay, x, y) : d.tool === 'ellipseSelect' ? maskEllipse(size, d.ax, d.ay, x, y) : maskPolygon(size, d.points);
    this.doc.selection = combineMask(d.baseMask, shape, d.mode, size);
  }

  // ---- 選択・クリップボード・画像の操作 ----

  /** 浮いた選択を確定する（1 手）。 */
  commitFloating(): boolean {
    if (!this.doc.floating) return false;
    this.begin();
    dropFloating(this.doc);
    this.commit(t('選択範囲の確定'));
    this.onChange();
    return true;
  }

  private step(label: string, change: () => boolean | void): boolean {
    if (this.drag) return false;
    this.arrow = null;
    this.begin();
    const r = change();
    this.commit(label);
    this.onChange();
    return r !== false;
  }

  selectAllPixels(): void {
    this.step(t('すべて選択'), () => {
      dropFloating(this.doc);
      selectAll(this.doc);
    });
  }

  clearSelection(): void {
    if (!this.doc.selection) return;
    this.step(t('選択を解除'), () => {
      dropFloating(this.doc);
      deselect(this.doc);
    });
  }

  /** 選択範囲を反転する（選択がなければ何もしない）。 */
  invertSelectionMask(): void {
    if (!this.doc.selection) return;
    this.step(t('選択範囲の反転'), () => invertSelection(this.doc));
  }

  deleteSelected(): void {
    if (!this.doc.selection) return;
    this.step(t('削除'), () => {
      deleteSelection(this.doc);
    });
  }

  /** 選択範囲（なければ絵の全体）を反転・回転する。 */
  transform(kind: TransformKind): void {
    const labels: Record<TransformKind, string> = { flipH: t('左右反転'), flipV: t('上下反転'), rotateCw: t('右へ 90° 回転'), rotateCcw: t('左へ 90° 回転') };
    this.step(labels[kind], () => transformContent(this.doc, kind));
    const f = this.doc.floating;
    if (f && (kind === 'rotateCw' || kind === 'rotateCcw') && (f.x < 0 || f.y < 0 || f.x + f.pixels.width > this.doc.size || f.y + f.pixels.height > this.doc.size)) this.onAnnounce(t('回した選択が絵からはみ出しています。はみ出した部分は、確定すると消えます'));
  }

  /** 選択範囲（なければ全体）に、色の変更を適用する。 */
  applyColor(label: string, op: ColorOp): void {
    this.step(label, () => {
      applyColorOp(this.doc, op);
    });
  }

  /** プレビュー中の色の変更を、そのまま適用する（［完了］のときに使う）。プレビューがなければ何もしない。 */
  commitPreview(label: string): void {
    const op = this.preview;
    if (!op) return;
    this.applyColor(label, op);
  }

  /** 色の変更のプレビューを出す（null で消す）。適用はしない。 */
  setPreview(op: ColorOp | null): void {
    this.preview = op;
    this.onChange();
  }

  /** キャンバスの大きさを変える（16・32・64）。選択は外す。 */
  resizeCanvas(size: CanvasSize, mode: ResizeMode): void {
    if (size === this.doc.size) return;
    this.step(t('キャンバスの大きさ'), () => {
      dropFloating(this.doc);
      this.doc.pixels = resizeSquare(this.doc.pixels, size, mode);
      this.doc.size = size;
      this.doc.selection = null;
      this.cursor = null;
    });
  }

  /** 余白をカットして、同じ大きさの中央へ寄せる。 */
  trimMargins(): void {
    this.step(t('余白をカット'), () => {
      dropFloating(this.doc);
      this.doc.pixels = trimToCenter(this.doc.pixels);
    });
  }

  /** 選択範囲（なければ絵の全体）をコピーする。 */
  copy(): boolean {
    const px = copySelection(this.doc) ?? flatten(this.doc);
    this.clipboard = px;
    this.clipboardFresh = true;
    this.onAnnounce(t('コピーしました'));
    return true;
  }

  cut(): boolean {
    if (!this.doc.selection && !this.doc.floating) return false;
    this.copy();
    this.deleteSelected();
    return true;
  }

  /** 画像を浮いた選択として貼り付ける（選択ツールに替わる）。 */
  pastePixels(px: Pixels): void {
    if (this.drag) return;
    this.step(t('貼り付け'), () => {
      pasteAsFloating(this.doc, px);
    });
    this.tool = 'select';
    this.onAnnounce(t('貼り付けました。ドラッグで動かし、Enter で確定します'));
    this.onChange();
  }

  pasteInternal(): boolean {
    if (!this.clipboard) return false;
    this.pastePixels(this.clipboard);
    return true;
  }

  /** Esc：ドラッグの取り消し → 浮いた選択の確定 → 選択の解除 の順に、できることを 1 つだけする。何もなければ false。 */
  escape(): boolean {
    this.cursorLive = false;
    if (this.preview) {
      this.dropPreview();
      this.onChange();
      return true;
    }
    if (this.cancelDrag()) return true;
    if (this.doc.floating) return this.commitFloating();
    if (this.doc.selection) {
      this.clearSelection();
      return true;
    }
    return false;
  }

  // ---- キー ----

  /** キー操作を処理する。処理したら true（呼び出し側が preventDefault する）。Ctrl+V は paste イベントで扱うので false。 */
  key(e: KeyInfo): boolean {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.ctrl && !e.alt) {
      if (k === 'z') {
        if (e.shift) this.redo();
        else this.undo();
        return true;
      }
      if (k === 'y') {
        this.redo();
        return true;
      }
      if (k === 'a') {
        this.selectAllPixels();
        return true;
      }
      if (k === 'd') {
        this.clearSelection();
        return true;
      }
      if (k === 'c') {
        this.copy();
        return true;
      }
      if (k === 'x') return this.cut();
      if (k.startsWith('Arrow')) return this.arrowKey(k, e.shift, true);
      return false;
    }
    if (e.ctrl || e.alt) return false;
    if (k === 'Delete' || k === 'Backspace') {
      if (!this.doc.selection) return false;
      this.deleteSelected();
      return true;
    }
    if (k === 'Enter') {
      if (this.commitFloating()) return true;
      return this.kbdDown(e);
    }
    if (k === ' ') return this.kbdDown(e);
    if (k.startsWith('Arrow')) return this.arrowKey(k, e.shift, false);
    if (k === '[' || k === ']') return this.adjustSize(k === '[' ? -1 : 1);
    if (e.shift && (k === 'm' || k === 'l')) {
      this.setTool(k === 'm' ? 'ellipseSelect' : 'lasso');
      return true;
    }
    if (e.shift) return false;
    const tools: Record<string, ToolId> = { p: 'pencil', b: 'brush', e: 'eraser', g: 'fill', i: 'picker', l: 'line', r: 'rect', o: 'ellipse', m: 'select', w: 'wand' };
    const next = tools[k];
    if (next) {
      this.setTool(next);
      return true;
    }
    if (k === 'x') {
      this.swapColors();
      return true;
    }
    if (k === 'd') {
      this.resetColors();
      return true;
    }
    return false;
  }

  /** キーを離したとき。Enter・Space で始めたキーボードの描画を終える。 */
  keyUp(key: string): boolean {
    if ((key !== 'Enter' && key !== ' ') || !this.kbdActive) return false;
    this.kbdActive = false;
    const c = this.cursor ?? { x: 0, y: 0 };
    this.pointerUp({ x: c.x, y: c.y, button: 0, shift: false, alt: false, ctrl: false });
    return true;
  }

  /** マウスがキャンバスの上を動いた。キーボードのカーソルは、画面から消えたものとして、描かない。 */
  dropCursor(): void {
    this.cursorLive = false;
  }

  /** キーボードの描画を、いまの位置で確定して終える（ウィンドウが離れたとき・マウスが押されたとき）。 */
  releaseKeyboard(): void {
    if (!this.kbdActive) return;
    this.kbdActive = false;
    const c = this.cursor ?? { x: 0, y: 0 };
    this.pointerUp({ x: c.x, y: c.y, button: 0, shift: false, alt: false, ctrl: false });
  }

  /** Enter・Space：キーボードのカーソルの位置で、いまのツールを使い始める（離すまでがドラッグ。矢印で動かすと線になる）。 */
  private kbdDown(e: KeyInfo): boolean {
    if (e.repeat) return true;
    if (this.drag || this.kbdActive) return true;
    const c = this.ensureCursor();
    this.pointerDown({ x: c.x, y: c.y, button: 0, shift: e.shift, alt: false, ctrl: false });
    // 描画の入口（pointerDown）はカーソルを下ろすので、ここで、使ったカーソルを生かし直す
    this.cursorLive = true;
    // 塗りつぶし・自動選択のように、押した瞬間に終わるツールは、離すまで続ける描画がない
    this.kbdActive = this.drag !== null;
    return true;
  }

  private ensureCursor(): { x: number; y: number } {
    if (!this.cursor) {
      const mid = Math.floor(this.doc.size / 2);
      this.cursor = { x: mid, y: mid };
    }
    return this.cursor;
  }

  /** キーボードのカーソルを動かす。描いている途中なら、そこまで線を引く。 */
  moveCursor(dx: number, dy: number, shift = false): void {
    const c = this.ensureCursor();
    const size = this.doc.size;
    this.cursor = { x: clamp(c.x + dx, 0, size - 1), y: clamp(c.y + dy, 0, size - 1) };
    this.cursorLive = true;
    if (this.kbdActive) this.pointerMove({ x: this.cursor.x, y: this.cursor.y, button: 0, shift, alt: false, ctrl: false });
    const color = sampleDoc(this.doc, this.cursor.x, this.cursor.y);
    const hex = rgbaToHex(color);
    this.onAnnounce(t('x {x}、y {y}、{color}', { x: this.cursor.x, y: this.cursor.y, color: hex ?? t('透明') }));
    this.onChange();
  }

  /** 矢印：描いている途中か Ctrl ならカーソルを動かし、選択があれば選択範囲を動かし、なければカーソルを動かす。 */
  private arrowKey(key: string, shift: boolean, ctrl: boolean): boolean {
    const step = shift ? 4 : 1;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    if (this.kbdActive || ctrl || !this.doc.selection) {
      if (this.drag && !this.kbdActive) return true;
      this.moveCursor(dx, dy, shift);
      return true;
    }
    return this.arrowMove(key, shift);
  }

  /** 矢印キーで選択を 1 画素（Shift で 4 画素）動かす。連続して押した分は 1 手にまとめる。 */
  private arrowMove(key: string, shift: boolean): boolean {
    if (this.drag || !this.doc.selection) return false;
    const step = shift ? 4 : 1;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    this.dropPreview();
    this.cursorLive = false;
    const merge = this.arrow !== null && this.arrow.key === key && this.now() - this.arrow.at < ARROW_MERGE_MS && this.history.last === this.arrow.entry;
    const before = merge ? null : snapshotDoc(this.doc);
    if (!this.doc.floating && !liftSelection(this.doc, false)) return true;
    const f = this.doc.floating!;
    setFloatingPos(this.doc, f.x + dx, f.y + dy);
    const after = snapshotDoc(this.doc);
    if (merge) this.history.amendLast(after);
    else if (before) {
      this.history.push({ label: t('選択範囲の移動'), before, after });
    }
    this.arrow = { at: this.now(), key, entry: this.history.last };
    this.onChange();
    return true;
  }
}

export function toolName(id: ToolId): string {
  switch (id) {
    case 'pencil': return t('鉛筆');
    case 'brush': return t('ブラシ');
    case 'eraser': return t('消しゴム');
    case 'fill': return t('塗りつぶし');
    case 'picker': return t('スポイト');
    case 'line': return t('直線');
    case 'rect': return t('四角形');
    case 'ellipse': return t('楕円');
    case 'select': return t('四角形の選択');
    case 'ellipseSelect': return t('楕円の選択');
    case 'lasso': return t('なげなわ');
    case 'wand': return t('自動選択');
  }
}
