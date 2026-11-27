// ペイント画面の canvas への描画（拡大・市松模様・グリッド・選択の点線・筆先の枠）と、ポインタの位置から画素への換算。
// 絵の処理そのものは持たない（DOM と canvas だけ）。拡大は整数倍だけ。

import type { PaintDoc } from './doc';
import type { Pixels } from './pixels';

/** 選べる拡大率（整数倍だけ。ドットがにじまない）。 */
export const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;

/** 画面に収まる、いちばん大きい整数倍の拡大率（最低 1）。 */
export function fitZoom(availWidth: number, availHeight: number, size: number): number {
  const room = Math.min(availWidth, availHeight);
  let best: number = ZOOMS[0];
  for (const z of ZOOMS) if (z * size <= room) best = z;
  return best;
}

/** 今の拡大率から 1 段階上げる・下げる。端ではそのまま。 */
export function stepZoom(current: number, dir: 1 | -1): number {
  const i = ZOOMS.findIndex((z) => z >= current);
  const at = i < 0 ? ZOOMS.length - 1 : i;
  const next = Math.min(ZOOMS.length - 1, Math.max(0, at + dir));
  return ZOOMS[next]!;
}

/**
 * 画面の位置から、絵の上の画素への換算。left・top は canvas の左上、originX・originY は絵の左上（canvas の中での位置）。
 * 絵の外は範囲の外の整数になる（線は外から入ってこられる）。
 */
export function pointToPixel(clientX: number, clientY: number, left: number, top: number, originX: number, originY: number, zoom: number): { x: number; y: number } {
  return { x: Math.floor((clientX - left - originX) / zoom), y: Math.floor((clientY - top - originY) / zoom) };
}

/** 絵が表示の枠より大きいときだけ動かせる。小さいときは中央に固定。余白は 24px まで外へ出せる。 */
export function clampPan(pan: number, imageLength: number, viewLength: number): number {
  if (imageLength <= viewLength) return 0;
  const limit = (imageLength - viewLength) / 2 + 24;
  return Math.min(limit, Math.max(-limit, pan));
}

const CHECK_LIGHT = '#ffffff';
const CHECK_DARK = '#e6e6e6';
/** 市松模様の 1 マスの大きさ（画面の px。拡大しても目が細かくならない）。 */
const CHECK = 8;

export class PaintView {
  readonly canvas: HTMLCanvasElement;
  zoom = 8;
  gridOn = true;
  /** 筆先の枠を出す画素（ポインタが絵の上にあるとき）。 */
  hover: { x: number; y: number } | null = null;
  hoverCells: [number, number][] | null = null;
  /** キーボードのカーソルの画素（矢印で動かしているとき）。 */
  cursor: { x: number; y: number } | null = null;
  private panX = 0;
  private panY = 0;
  private dpr = 1;
  private viewW = 0;
  private viewH = 0;
  private dashOffset = 0;
  private readonly off = document.createElement('canvas');
  private readonly observer: ResizeObserver | null;
  private timer = 0;
  private raf = 0;

