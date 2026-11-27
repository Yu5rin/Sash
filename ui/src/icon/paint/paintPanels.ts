// ペイント画面の右の列と、上の道具の行の、ツールごとの設定・選択範囲の色・画像の操作（第 2 段階）。DOM の組み立てだけで、
// 絵の処理は session.ts と adjust.ts にある（ここは、値を集めて session に渡す）。

import { h } from '../../dom';
import { t } from '../../i18n';
import {
  adjustHsl, grayscaleMasked, invertColorsMasked, makeTransparentMasked, monochromeMasked, opacityMasked, replaceColorMasked, type ColorOp,
} from './adjust';
import { parseRgba, rgbaToHex, type Rgba } from './color';
import type { CanvasSize } from './doc';
import type { PaintSession, ToolId } from './session';
import type { ShapeFill } from './stroke';
import type { ResizeMode } from './transform';

export interface Panel {
  el: HTMLElement;
  /** session の状態に表示を合わせる。 */
  sync(): void;
}

const small = (text: string, title: string, onclick: () => void): HTMLButtonElement =>
  h('button', { type: 'button', class: 'small', title, onclick }, text) as HTMLButtonElement;

/** スライダー＋数値の入力欄（同じ値を 2 か所から変えられる）。 */
function sliderRow(label: string, min: number, max: number, value: number, onInput: (v: number) => void, title?: string): { el: HTMLElement; set(v: number): void; get(): number } {
  const range = h('input', { type: 'range', min, max, value, 'aria-label': label, title }) as HTMLInputElement;
  const num = h('input', { type: 'number', min, max, value, class: 'paint-num', 'aria-label': t('{name}の数値', { name: label }) }) as HTMLInputElement;
  const set = (v: number) => {
    const c = Math.min(max, Math.max(min, Math.round(v)));
    range.value = String(c);
    num.value = String(c);
  };
  range.addEventListener('input', () => {
    num.value = range.value;
    onInput(Number(range.value));
  });
  num.addEventListener('input', () => {
    if (num.value.trim() === '' || Number.isNaN(Number(num.value))) return;
    set(Number(num.value));
    onInput(Number(range.value));
  });
  return { el: h('label', { class: 'paint-slider' }, h('span', { class: 'paint-slider-label' }, label), range, num), set, get: () => Number(range.value) };
}

