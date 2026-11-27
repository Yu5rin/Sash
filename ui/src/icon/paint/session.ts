// ペイントの操作の状態（ツール・色・履歴・ポインタとキーの処理）。DOM に触らないので、疑似のポインタの並びで試せる。
// 座標は絵の上の整数の画素（外の点も来る）。ポインタの位置からの換算は view.ts が行う。

import { t } from '../../i18n';
import { TRANSPARENT, rgbaToHex, sameRgba, type Rgba } from './color';
import { createDoc, flatten, restoreDoc, sameSnapshot, snapshotBytes, snapshotDoc, type CanvasSize, type DocSnapshot, type PaintDoc } from './doc';
import { floodFill } from './fill';
import { History } from './history';
import { clonePixels, equalPixels, type Pixels } from './pixels';
import { stampLine, type Brush } from './raster';
import {
  copySelection, deleteSelection, deselect, dropFloating, inSelection, liftSelection, pasteAsFloating, sampleDoc, selectAll, selectRect, setFloatingPos,
} from './selection';

export type ToolId = 'pencil' | 'eraser' | 'fill' | 'picker' | 'select';
export const TOOL_IDS: readonly ToolId[] = ['pencil', 'eraser', 'fill', 'picker', 'select'];

export interface ToolSettings {
  /** 筆先の太さ（1〜8）。 */
  size: number;
  /** 丸い筆先か。 */
  round: boolean;
  /** 塗りつぶしの許容差（0〜100）。 */
  tolerance: number;
  /** 塗りつぶしを、つながった範囲だけにするか（false は全体）。 */
  contiguous: boolean;
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
}

export const DEFAULT_PRIMARY: Readonly<Rgba> = Object.freeze({ r: 0x42, g: 0x42, b: 0x42, a: 255 });

type Drag =
  | { kind: 'draw'; color: Rgba; last: { x: number; y: number }; label: string }
  | { kind: 'pick'; which: 'primary' | 'secondary' }
  | { kind: 'sel'; ax: number; ay: number; moved: boolean }
  | { kind: 'move'; sx: number; sy: number; ox: number; oy: number; duplicate: boolean };

export interface SessionOptions {
  /** 時刻（矢印キーの連続した移動を 1 手にまとめる判定に使う。テストで差し替える）。 */
  now?: () => number;
}

/** 矢印キーの連続した移動を 1 手にまとめる間隔（ミリ秒）。 */
const ARROW_MERGE_MS = 500;

export class PaintSession {
  readonly doc: PaintDoc;
  readonly history = new History<DocSnapshot>(snapshotBytes);
  tool: ToolId = 'pencil';
  primary: Rgba = { ...DEFAULT_PRIMARY };
  secondary: Rgba = { ...TRANSPARENT };
  settings: ToolSettings = { size: 1, round: false, tolerance: 0, contiguous: true };
  /** アプリの中のクリップボード。 */
  clipboard: Pixels | null = null;
  /** この画面の中でコピーしたばかりか（OS のクリップボードの画像より先に使う）。 */
  clipboardFresh = false;
  /** 状態が変わったとき（画面の描き直しと、ボタンの表示の更新）。 */
  onChange: () => void = () => undefined;
  /** 読み上げ・状態の行に出す短い文。 */
  onAnnounce: (message: string) => void = () => undefined;
  /** 色を使ったとき（最近使った色に覚える）。#rrggbb。 */
  onColorUsed: (hex: string) => void = () => undefined;

  private before: DocSnapshot | null = null;
  private drag: Drag | null = null;
  private lastPoint: { x: number; y: number } | null = null;
  private arrow: { at: number; key: string; entry: unknown } | null = null;
  private readonly now: () => number;

  constructor(size: CanvasSize, pixels?: Pixels, opts: SessionOptions = {}) {
    this.doc = createDoc(size, pixels);
    this.initial = clonePixels(this.doc.pixels);
    this.now = opts.now ?? (() => Date.now());
  }

  /** 開いたときの絵。 */
  private readonly initial: Pixels;

