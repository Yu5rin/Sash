// 「描いて編集」ダイアログ（ペイント画面）。16／32／64px の 1 枚の絵を、鉛筆・塗りつぶし・選択などで直接編集する。
// 画素の処理は session.ts（DOM なし）に任せ、ここは画面の組み立て・ポインタとキーの受け口・アイコンエディタとの受け渡しだけを持つ。
// キー操作はダイアログの中身（root）で受ける。dialog そのものに付けると、modal.ts の Enter の処理が先に動いて［完了］が押されてしまう。

import './paint.css';
import { h, svg } from '../../dom';
import { ask, openModal, type ModalHandle } from '../../dialogs/modal';
import { t } from '../../i18n';
import { uiIcons } from '../../icons';
import { buildColorPalette, colorLabel, type ColorPalette } from '../../fluent/colorPalette';
import { normalizeHex, pushRecent } from '../../fluent/iconPalette';
import { analyzePixels } from '../../imageStats';
import { notify } from '../../clipboard';
import { TRANSPARENT, parseRgba, rgbaToHex, type Rgba } from './color';
import { flatten, type CanvasSize } from './doc';
import { getPixel, type Pixels } from './pixels';
import { maskBounds } from './selection';
import { PaintSession, toolName, TOOL_IDS, type PointerInfo, type ToolId } from './session';
import { sourceScale, upscaleNearest } from './transform';
import { PaintView, ZOOMS, stepZoom } from './view';

export interface PaintDialogOptions {
  canvas: CanvasSize;
  /** 描き始めの絵（canvas × canvas）。省略は空の絵。 */
  pixels?: Pixels;
  /** アイコンエディタの出力の大きさ（プレビューをこの大きさで作る）。 */
  outputSize: 32 | 64;
  /** 画像の名前（見出しに出す）。 */
  name: string;
  /** ［完了］を押したとき。描いた絵（浮いた選択も重ねたもの）を渡す。 */
  onDone: (result: { pixels: Pixels; canvas: CanvasSize }) => void;
  /** 閉じたとき（完了でも取り消しでも）。 */
  onClose: () => void;
}

const wrap = (body: string, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  pencil: wrap('<path d="M4 20l1-4L16.5 4.5a2 2 0 013 3L8 19z"/><path d="M14.5 6.5l3 3"/>'),
  eraser: wrap('<path d="M20 20H9L4 15a2 2 0 010-3L13 3a2 2 0 013 0l5 5a2 2 0 010 3L13 20"/><path d="M8 11l6 6"/>'),
  fill: wrap('<path d="M5 12L12 5l7 7-7 7z"/><path d="M3 12h16"/><path d="M20.5 15.5s2 2.3 2 3.7a2 2 0 01-4 0c0-1.4 2-3.7 2-3.7z"/>'),
  picker: wrap('<path d="M15 4l5 5-3 1-1.5-1.5L6 18l-3 3v-3l9.5-9.5L11 7z"/><path d="M14 5l5 5"/>'),
  select: wrap('<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 3"/>'),
  grid: wrap('<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16M8 4v16M16 4v16M4 8h16M4 16h16"/>', 18),
  swap: wrap('<path d="M7 4L3 8l4 4M3 8h12M17 20l4-4-4-4M21 16H9"/>', 16),
  help: wrap('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 3.5M12 17v.2"/>', 16),
} as const;

const TOOL_KEYS: Record<ToolId, string> = { pencil: 'P', eraser: 'E', fill: 'G', picker: 'I', select: 'M' };

/** 使い方の一行（状態の行に出す。初めての人向けの手引き）。 */
function toolHint(id: ToolId): string {
  switch (id) {
    case 'pencil': return t('鉛筆：左クリックで前景色、右クリックで背景色（最初は透明）で描きます。Shift+クリックで前の点から直線を引きます');
    case 'eraser': return t('消しゴム：ドラッグしたところを透明にします。右の太さで大きさを変えます');
    case 'fill': return t('塗りつぶし：クリックした所と同じ色の範囲を塗ります。許容差を上げると、近い色もまとめて塗ります');
    case 'picker': return t('スポイト：クリックした所の色を前景色に取ります（右クリックは背景色）。透明も取れます');
    case 'select': return t('四角形の選択：ドラッグで範囲を選び、中をドラッグで動かします。Alt を押しながらで複製、Delete で消去、Esc で確定');
  }
}