  constructor(private readonly stage: HTMLElement, private readonly getDoc: () => PaintDoc, private readonly getPixels: () => Pixels, private readonly onResize: () => void = () => undefined) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'paint-canvas';
    stage.append(this.canvas);
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize());
    this.observer?.observe(stage);
    // 選択の点線を動かす（動きを減らす設定のときは止める）
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      this.timer = window.setInterval(() => {
        if (!this.getDoc().selection) return;
        this.dashOffset = (this.dashOffset + 1) % 8;
        this.render();
      }, 140);
    }
    // 最初の大きさは、ResizeObserver が表示後に知らせてくる（ここで呼ぶと、呼び出し側の部品がそろう前に onResize が動く）
  }

  dispose(): void {
    this.observer?.disconnect();
    window.clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  /** 絵の左上（canvas の中の位置）。 */
  get origin(): { x: number; y: number } {
    const len = this.getDoc().size * this.zoom;
    return { x: Math.round((this.viewW - len) / 2 + clampPan(this.panX, len, this.viewW)), y: Math.round((this.viewH - len) / 2 + clampPan(this.panY, len, this.viewH)) };
  }

  /** 表示の枠の大きさ（CSS px）。全体表示の計算に使う。 */
  get viewSize(): { width: number; height: number } {
    return { width: this.viewW, height: this.viewH };
  }

  toPixel(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const o = this.origin;
    return pointToPixel(clientX, clientY, r.left, r.top, o.x, o.y, this.zoom);
  }

  setZoom(zoom: number, anchor?: { clientX: number; clientY: number }): void {
    if (zoom === this.zoom) return;
    const size = this.getDoc().size;
    let fx = size / 2;
    let fy = size / 2;
    let ax = this.viewW / 2;
    let ay = this.viewH / 2;
    if (anchor) {
      const r = this.canvas.getBoundingClientRect();
      const o = this.origin;
      ax = anchor.clientX - r.left;
      ay = anchor.clientY - r.top;
      fx = (ax - o.x) / this.zoom;
      fy = (ay - o.y) / this.zoom;
    } else {
      const o = this.origin;
      fx = (this.viewW / 2 - o.x) / this.zoom;
      fy = (this.viewH / 2 - o.y) / this.zoom;
    }
    this.zoom = zoom;
    const len = size * zoom;
    // 同じ画素が、同じ位置に残るように動かす
    this.panX = ax - fx * zoom - (this.viewW - len) / 2;
    this.panY = ay - fy * zoom - (this.viewH - len) / 2;
    this.render();
    this.onResize();
  }

  /** 全体が入る、いちばん大きい整数倍にして、中央に置く。 */
  fit(): void {
    this.panX = 0;
    this.panY = 0;
    this.zoom = fitZoom(this.viewW - 16, this.viewH - 16, this.getDoc().size);
    this.render();
    this.onResize();
  }

  panBy(dx: number, dy: number): void {
    const len = this.getDoc().size * this.zoom;
    this.panX = clampPan(this.panX + dx, len, this.viewW);
    this.panY = clampPan(this.panY + dy, len, this.viewH);
    this.render();
  }

  /** 画素 (x, y) の全体が、表示の枠の中に見えているか。 */
  isVisible(p: { x: number; y: number }): boolean {
    const o = this.origin;
    const z = this.zoom;
    const left = o.x + p.x * z;
    const top = o.y + p.y * z;
    return left >= 0 && top >= 0 && left + z <= this.viewW && top + z <= this.viewH;
  }

  /** 画素 (x, y) が見えるように、表示を動かす（見えていれば何もしない）。キーボードのカーソルが、画面の外へ出ないようにする。 */
  ensureVisible(p: { x: number; y: number }): void {
    if (this.isVisible(p)) return;
    const o = this.origin;
    const z = this.zoom;
    const left = o.x + p.x * z;
    const top = o.y + p.y * z;
    const dx = left < 0 ? -left : left + z > this.viewW ? this.viewW - (left + z) : 0;
    const dy = top < 0 ? -top : top + z > this.viewH ? this.viewH - (top + z) : 0;
    this.panBy(dx, dy);
  }

  /** 絵が枠より大きく、動かせるか。 */
  get canPan(): boolean {
    const len = this.getDoc().size * this.zoom;
    return len > this.viewW || len > this.viewH;
  }

  private resize(): void {
    const r = this.stage.getBoundingClientRect();
    this.viewW = Math.max(1, Math.floor(r.width));
    this.viewH = Math.max(1, Math.floor(r.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.viewW}px`;
    this.canvas.style.height = `${this.viewH}px`;
    this.canvas.width = Math.round(this.viewW * this.dpr);
    this.canvas.height = Math.round(this.viewH * this.dpr);
    // 最初の表示（枠の大きさが決まったとき）に、全体を表示する
    if (!this.sized && r.width > 0 && r.height > 0) {
      this.sized = true;
      this.fit();
      return;
    }
    this.render();
    this.onResize();
  }

  private sized = false;

  /** 1 フレームに 1 回にまとめて描く。 */
  requestRender(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const doc = this.getDoc();
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    const o = this.origin;
    const len = doc.size * this.zoom;

    // 透明の市松模様（枠の中に収まる範囲だけ）
    ctx.save();
    ctx.beginPath();
    ctx.rect(o.x, o.y, len, len);
    ctx.clip();
    ctx.fillStyle = CHECK_LIGHT;
    ctx.fillRect(o.x, o.y, len, len);
    ctx.fillStyle = CHECK_DARK;
    const x0 = Math.max(0, Math.floor((0 - o.x) / CHECK));
    const y0 = Math.max(0, Math.floor((0 - o.y) / CHECK));
    const x1 = Math.min(Math.ceil(len / CHECK), Math.ceil((this.viewW - o.x) / CHECK));
    const y1 = Math.min(Math.ceil(len / CHECK), Math.ceil((this.viewH - o.y) / CHECK));
    for (let cy = y0; cy < y1; cy++) for (let cx = x0; cx < x1; cx++) if ((cx + cy) % 2 === 1) ctx.fillRect(o.x + cx * CHECK, o.y + cy * CHECK, CHECK, CHECK);
    ctx.restore();

    // 絵（拡大してもにじまない）
    const px = this.getPixels();
    this.off.width = px.width;
    this.off.height = px.height;
    this.off.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, o.x, o.y, len, len);

    if (this.gridOn && this.zoom >= 6) this.drawGrid(ctx, o, doc.size);
    if (doc.selection) this.drawSelection(ctx, o, doc);
    if (this.hover && this.hoverCells) this.drawHover(ctx, o, this.hover, false);
    if (this.cursor) this.drawHover(ctx, o, this.cursor, true);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, o: { x: number; y: number }, size: number): void {
    const z = this.zoom;
    const len = size * z;
    ctx.save();
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.35)';
    ctx.lineWidth = 1 / this.dpr;
    ctx.beginPath();
    for (let i = 1; i < size; i++) {
      // デバイスピクセルに合わせて、線がぼけないようにする
      const gx = Math.round((o.x + i * z) * this.dpr) / this.dpr + 0.5 / this.dpr;
      const gy = Math.round((o.y + i * z) * this.dpr) / this.dpr + 0.5 / this.dpr;
      ctx.moveTo(gx, o.y);
      ctx.lineTo(gx, o.y + len);
      ctx.moveTo(o.x, gy);
      ctx.lineTo(o.x + len, gy);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 選択の境目に、白と黒の点線を引く。 */
  private drawSelection(ctx: CanvasRenderingContext2D, o: { x: number; y: number }, doc: PaintDoc): void {
    const sel = doc.selection!;
    const n = doc.size;
    const z = this.zoom;
    ctx.beginPath();
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (sel[y * n + x] === 0) continue;
        const px = o.x + x * z;
        const py = o.y + y * z;
        if (x === 0 || sel[y * n + x - 1] === 0) { ctx.moveTo(px, py); ctx.lineTo(px, py + z); }
        if (x === n - 1 || sel[y * n + x + 1] === 0) { ctx.moveTo(px + z, py); ctx.lineTo(px + z, py + z); }
        if (y === 0 || sel[(y - 1) * n + x] === 0) { ctx.moveTo(px, py); ctx.lineTo(px + z, py); }
        if (y === n - 1 || sel[(y + 1) * n + x] === 0) { ctx.moveTo(px, py + z); ctx.lineTo(px + z, py + z); }
      }
    }
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineDashOffset = 0 - this.dashOffset;
    ctx.stroke();
    ctx.strokeStyle = '#000000';
    ctx.lineDashOffset = 4 - this.dashOffset;
    ctx.stroke();
    ctx.restore();
  }

  private drawHover(ctx: CanvasRenderingContext2D, o: { x: number; y: number }, at: { x: number; y: number }, dashed: boolean): void {
    const size = this.getDoc().size;
    const z = this.zoom;
    ctx.save();
    ctx.lineWidth = 1;
    if (dashed) ctx.setLineDash([3, 2]);
    for (const [dx, dy] of (this.hoverCells ?? [[0, 0]])) {
      const x = at.x + dx;
      const y = at.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.strokeRect(o.x + x * z + 0.5, o.y + y * z + 0.5, z - 1, z - 1);
      if (z >= 4) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.strokeRect(o.x + x * z + 1.5, o.y + y * z + 1.5, z - 3, z - 3);
      }
    }
    ctx.restore();
  }
}