/** 色の入力（色見本＋ #RRGGBB の欄）。 */
function colorField(label: string, initial: Rgba | null, onChange: (c: Rgba) => void): { el: HTMLElement; set(c: Rgba | null): void } {
  const swatch = h('span', { class: 'paint-mini-swatch' });
  const input = h('input', { type: 'text', class: 'paint-hex', placeholder: '#RRGGBB', 'aria-label': label, maxlength: 9 }) as HTMLInputElement;
  const set = (c: Rgba | null) => {
    swatch.style.background = c && c.a > 0 ? `rgb(${c.r}, ${c.g}, ${c.b})` : '';
    input.value = c ? (rgbaToHex(c)?.slice(0, 7) ?? '') : '';
  };
  input.addEventListener('change', () => {
    const c = parseRgba(input.value);
    if (c) {
      set(c);
      onChange(c);
    } else input.setAttribute('aria-invalid', 'true');
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  set(initial);
  return { el: h('span', { class: 'paint-color-field', title: label }, swatch, input), set };
}

// ---- ツールごとの設定（道具の行） ----

export function buildToolSettings(session: PaintSession): Panel {
  const s = () => session.settings;
  const group = (tools: ToolId[], ...children: HTMLElement[]) => ({ el: h('div', { class: 'paint-settings' }, children), tools });
  const numSelect = (label: string, title: string, max: number, onchange: (n: number) => void) =>
    h('select', { 'aria-label': label, title, onchange: (e: Event) => onchange(Number((e.target as HTMLSelectElement).value)) },
      Array.from({ length: max }, (_, i) => h('option', { value: String(i + 1) }, `${i + 1}`))) as HTMLSelectElement;
  const check = (text: string, title: string, onchange: (v: boolean) => void) => {
    const box = h('input', { type: 'checkbox', onchange: () => onchange(box.checked) }) as HTMLInputElement;
    return { box, el: h('label', { class: 'check', title }, box, text) };
  };

  const pencilSize = numSelect(t('太さ'), t('筆先の太さ（1〜8 ドット）。[ ] キーでも変えられます'), 8, (n) => session.setSettings({ size: n }));
  const round = check(t('丸い筆先'), t('筆先を丸くします'), (v) => session.setSettings({ round: v }));
  const brushSize = numSelect(t('太さ'), t('ブラシの太さ（1〜16 ドット）。[ ] キーでも変えられます'), 16, (n) => session.setSettings({ brushSize: n }));
  const hardness = sliderRowLite(t('硬さ'), 0, 100, 100, (v) => session.setSettings({ hardness: v }), t('100 は縁までくっきり。小さいほど縁がやわらかくなります'));
  const aa = check(t('なめらか'), t('縁をなめらか（アンチエイリアス）にします。ドット絵では切っておくと、くっきり描けます'), (v) => session.setSettings({ antialias: v }));
  const aaShape = check(t('なめらか'), t('線と楕円の縁をなめらか（アンチエイリアス）にします。切ると、ドットがくっきりします'), (v) => session.setSettings({ antialias: v }));
  const width = numSelect(t('線の太さ'), t('線の太さ（1〜8 ドット）。[ ] キーでも変えられます'), 8, (n) => session.setSettings({ shapeWidth: n }));
  const fill = h('select', { 'aria-label': t('塗り'), title: t('線だけ、塗りだけ、線と塗りの両方。線は前景色、塗りは背景色です（右ボタンのドラッグは逆）。背景色が透明のときは、線と塗りでも塗りは付きません'), onchange: (e: Event) => session.setSettings({ shapeFill: (e.target as HTMLSelectElement).value as ShapeFill }) },
    h('option', { value: 'outline' }, t('線だけ')), h('option', { value: 'fill' }, t('塗りだけ')), h('option', { value: 'both' }, t('線と塗り'))) as HTMLSelectElement;
  const tol = sliderRowLite(t('許容差'), 0, 100, 0, (v) => session.setSettings({ tolerance: v }), t('0 は同じ色だけ。上げると近い色もまとめて扱います'));
  const contig = check(t('つながった所だけ'), t('クリックした所とつながった範囲だけにします。切ると、絵の全体から同じ色を探します'), (v) => session.setSettings({ contiguous: v }));
  const opacity = sliderRowLite(t('不透明度'), 0, 100, 100, (v) => session.setSettings({ opacity: v }), t('描く色の濃さ。100 で不透明、小さいほど下の色が透けます'));

  const groups = [
    group(['pencil', 'eraser'], h('label', null, t('太さ'), pencilSize), round.el),
    group(['brush'], h('label', null, t('太さ'), brushSize), hardness.el, aa.el),
    group(['line', 'rect', 'ellipse'], h('label', null, t('線の太さ'), width), h('label', { class: 'paint-shape-fill' }, t('塗り'), fill), aaShape.el),
    group(['fill', 'wand'], tol.el, contig.el),
    group(['pencil', 'brush', 'eraser', 'fill', 'line', 'rect', 'ellipse'], opacity.el),
  ];

  return {
    el: h('div', { class: 'paint-tool-settings-inner' }, groups.map((g) => g.el)),
    sync() {
      for (const g of groups) g.el.hidden = !g.tools.includes(session.tool);
      pencilSize.value = String(s().size);
      round.box.checked = s().round;
      brushSize.value = String(s().brushSize);
      hardness.set(s().hardness);
      aa.box.checked = s().antialias;
      aaShape.box.checked = s().antialias;
      // 四角形に、なめらかは関係しない（画素の格子に合う）
      aaShape.el.hidden = session.tool === 'rect';
      width.value = String(s().shapeWidth);
      fill.value = s().shapeFill;
      tol.set(s().tolerance);
      contig.box.checked = s().contiguous;
      opacity.set(s().opacity);
    },
  };
}

/** ラベル・スライダー・値（道具の行の中の、小さなもの）。 */
function sliderRowLite(label: string, min: number, max: number, value: number, onInput: (v: number) => void, title: string): { el: HTMLElement; set(v: number): void } {
  const range = h('input', { type: 'range', min, max, value, 'aria-label': label, title, oninput: () => {
    out.textContent = range.value;
    onInput(Number(range.value));
  } }) as HTMLInputElement;
  const out = h('span', { class: 'paint-tol-value' }, String(value));
  return { el: h('label', { title }, label, range, out), set: (v) => { range.value = String(v); out.textContent = String(v); } };
}

// ---- 選択範囲の色 ----

export interface AdjustHooks {
  /** 次にキャンバスをクリックした色を、cb に渡す（スポイト）。 */
  pickFromCanvas(cb: (c: Rgba) => void): void;
}

export function buildAdjustPanel(session: PaintSession, hooks: AdjustHooks): Panel & { reset(): void; setFrom(c: Rgba): void } {
  const scope = h('p', { class: 'paint-scope muted small', role: 'status' });
  const hsl = { hue: 0, saturation: 0, lightness: 0 };
  const rep: { from: Rgba | null; to: Rgba; tolerance: number } = { from: null, to: { r: 0, g: 112, b: 192, a: 255 }, tolerance: 10 };
  let opacityPct = 100;

  const preview = (op: ColorOp | null) => session.setPreview(op);
  // 適用のとき、スライダーを戻す処理（reset）が先に走っても変わらないよう、値は作る時点で写しておく
  const hslOp = (): ColorOp => {
    const v = { ...hsl };
    return (px, m) => adjustHsl(px, m, v);
  };
  const hslNeutral = () => hsl.hue === 0 && hsl.saturation === 0 && hsl.lightness === 0;
  const hueRow = sliderRow(t('色相'), -180, 180, 0, (v) => { hsl.hue = v; preview(hslNeutral() ? null : hslOp()); }, t('色相を回します（−180〜180°）'));
  const satRow = sliderRow(t('彩度'), -100, 100, 0, (v) => { hsl.saturation = v; preview(hslNeutral() ? null : hslOp()); }, t('鮮やかさ（今の彩度に掛けます）。−100 で灰色、+100 で 2 倍。灰色は変わりません'));
  const lightRow = sliderRow(t('明るさ'), -100, 100, 0, (v) => { hsl.lightness = v; preview(hslNeutral() ? null : hslOp()); }, t('−100 で黒、100 で白に近づけます'));

  const repOp = (): ColorOp | null => {
    if (!rep.from) return null;
    const { from, to, tolerance } = rep;
    return (px, m) => replaceColorMasked(px, m, from, to, tolerance);
  };
  const fromField = colorField(t('置き換える前の色'), null, (c) => { rep.from = c; preview(repOp()); });
  const toField = colorField(t('置き換えたあとの色'), rep.to, (c) => { rep.to = c; preview(repOp()); });
  const tolRow = sliderRow(t('許容差'), 0, 100, rep.tolerance, (v) => { rep.tolerance = v; preview(repOp()); }, t('0 は同じ色だけ。上げると近い色（縁の混ざった色も）まで置き換えます'));
  const needFrom = () => {
    if (rep.from) return true;
    session.onAnnounce(t('置き換える前の色を選んでください'));
    return false;
  };

  const opacityOp = (): ColorOp => {
    const pct = opacityPct;
    return (px, m) => opacityMasked(px, m, pct);
  };
  const opRow = sliderRow(t('不透明度'), 0, 100, 100, (v) => { opacityPct = v; preview(opacityPct === 100 ? null : opacityOp()); }, t('今の濃さの何 % にするか。0 で透明になります'));

  const reset = () => {
    hsl.hue = hsl.saturation = hsl.lightness = 0;
    hueRow.set(0);
    satRow.set(0);
    lightRow.set(0);
    opacityPct = 100;
    opRow.set(100);
  };
  const apply = (label: string, op: ColorOp) => {
    session.applyColor(label, op);
    reset();
  };

  const section = (title: string, ...children: (HTMLElement | null)[]) => h('section', { class: 'paint-section' }, h('h3', null, title), children);
  const el = h('div', { class: 'paint-adjust' },
    scope,
    section(t('色相・彩度・明るさ'), h('p', { class: 'muted small paint-gray-hint' }, t('灰色は、色相・彩度では変わりません')), hueRow.el, satRow.el, lightRow.el,
      h('div', { class: 'paint-actions' },
        small(t('適用'), t('選択範囲（なければ全体）に、この色の変更を適用します'), () => { if (!hslNeutral()) apply(t('色相・彩度・明るさ'), hslOp()); }),
        small(t('取り消し'), t('プレビューをやめて、スライダーを元に戻します'), () => { reset(); preview(null); }))),
    section(t('色の置き換え'),
      h('div', { class: 'paint-replace-row' }, h('span', { class: 'paint-slider-label' }, t('元の色')), fromField.el,
        small(t('絵から取る'), t('絵の中の色をクリックして、置き換える前の色にします'), () => hooks.pickFromCanvas((c) => { rep.from = c; fromField.set(c); preview(repOp()); })),
        small(t('前景色'), t('前景色を、置き換える前の色にします'), () => { rep.from = { ...session.primary }; fromField.set(rep.from); preview(repOp()); })),
      h('div', { class: 'paint-replace-row' }, h('span', { class: 'paint-slider-label' }, t('新しい色')), toField.el,
        small(t('前景色'), t('前景色を、置き換えたあとの色にします'), () => { rep.to = { ...session.primary }; toField.set(rep.to); preview(repOp()); })),
      tolRow.el,
      h('div', { class: 'paint-actions' },
        small(t('適用'), t('元の色に近い色を、新しい色に置き換えます。縁の半透明にも、近さに応じて効きます'), () => { const op = repOp(); if (needFrom() && op) apply(t('色の置き換え'), op); }),
        small(t('この色を透明にする'), t('元の色に近い色を透明にします（背景を抜くときに使います）'), () => {
          if (!needFrom()) return;
          const { from, tolerance } = rep;
          apply(t('この色を透明にする'), (px, m) => makeTransparentMasked(px, m, from!, tolerance));
        }))),
    // 使う回数が少ないので、折りたたんでおく（768px の高さでも、スクロールを減らすため）
    h('details', { class: 'paint-section paint-more', ontoggle: (e: Event) => {
      // 開いたとき、中身が見える位置までスクロールする
      const d = e.target as HTMLDetailsElement;
      if (d.open) d.lastElementChild?.scrollIntoView({ block: 'nearest' });
    } }, h('summary', null, t('そのほか')),
      h('div', { class: 'paint-actions' },
        small(t('単色化'), t('絵のシルエットを、前景色の 1 色にします（アルファは保ちます）'), () => {
          const c = { ...session.primary };
          apply(t('単色化'), (px, m) => monochromeMasked(px, m, c));
        }),
        small(t('色の反転'), t('色を反転します（アルファは保ちます）'), () => apply(t('色の反転'), invertColorsMasked)),
        small(t('グレースケール'), t('明るさだけの灰色にします'), () => apply(t('グレースケール'), grayscaleMasked))),
      opRow.el,
      h('div', { class: 'paint-actions' }, small(t('不透明度を適用'), t('選択範囲（なければ全体）の濃さを、スライダーの割合にします'), () => { if (opacityPct !== 100) apply(t('不透明度'), opacityOp()); }))));

  return {
    el,
    reset,
    setFrom(c) {
      rep.from = c;
      fromField.set(c);
      preview(repOp());
    },
    sync() {
      scope.textContent = session.doc.selection || session.doc.floating ? t('対象：選択範囲') : t('対象：絵の全体（選択がないとき）');
    },
  };
}

// ---- 画像・選択の操作 ----

export interface ImageHooks {
  /** キャンバスの大きさが変わったあとに、表示を合わせる。 */
  afterResize(): void;
}

export function buildImagePanel(session: PaintSession, hooks: ImageHooks): Panel {
  const scope = h('p', { class: 'paint-scope muted small', role: 'status' });
  const sizeSel = h('select', { 'aria-label': t('キャンバスの大きさ') }, [16, 32, 64].map((n) => h('option', { value: String(n) }, `${n} × ${n}`))) as HTMLSelectElement;
  const modeSel = h('select', { 'aria-label': t('大きさを変えるときの補間'), title: t('最近傍はドットを保ちます。なめらかは、縮小で面積の平均、拡大で補間して混ぜます') },
    h('option', { value: 'nearest' }, t('最近傍（ドットを保つ）')), h('option', { value: 'smooth' }, t('なめらか'))) as HTMLSelectElement;
  const invertBtn = small(t('選択範囲を反転'), t('選択している所と、していない所を入れ替えます'), () => session.invertSelectionMask());
  const section = (title: string, ...children: HTMLElement[]) => h('section', { class: 'paint-section' }, h('h3', null, title), children);

  return {
    el: h('div', { class: 'paint-image' },
      scope,
      section(t('選択'),
        h('div', { class: 'paint-actions' },
          small(t('すべて選択'), t('絵の全体を選びます (Ctrl+A)'), () => session.selectAllPixels()),
          small(t('選択を解除'), t('選択を外します (Ctrl+D)'), () => session.clearSelection()),
          invertBtn)),
      section(t('反転・回転'),
        h('div', { class: 'paint-actions' },
          small(t('左右反転'), t('選択範囲（なければ全体）を左右に反転します'), () => session.transform('flipH')),
          small(t('上下反転'), t('選択範囲（なければ全体）を上下に反転します'), () => session.transform('flipV')),
          small(t('右へ 90°'), t('選択範囲（なければ全体）を右へ 90° 回します'), () => session.transform('rotateCw')),
          small(t('左へ 90°'), t('選択範囲（なければ全体）を左へ 90° 回します'), () => session.transform('rotateCcw')))),
      section(t('キャンバス'),
        h('div', { class: 'paint-replace-row' }, sizeSel, modeSel),
        h('div', { class: 'paint-actions' },
          small(t('大きさを変える'), t('絵全体を、選んだ大きさに拡大・縮小します。出力は 16・32・64 のどれかに合わせて作られます'), () => {
            session.resizeCanvas(Number(sizeSel.value) as CanvasSize, modeSel.value as ResizeMode);
            hooks.afterResize();
          }),
          small(t('余白をカット'), t('描かれた部分の囲みを、キャンバスの中央に寄せます（大きさは変えません）'), () => session.trimMargins())))),
    sync() {
      scope.textContent = session.doc.selection || session.doc.floating ? t('対象：選択範囲') : t('対象：絵の全体（選択がないとき）');
      invertBtn.disabled = !session.doc.selection;
      sizeSel.value = String(session.doc.size);
    },
  };
}