/** ツールのツールチップ（何ができるか）。 */
function toolTip(id: ToolId): string {
  const tip: Record<ToolId, string> = {
    pencil: t('1 ドットずつ描きます。左クリックは前景色、右クリックは背景色（透明なら消えます）。太さは上の欄で変えられます'),
    eraser: t('描いたところを透明にします。太さは上の欄で変えられます'),
    fill: t('クリックした所とつながった同じ色の範囲を、前景色で塗ります。右クリックは背景色で塗ります'),
    picker: t('絵の中の色を取って、前景色にします。右クリックは背景色にします。鉛筆と塗りつぶしの途中でも、Alt を押している間はスポイトになります'),
    select: t('四角形で範囲を選びます。中をドラッグして動かし、Alt で複製、Delete で消去、Ctrl+C / X / V で切り取り・貼り付けができます'),
  };
  return t('{name} ({key})：{tip}', { name: toolName(id), key: TOOL_KEYS[id], tip: tip[id] });
}

// ---- 最近使った色（覚えておく。保存できない環境では、開いている間だけ） ----

const RECENT_KEY = 'sash.paint.recent';
let recentColors: string[] | null = null;

function loadRecent(): string[] {
  if (recentColors) return recentColors;
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    recentColors = Array.isArray(v) ? v.map((c) => normalizeHex(String(c))).filter((c): c is string => c !== null).slice(0, 8) : [];
  } catch {
    recentColors = [];
  }
  return recentColors;
}

function rememberColor(hex: string): string[] {
  recentColors = pushRecent(loadRecent(), hex);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors));
  } catch {
    // 保存できなくても、開いている間は覚えている
  }
  return recentColors;
}

const GUIDE_KEY = 'sash.paint.guide';

function guideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}