  /** 描いた内容が開いたときと違うか（閉じる前の確認に使う。選択だけの操作は数えない）。 */
  get changed(): boolean {
    return !equalPixels(flatten(this.doc), this.initial);
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  // ---- 履歴 ----

  private begin(): void {
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
  }

  undo(): boolean {
    if (this.drag) return false;
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
    // 浮いた選択は、選択ツールから離れるときに確定する（ほかのツールで描くと、枠の中に重ねて描けてしまうため）
    if (id !== 'select' && this.doc.floating) this.commitFloating();
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
    const next = { ...this.settings, ...patch };
    next.size = Math.min(8, Math.max(1, Math.round(next.size)));
    next.tolerance = Math.min(100, Math.max(0, Math.round(next.tolerance)));
    this.settings = next;
    this.onChange();
  }

  get brush(): Brush {
    return { size: this.settings.size, round: this.settings.round };
  }

  // ---- ポインタ ----

  /** 指定のポインタで実際に使うツール（Alt でスポイト、ペンの消しゴム側で消しゴム）。 */
  private effectiveTool(p: PointerInfo): ToolId {
    if (this.tool === 'select' || this.tool === 'picker') return this.tool;
    if (p.alt && (this.tool === 'pencil' || this.tool === 'fill')) return 'picker';
    if (p.eraser && this.tool === 'pencil') return 'eraser';
    return this.tool;
  }

  private colorFor(p: PointerInfo): Rgba {
    return p.button === 2 ? this.secondary : this.primary;
  }

  pointerDown(p: PointerInfo): void {
    if (this.drag) return;
    this.arrow = null;
    const tool = this.effectiveTool(p);
    if (tool === 'pencil' || tool === 'eraser') this.downDraw(p, tool);
    else if (tool === 'fill') this.downFill(p);
    else if (tool === 'picker') this.downPick(p);
    else this.downSelect(p);
    this.onChange();
  }

  pointerMove(p: PointerInfo): void {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'draw') {
      stampLine(this.doc.pixels, d.last.x, d.last.y, p.x, p.y, this.brush, d.color, this.doc.selection);
      d.last = { x: p.x, y: p.y };
    } else if (d.kind === 'pick') {
      this.pick(p.x, p.y, d.which);
    } else if (d.kind === 'sel') {
      const size = this.doc.size;
      const x = Math.min(size - 1, Math.max(0, p.x));
      const y = Math.min(size - 1, Math.max(0, p.y));
      if (x !== d.ax || y !== d.ay) d.moved = true;
      if (d.moved) selectRect(this.doc, d.ax, d.ay, x, y);
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
    if (d.kind === 'draw') {
      this.commit(d.label);
      const hex = rgbaToHex(d.color);
      if (hex && d.color.a === 255) this.onColorUsed(hex);
    } else if (d.kind === 'sel') {
      // 動かさずに離した（クリックだけ）ときは、選択を外す。外した状態を 1 手として積む
      if (!d.moved) deselect(this.doc);
      this.commit(d.moved ? t('選択') : t('選択を解除'));
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

  private downDraw(p: PointerInfo, tool: 'pencil' | 'eraser'): void {
    this.begin();
    dropFloating(this.doc);
    const color = tool === 'eraser' ? TRANSPARENT : this.colorFor(p);
    const label = tool === 'eraser' ? t('消しゴム') : t('鉛筆');
    const from = p.shift && this.lastPoint ? this.lastPoint : p;
    stampLine(this.doc.pixels, from.x, from.y, p.x, p.y, this.brush, color, this.doc.selection);
    this.lastPoint = { x: p.x, y: p.y };
    this.drag = { kind: 'draw', color, last: { x: p.x, y: p.y }, label };
  }

  private downFill(p: PointerInfo): void {
    this.begin();
    dropFloating(this.doc);
    const color = this.colorFor(p);
    floodFill(this.doc.pixels, p.x, p.y, color, this.settings.tolerance, this.settings.contiguous, this.doc.selection);
    this.commit(t('塗りつぶし'));
    const hex = rgbaToHex(color);
    if (hex && color.a === 255) this.onColorUsed(hex);
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

  private downSelect(p: PointerInfo): void {
    this.begin();
    if (this.doc.selection && inSelection(this.doc, p.x, p.y)) {
      const f = this.doc.floating;
      this.drag = { kind: 'move', sx: p.x, sy: p.y, ox: f?.x ?? 0, oy: f?.y ?? 0, duplicate: p.alt };
      return;
    }
    dropFloating(this.doc);
    const size = this.doc.size;
    this.drag = { kind: 'sel', ax: Math.min(size - 1, Math.max(0, p.x)), ay: Math.min(size - 1, Math.max(0, p.y)), moved: false };
  }

  // ---- 選択・クリップボード ----

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

  deleteSelected(): void {
    if (!this.doc.selection) return;
    this.step(t('削除'), () => {
      deleteSelection(this.doc);
    });
  }

  copy(): boolean {
    const px = copySelection(this.doc);
    if (!px) return false;
    this.clipboard = px;
    this.clipboardFresh = true;
    this.onAnnounce(t('コピーしました'));
    return true;
  }

  cut(): boolean {
    if (!this.copy()) return false;
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
      if (k === 'x') {
        this.cut();
        return true;
      }
      return false;
    }
    if (e.ctrl || e.alt) return false;
    if (k === 'Delete' || k === 'Backspace') {
      if (!this.doc.selection) return false;
      this.deleteSelected();
      return true;
    }
    if (k === 'Enter') return this.commitFloating();
    if (k.startsWith('Arrow')) return this.arrowMove(k, e.shift);
    if (e.shift) return false;
    const tools: Record<string, ToolId> = { p: 'pencil', e: 'eraser', g: 'fill', i: 'picker', m: 'select' };
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

  /** 矢印キーで選択を 1 画素（Shift で 4 画素）動かす。連続して押した分は 1 手にまとめる。選択がなければ何もしない。 */
  private arrowMove(key: string, shift: boolean): boolean {
    if (this.drag || !this.doc.selection) return false;
    const step = shift ? 4 : 1;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
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
    case 'eraser': return t('消しゴム');
    case 'fill': return t('塗りつぶし');
    case 'picker': return t('スポイト');
    case 'select': return t('四角形の選択');
  }
}