/** ペイント画面を開く。 */
export function openPaintDialog(o: PaintDialogOptions): ModalHandle {
  const session = new PaintSession(o.canvas, o.pixels);
  /** パレットで色を選ぶと、どちらの色が変わるか。 */
  let target: 'primary' | 'secondary' = 'primary';
  let spaceDown = false;
  let panning: { x: number; y: number } | null = null;
  /** ドラッグを始めたポインタの情報（ボタン・消しゴム側）。 */
  let active: { id: number; button: 0 | 2; eraser: boolean } | null = null;
  let previewTimer = 0;

  // ---- 部品 ----

  const stage = h('div', { class: 'paint-stage', tabIndex: 0, role: 'application', 'aria-roledescription': t('ドット絵のキャンバス'), 'aria-label': t('{size} × {size} のアイコン。ツールは P・E・G・I・M のキーで切り替えます', { size: o.canvas }) });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });

  const btn = (cls: string, icon: string, label: string, onclick: () => void) =>
    h('button', { type: 'button', class: `icon-button ${cls}`, title: label, 'aria-label': label, onclick }, svg(icon)) as HTMLButtonElement;

  const undoBtn = btn('paint-undo', uiIcons.undo, t('元に戻す (Ctrl+Z)'), () => session.undo());
  const redoBtn = btn('paint-redo', uiIcons.redo, t('やり直す (Ctrl+Y)'), () => session.redo());

  const zoomSelect = h('select', { class: 'paint-zoom', title: t('拡大率（整数倍だけ）。数字キー 1〜6 でも変えられます'), 'aria-label': t('拡大率'),
    onchange: () => view.setZoom(Number(zoomSelect.value)) }, ZOOMS.map((z) => h('option', { value: String(z) }, `${z}×`))) as HTMLSelectElement;
  const zoomOut = h('button', { type: 'button', class: 'icon-button', title: t('縮小 (-)'), 'aria-label': t('縮小'), onclick: () => view.setZoom(stepZoom(view.zoom, -1)) }, '−');
  const zoomIn = h('button', { type: 'button', class: 'icon-button', title: t('拡大 (+)'), 'aria-label': t('拡大'), onclick: () => view.setZoom(stepZoom(view.zoom, 1)) }, '+');
  const zoomFit = h('button', { type: 'button', class: 'small', title: t('全体が入る、いちばん大きい倍率にします (0)'), onclick: () => view.fit() }, t('全体'));
  const gridBtn = h('button', { type: 'button', class: 'icon-button paint-grid', 'aria-pressed': 'true', title: t('ピクセルのグリッド（6 倍以上で表示されます）'), 'aria-label': t('ピクセルのグリッド'),
    onclick: () => {
      view.gridOn = !view.gridOn;
      gridBtn.setAttribute('aria-pressed', String(view.gridOn));
      view.render();
    } }, svg(ICONS.grid)) as HTMLButtonElement;

  // ツールの設定（ツールによって出し分ける）
  const sizeSelect = h('select', { 'aria-label': t('太さ'), title: t('筆先の太さ（1〜8 ドット）'), onchange: () => session.setSettings({ size: Number(sizeSelect.value) }) },
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { value: String(n) }, `${n}`))) as HTMLSelectElement;
  const roundBox = h('input', { type: 'checkbox', onchange: () => session.setSettings({ round: roundBox.checked }) }) as HTMLInputElement;
  const tolInput = h('input', { type: 'range', min: 0, max: 100, value: 0, 'aria-label': t('許容差'), title: t('0 は同じ色だけ。上げると近い色もまとめて塗ります'),
    oninput: () => session.setSettings({ tolerance: Number(tolInput.value) }) }) as HTMLInputElement;
  const tolValue = h('span', { class: 'paint-tol-value' }, '0');
  const contigBox = h('input', { type: 'checkbox', checked: true, onchange: () => session.setSettings({ contiguous: contigBox.checked }) }) as HTMLInputElement;
  const brushSettings = h('div', { class: 'paint-settings' }, h('label', null, t('太さ'), sizeSelect), h('label', { class: 'check' }, roundBox, t('丸い筆先')));
  const fillSettings = h('div', { class: 'paint-settings' }, h('label', null, t('許容差'), tolInput, tolValue), h('label', { class: 'check' }, contigBox, t('つながった所だけ')));
  const canvasInfo = h('span', { class: 'paint-info muted small' }, t('キャンバス {size} × {size} → 出力 {out} × {out}', { size: o.canvas, out: o.outputSize }));

  const top = h('div', { class: 'paint-top' },
    h('div', { class: 'paint-group' }, undoBtn, redoBtn),
    h('div', { class: 'paint-group' }, zoomOut, zoomSelect, zoomIn, zoomFit, gridBtn),
    h('div', { class: 'paint-group paint-tool-settings' }, brushSettings, fillSettings),
    canvasInfo);

  // ツールのボタン（矢印キーで移れるように、Tab で止まるのは 1 つだけ）
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const id of TOOL_IDS) {
    toolButtons.set(id, h('button', { type: 'button', class: 'paint-tool', 'aria-pressed': 'false', 'aria-label': `${toolName(id)} (${TOOL_KEYS[id]})`, title: toolTip(id), dataset: { tool: id }, onclick: () => session.setTool(id) }, svg(ICONS[id])) as HTMLButtonElement);
  }
  const tools = h('div', { class: 'paint-tools', role: 'group', 'aria-label': t('ツール') }, [...toolButtons.values()]);
  tools.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const list = [...toolButtons.values()];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]!.focus();
  });

  // 色：前景色・背景色（どちらをパレットで変えるかを選ぶ）
  const swatchButton = (which: 'primary' | 'secondary') =>
    h('button', { type: 'button', class: 'paint-swatch', 'aria-pressed': String(which === target), dataset: { which }, onclick: () => { target = which; syncColors(); } }, h('span', { class: 'paint-swatch-fill' })) as HTMLButtonElement;
  const primaryBtn = swatchButton('primary');
  const secondaryBtn = swatchButton('secondary');
  const swapBtn = h('button', { type: 'button', class: 'icon-button', title: t('前景色と背景色を入れ替えます (X)'), 'aria-label': t('前景色と背景色を入れ替える'), onclick: () => session.swapColors() }, svg(ICONS.swap)) as HTMLButtonElement;
  const resetBtn = h('button', { type: 'button', class: 'small', title: t('前景色を灰色、背景色を透明に戻します (D)'), onclick: () => session.resetColors() }, t('既定の色')) as HTMLButtonElement;
  const transparentBtn = h('button', { type: 'button', class: 'small', title: t('選んでいるほうの色を「透明」にします。背景色を透明にしておくと、右クリックで描いたところが消えます'), onclick: () => session.setColor(target, TRANSPARENT) }, t('透明にする')) as HTMLButtonElement;
  const colorState = h('p', { class: 'muted small paint-color-state' });
  const palette: ColorPalette = buildColorPalette({
    value: rgbaToHex(session.primary) ?? '#424242',
    recent: loadRecent(),
    label: '色を入力（#RRGGBB）',
    onPick: (c) => {
      const rgba = parseRgba(c);
      if (rgba) session.setColor(target, rgba);
    },
  });

  const previews = h('div', { class: 'icon-preview-row paint-previews' });
  const bgNote = h('p', { class: 'paint-note small', hidden: true });

  const side = h('div', { class: 'paint-side' },
    h('section', { class: 'paint-section' },
      h('h3', null, t('色')),
      h('div', { class: 'paint-colors' },
        h('div', { class: 'paint-swatch-pair', role: 'group', 'aria-label': t('パレットで変える色') }, secondaryBtn, primaryBtn),
        h('div', { class: 'paint-color-actions' }, swapBtn, resetBtn, transparentBtn)),
      colorState,
      palette.el),
    h('section', { class: 'paint-section' },
      h('h3', null, t('プレビュー（実寸）')),
      previews,
      bgNote));

  // 初めて開いたときだけ出す手引き
  let guide: HTMLElement | null = null;
  if (!guideSeen()) {
    guide = h('div', { class: 'paint-guide', role: 'note' },
      h('p', null, t('左クリックで前景色、右クリックで背景色（最初は透明）で描きます。Ctrl+Z で元に戻せます。')),
      h('button', { type: 'button', class: 'small', onclick: () => dismissGuide() }, t('わかった')));
  }
  const stageWrap = h('div', { class: 'paint-stage-wrap' }, stage, guide);
  const dismissGuide = () => {
    guide?.remove();
    guide = null;
    try {
      localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      // 保存できなければ、毎回出る
    }
    stage.focus();
  };

  const root = h('div', { class: 'paint-editor' }, top, h('div', { class: 'paint-main' }, tools, stageWrap, side), live);

  const coords = h('span', { class: 'paint-coords muted small' });
  const hint = h('span', { class: 'paint-hint muted small' });
  const helpBtn = h('button', { type: 'button', class: 'icon-button', title: t('ショートカットの一覧'), 'aria-label': t('ショートカットの一覧'), onclick: () => showHelp() }, svg(ICONS.help));
  const statusBox = h('div', { class: 'footer-start paint-status' }, helpBtn, coords, hint);
  const cancelBtn = h('button', { type: 'button', onclick: () => modal.requestClose() }, t('キャンセル'));
  const doneBtn = h('button', { type: 'button', class: 'primary', onclick: () => finish() }, t('完了'));

  // 表示の部品は、ほかの部品がそろってから作る（作った直後に拡大率の表示を更新するため）
  const view = new PaintView(stage, () => session.doc, () => updateZoomUi());

  const modal = openModal(t('描いて編集：{name}', { name: o.name }), root, {
    size: 'xl',
    initialFocus: stage,
    footer: [statusBox, cancelBtn, doneBtn],
    // Esc は内側から順に処理する（ドラッグの取り消し → 浮いた選択の確定 → 選択の解除）。何もなければ閉じる確認へ
    onEscape: () => session.escape(),
    beforeClose: async () => {
      if (!session.changed) return true;
      const a = await ask(t('描いた内容を捨てますか？'), t('描いた内容は、［完了］を押さないと反映されません。'), [
        { value: 'discard', label: t('捨てる'), danger: true },
        { value: 'cancel', label: t('戻る'), primary: true },
      ]);
      return a === 'discard';
    },
    onClose: () => {
      window.removeEventListener('blur', onBlur);
      window.clearTimeout(previewTimer);
      view.dispose();
      o.onClose();
    },
  });
  // ファイルを背景に落とされても、ブラウザがそのファイルを開いてしまわないようにする（下のアイコンエディタは inert で受けない）
  modal.root.parentElement?.addEventListener('dragover', (e) => e.preventDefault());
  modal.root.parentElement?.addEventListener('drop', (e) => e.preventDefault());

  // ---- 画面の更新 ----

  const hexOf = (c: Rgba): string => rgbaToHex(c)?.toUpperCase() ?? t('透明');

  function paintSwatch(btn: HTMLButtonElement, c: Rgba, which: 'primary' | 'secondary'): void {
    const fill = btn.firstElementChild as HTMLElement;
    fill.style.background = c.a === 0 ? '' : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
    fill.classList.toggle('transparent', c.a === 0);
    const name = which === 'primary' ? t('前景色') : t('背景色');
    const hex = rgbaToHex(c);
    const label = hex ? colorLabel(hex.slice(0, 7)) : t('透明');
    btn.title = t('{name}：{color}。押すと、パレットで変える色にします', { name, color: label });
    btn.setAttribute('aria-label', t('{name}：{color}', { name, color: label }));
    btn.setAttribute('aria-pressed', String(target === which));
  }

  function syncColors(): void {
    paintSwatch(primaryBtn, session.primary, 'primary');
    paintSwatch(secondaryBtn, session.secondary, 'secondary');
    const c = target === 'primary' ? session.primary : session.secondary;
    const hex = rgbaToHex(c);
    if (hex) palette.setValue(hex.slice(0, 7));
    colorState.textContent = t('パレットで変える色：{name}（{color}）', { name: target === 'primary' ? t('前景色') : t('背景色'), color: hexOf(c) });
  }

  function updateZoomUi(): void {
    zoomSelect.value = String(view.zoom);
    zoomOut.toggleAttribute('disabled', view.zoom <= ZOOMS[0]);
    zoomIn.toggleAttribute('disabled', view.zoom >= ZOOMS[ZOOMS.length - 1]!);
    stage.classList.toggle('can-pan', view.canPan);
  }

  function schedulePreview(): void {
    if (previewTimer) return;
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      renderPreviews();
    }, 60);
  }

  /** 出力と同じ作り方（整数倍の最近傍。出力より大きいキャンバスは縮める）で、16・32px の実寸を並べる。 */
  function renderPreviews(): void {
    const px = flatten(session.doc);
    const k = sourceScale(o.canvas, o.outputSize);
    const big = upscaleNearest(px, k);
    const src = document.createElement('canvas');
    src.width = big.width;
    src.height = big.height;
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(big.data), big.width, big.height), 0, 0);
    const out = document.createElement('canvas');
    out.width = o.outputSize;
    out.height = o.outputSize;
    const octx = out.getContext('2d')!;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(src, 0, 0, o.outputSize, o.outputSize);
    const url = out.toDataURL('image/png');
    const one = (bg: string, size: number) => h('div', { class: `icon-preview ${bg}` }, h('img', { src: url, width: size, height: size, alt: '' }), h('span', null, size === 16 ? t('小') : t('大')));
    previews.replaceChildren(one('light', 16), one('light', 32), one('dark', 16), one('dark', 32));
    const stats = analyzePixels(px.data, px.width, px.height);
    bgNote.hidden = stats.solidBackground === null;
    bgNote.textContent = stats.solidBackground === null ? '' : t('背景が透明になっていません。背景を残したくないときは、消しゴムか、背景色（透明）での右クリックで消してください');
  }

  function updateUi(): void {
    for (const [id, b] of toolButtons) {
      b.setAttribute('aria-pressed', String(id === session.tool));
      b.tabIndex = id === session.tool ? 0 : -1;
    }
    undoBtn.disabled = !session.history.canUndo;
    redoBtn.disabled = !session.history.canRedo;
    undoBtn.title = session.history.undoLabel ? t('元に戻す (Ctrl+Z)：{label}', { label: session.history.undoLabel }) : t('元に戻す (Ctrl+Z)');
    redoBtn.title = session.history.redoLabel ? t('やり直す (Ctrl+Y)：{label}', { label: session.history.redoLabel }) : t('やり直す (Ctrl+Y)');
    brushSettings.hidden = !(session.tool === 'pencil' || session.tool === 'eraser');
    fillSettings.hidden = session.tool !== 'fill';
    sizeSelect.value = String(session.settings.size);
    roundBox.checked = session.settings.round;
    tolInput.value = String(session.settings.tolerance);
    tolValue.textContent = `${session.settings.tolerance}`;
    contigBox.checked = session.settings.contiguous;
    hint.textContent = toolHint(session.tool);
    hint.title = hint.textContent;
    view.hoverBrush = session.tool === 'pencil' || session.tool === 'eraser' ? session.brush : session.tool === 'fill' || session.tool === 'picker' ? { size: 1, round: false } : null;
    stage.dataset['tool'] = session.tool;
    syncColors();
    view.requestRender();
    schedulePreview();
  }

  session.onChange = updateUi;
  session.onAnnounce = (m) => {
    live.textContent = '';
    // 同じ文でも読み上げ直されるよう、いったん空にしてから入れる
    window.setTimeout(() => (live.textContent = m), 30);
  };
  session.onColorUsed = (hex) => palette.setRecent(rememberColor(hex));

  function updateCoords(x: number, y: number): void {
    const inside = x >= 0 && y >= 0 && x < o.canvas && y < o.canvas;
    const sel = session.doc.selection ? maskBounds(session.doc.selection, o.canvas) : null;
    const parts: string[] = [];
    if (inside) {
      parts.push(`x ${x}, y ${y}`);
      parts.push(hexOf(getPixel(flatten(session.doc), x, y)));
    }
    if (sel) parts.push(t('選択 {w} × {h}', { w: sel.width, h: sel.height }));
    coords.textContent = parts.join('・');
  }

  // ---- ポインタ ----

  const infoOf = (e: PointerEvent, button: 0 | 2, eraser: boolean): PointerInfo => {
    const p = view.toPixel(e.clientX, e.clientY);
    return { x: p.x, y: p.y, button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, eraser };
  };

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    stage.focus({ preventScroll: true });
    if (active || panning) return;
    // 中ボタン・Space を押しながらのドラッグは、画面を動かす
    if (e.button === 1 || (spaceDown && e.button === 0)) {
      e.preventDefault();
      panning = { x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('panning');
      return;
    }
    // ペンの消しゴム側は button が 5（buttons の 32）で来る。左ボタンと同じ扱いで、消しゴムとして使う
    const eraser = (e.buttons & 32) !== 0 || e.button === 5;
    const button = eraser ? 0 : e.button;
    if (button !== 0 && button !== 2) return;
    e.preventDefault();
    active = { id: e.pointerId, button, eraser };
    stage.setPointerCapture(e.pointerId);
    session.pointerDown(infoOf(e, button, eraser));
  });
  stage.addEventListener('pointermove', (e) => {
    if (panning) {
      view.panBy(e.clientX - panning.x, e.clientY - panning.y);
      panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (active && e.pointerId === active.id) {
      // 速く動かしたときも、間の点を使って線をつなぐ
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) session.pointerMove(infoOf(ev, active.button, active.eraser));
    }
    const p = view.toPixel(e.clientX, e.clientY);
    view.hover = p;
    view.requestRender();
    updateCoords(p.x, p.y);
  });
  const end = (e: PointerEvent) => {
    if (panning) {
      panning = null;
      stage.classList.remove('panning');
      return;
    }
    if (!active || e.pointerId !== active.id) return;
    const a = active;
    active = null;
    session.pointerUp(infoOf(e, a.button, a.eraser));
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', (e) => {
    if (panning) return end(e);
    if (active && e.pointerId === active.id) {
      active = null;
      session.cancelDrag();
    }
  });
  stage.addEventListener('pointerleave', () => {
    view.hover = null;
    view.requestRender();
    coords.textContent = '';
  });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) view.setZoom(stepZoom(view.zoom, e.deltaY < 0 ? 1 : -1), e);
    else if (e.shiftKey) view.panBy(-e.deltaY, 0);
    else view.panBy(0, -e.deltaY);
  }, { passive: false });

  // ---- キー（root で受ける。dialog には付けない） ----

  const ZOOM_KEYS: Record<string, number> = { '1': 1, '2': 2, '3': 4, '4': 8, '5': 16, '6': 32 };
  root.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, select, textarea')) return;
    const onButton = target.closest('button') !== null;
    // Space はパン。ボタンの上では、ボタンを押す（既定の動き）
    if (e.key === ' ' && !onButton) {
      e.preventDefault();
      spaceDown = true;
      stage.classList.add('space');
      return;
    }
    // Enter・Space でボタンを押す動きは、そのまま
    if (onButton && (e.key === 'Enter' || e.key === ' ')) return;
    const mod = e.ctrlKey || e.metaKey;
    const zoomTo = (z: number): boolean => {
      view.setZoom(z);
      return true;
    };
    let consumed = false;
    if (!mod && !e.altKey) {
      if (ZOOM_KEYS[e.key]) consumed = zoomTo(ZOOM_KEYS[e.key]!);
      else if (e.key === '0') consumed = (view.fit(), true);
      else if (e.key === '+' || e.key === '=') consumed = zoomTo(stepZoom(view.zoom, 1));
      else if (e.key === '-') consumed = zoomTo(stepZoom(view.zoom, -1));
    } else if (mod && (e.key === '=' || e.key === '+')) consumed = zoomTo(stepZoom(view.zoom, 1));
    else if (mod && e.key === '-') consumed = zoomTo(stepZoom(view.zoom, -1));
    if (consumed) {
      e.preventDefault();
      return;
    }
    const handled = session.key({ key: e.key, ctrl: mod, shift: e.shiftKey, alt: e.altKey });
    // キャンバスの上の Enter は、［完了］を押さない（浮いた選択の確定だけ）
    if (handled || (e.key === 'Enter' && target === stage)) e.preventDefault();
  });
  root.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      stage.classList.remove('space');
    }
  });

  // 貼り付け：OS のクリップボードの画像か、この画面の中でコピーした絵
  root.addEventListener('paste', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea')) return;
    e.preventDefault();
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (session.clipboard && (session.clipboardFresh || !file)) {
      session.pasteInternal();
      return;
    }
    if (file) void pasteImage(file);
  });
  // 別のアプリへ移ったあとは、OS のクリップボードの画像のほうが新しいかもしれない
  const onBlur = () => (session.clipboardFresh = false);
  window.addEventListener('blur', onBlur);

  async function pasteImage(file: File): Promise<void> {
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      session.pastePixels({ data: new Uint8ClampedArray(data.data), width: data.width, height: data.height });
    } catch {
      notify({ kind: 'error', message: t('貼り付けた画像を読み込めませんでした') });
    }
  }

  function showHelp(): void {
    const rows: [string, string][] = [
      ['P / E / G / I / M', t('鉛筆 / 消しゴム / 塗りつぶし / スポイト / 四角形の選択')],
      ['X / D', t('前景色と背景色を入れ替え / 既定の色に戻す')],
      ['Ctrl+Z / Ctrl+Y', t('元に戻す / やり直す')],
      ['Ctrl+A / Ctrl+D', t('すべて選択 / 選択を解除')],
      ['Ctrl+C / X / V', t('コピー / 切り取り / 貼り付け')],
      ['Delete', t('選択範囲を消す')],
      ['← ↑ → ↓', t('選択範囲を 1 ドット動かす（Shift で 4 ドット）')],
      ['Enter / Esc', t('浮いた選択を確定 / ドラッグの取り消し・確定・選択の解除の順')],
      ['Space + ドラッグ', t('画面を動かす（中ボタンのドラッグ、ホイールでも）')],
      ['1〜6 / 0 / + / -', t('拡大（1・2・4・8・16・32 倍）/ 全体 / 拡大 / 縮小')],
    ];
    const m = openModal(t('ショートカットの一覧'), h('table', { class: 'paint-help' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('th', null, h('kbd', null, k)), h('td', null, v))))), {
      size: 'sm',
      footer: [h('button', { type: 'button', class: 'primary', onclick: () => m.close() }, t('閉じる'))],
    });
  }

  function finish(): void {
    // 浮いた選択も重ねた、見たままの絵を返す
    o.onDone({ pixels: flatten(session.doc), canvas: o.canvas });
    modal.close();
  }

  updateUi();
  updateZoomUi();
  return modal;
}
