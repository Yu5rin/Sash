// アイコンの作成（仕様書 §6）。画像・ICO・SVG・クリップボードから、リボン向けの透過PNGを作って設定する。
// 加工は元画像に対して毎回やり直すので、設定を変えても画質が落ちない（非破壊）。

import { app } from '../app';
import { h } from '../dom';
import { openModal } from '../dialogs/modal';
import { elementAt, pathOf, setAttr, type Path } from '../model';
import { ID_PATTERN } from '../schema';
import { cornerColor, fitRect, keyOutColor, opaqueBounds, parseIco, pickIcoEntry, type IcoEntry, type Rgb } from './process';

interface Source {
  name: string;
  /** 描画元。SVG は出力サイズに合わせて描き直すため、元の画像をそのまま持つ。 */
  image: HTMLImageElement | ImageBitmap;
  isSvg: boolean;
  width: number;
  height: number;
  ico?: { entries: IcoEntry[]; selected: IcoEntry };
}

interface Options {
  size: 32 | 64;
  padding: number;
  trim: boolean;
  transparent: boolean;
  key: Rgb;
  tolerance: number;
}

const ACCEPT = '.png,.jpg,.jpeg,.bmp,.gif,.webp,.svg,.ico';

export function openIconDialog(target: Path, files?: FileList | File[]): void {
  const store = app.store;
  const el = store ? elementAt(store.doc, target) : null;
  if (!store || !el) return;

  let source: Source | null = null;
  const opts: Options = { size: app.settings.iconSize, padding: 8, trim: true, transparent: false, key: { r: 255, g: 255, b: 255 }, tolerance: 12 };
  const baseName = `img_${el.getAttribute('id') ?? el.localName}`;
  let name = baseName;

  const fileInput = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: () => fileInput.files?.[0] && void load(fileInput.files[0]) });
  const drop = h('div', { class: 'icon-drop', tabIndex: 0 }, h('p', null, '画像をドロップ、Ctrl+V で貼り付け、または'), h('button', { type: 'button', onclick: () => fileInput.click() }, 'ファイルを選ぶ'), h('p', { class: 'muted' }, 'PNG / JPG / BMP / GIF / WebP / SVG / ICO'), fileInput);
  const sourceView = h('canvas', { class: 'icon-source', title: '背景の透過を有効にすると、クリックした色を透明にします' });
  const icoList = h('div', { class: 'segmented wrap ico-sizes' });
  const previews = h('div', { class: 'icon-previews' });
  const nameInput = h('input', { type: 'text', value: name, spellcheck: false });
  const nameError = h('span', { class: 'field-error' });
  const okButton = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => confirm() }, '設定する');
  const output = document.createElement('canvas');

  const sizeSel = h('select', { onchange: (e: Event) => { opts.size = Number((e.target as HTMLSelectElement).value) as 32 | 64; if (source?.ico) selectIco(pickIcoEntry(source.ico.entries, opts.size)); else render(); } },
    h('option', { value: '32', selected: opts.size === 32 }, '32 × 32'),
    h('option', { value: '64', selected: opts.size === 64 }, '64 × 64（高DPI）'));
  const padInput = h('input', { type: 'range', min: 0, max: 30, value: opts.padding, oninput: (e: Event) => { opts.padding = Number((e.target as HTMLInputElement).value); padLabel.textContent = `${opts.padding}%`; render(); } });
  const padLabel = h('span', { class: 'range-value' }, `${opts.padding}%`);
  const trimBox = h('input', { type: 'checkbox', checked: opts.trim, onchange: (e: Event) => { opts.trim = (e.target as HTMLInputElement).checked; render(); } });
  const transBox = h('input', { type: 'checkbox', checked: opts.transparent, onchange: (e: Event) => { opts.transparent = (e.target as HTMLInputElement).checked; render(); } });
  const keySwatch = h('span', { class: 'swatch' });
  const tolInput = h('input', { type: 'range', min: 0, max: 60, value: opts.tolerance, oninput: (e: Event) => { opts.tolerance = Number((e.target as HTMLInputElement).value); tolLabel.textContent = String(opts.tolerance); render(); } });
  const tolLabel = h('span', { class: 'range-value' }, String(opts.tolerance));

  const controls = h(
    'div',
    { class: 'icon-options' },
    h('label', null, '出力サイズ', sizeSel),
    h('label', null, '余白', padInput, padLabel),
    h('label', { class: 'check' }, trimBox, '余白を自動でカットしてから収める'),
    h('label', { class: 'check' }, transBox, '背景を透過する', keySwatch),
    h('label', null, '許容値', tolInput, tolLabel),
    h('label', null, '画像名', nameInput),
    nameError,
  );

  const content = h('div', { class: 'icon-editor' }, h('div', { class: 'icon-left' }, drop, sourceView, icoList), h('div', { class: 'icon-right' }, controls, h('h3', null, 'プレビュー（実寸）'), previews));
  const modal = openModal(`アイコンを作る：${el.getAttribute('id') ?? el.localName}`, content, {
    wide: true,
    footer: [h('button', { type: 'button', onclick: () => modal.close() }, 'キャンセル'), okButton],
    onClose: () => document.removeEventListener('paste', onPaste),
  });

  const onPaste = (e: ClipboardEvent) => {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void load(file);
    }
  };
  document.addEventListener('paste', onPaste);
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files[0];
    if (f) void load(f);
  });
  nameInput.addEventListener('input', () => {
    name = nameInput.value.trim();
    validateName();
  });
  sourceView.addEventListener('click', (e) => {
    if (!source) return;
    const r = sourceView.getBoundingClientRect();
    const ctx = sourceView.getContext('2d')!;
    const x = Math.floor(((e.clientX - r.left) / r.width) * sourceView.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * sourceView.height);
    const [rr, g, b] = ctx.getImageData(x, y, 1, 1).data;
    opts.key = { r: rr!, g: g!, b: b! };
    opts.transparent = true;
    transBox.checked = true;
    render();
  });

  function validateName(): boolean {
    let err = '';
    if (!ID_PATTERN.test(name)) err = '英字か _ で始め、英数字と _ . - だけを使ってください';
    else if (store!.images.has(name) && name !== el!.getAttribute('image')) err = '同じ名前の画像があります（上書きします）';
    nameError.textContent = err;
    okButton.disabled = !source || !ID_PATTERN.test(name);
    return ID_PATTERN.test(name);
  }

  async function load(file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    const entries = /\.ico$/i.test(file.name) || file.type === 'image/x-icon' || file.type === 'image/vnd.microsoft.icon' ? parseIco(buf) : null;
    if (entries) {
      const selected = pickIcoEntry(entries, opts.size);
      source = { name: file.name, image: await createImageBitmap(selected.blob), isSvg: false, width: selected.width, height: selected.height, ico: { entries, selected } };
    } else if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
      const img = await loadImage(URL.createObjectURL(new Blob([buf], { type: 'image/svg+xml' })));
      source = { name: file.name, image: img, isSvg: true, width: img.naturalWidth || 256, height: img.naturalHeight || 256 };
    } else {
      // GIF は最初のフレームが使われる
      const bmp = await createImageBitmap(new Blob([buf], { type: file.type || 'image/png' }));
      source = { name: file.name, image: bmp, isSvg: false, width: bmp.width, height: bmp.height };
    }
    // 背景色は四隅から推定しておく（透過を有効にしたときの初期値）
    const probe = rasterize(source, Math.min(source.width, 256), Math.min(source.height, 256));
    opts.key = cornerColor(probe);
    drop.classList.add('loaded');
    renderIcoList();
    render();
  }

  function selectIco(entry: IcoEntry): void {
    if (!source?.ico) return;
    void createImageBitmap(entry.blob).then((bmp) => {
      source = { ...source!, image: bmp, width: entry.width, height: entry.height, ico: { entries: source!.ico!.entries, selected: entry } };
      renderIcoList();
      render();
    });
  }

  function renderIcoList(): void {
    icoList.replaceChildren(
      ...(source?.ico?.entries ?? []).map((en) =>
        h('button', { type: 'button', class: en === source!.ico!.selected ? 'active' : '', onclick: () => selectIco(en) }, `${en.width}px${en.bitCount ? ` ${en.bitCount}bit` : ''}`),
      ),
    );
  }

  function render(): void {
    if (!source) return;
    // 元画像の表示（スポイト用）
    const sw = Math.min(source.width, 256);
    const sh = Math.min(source.height, 256);
    const ratio = Math.min(sw / source.width, sh / source.height);
    sourceView.width = Math.max(1, Math.round(source.width * ratio));
    sourceView.height = Math.max(1, Math.round(source.height * ratio));
    sourceView.getContext('2d')!.drawImage(source.image, 0, 0, sourceView.width, sourceView.height);
    keySwatch.style.background = `rgb(${opts.key.r},${opts.key.g},${opts.key.b})`;

    process(source, opts, output);
    const url = output.toDataURL('image/png');
    const preview = (bg: string, px: number) => h('div', { class: `icon-preview ${bg}` }, h('img', { src: url, width: px, height: px, alt: '' }), h('span', null, px === 16 ? '小' : '大'));
    previews.replaceChildren(
      h('div', { class: 'icon-preview-row' }, preview('light', 16), preview('light', 32), preview('dark', 16), preview('dark', 32)),
    );
    validateName();
  }

  function confirm(): void {
    if (!source || !validateName()) return;
    const dataUrl = output.toDataURL('image/png');
    store!.addImageAndApply({ id: name, dataUrl, isNew: true }, (doc) => {
      const target2 = elementAt(doc, target);
      if (!target2) return undefined;
      setAttr(target2, 'imageMso', null);
      setAttr(target2, 'getImage', null);
      setAttr(target2, 'image', name);
      return pathOf(target2);
    });
    modal.close();
  }

  const first = files ? Array.from(files)[0] : undefined;
  if (first) void load(first);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

function rasterize(src: Source, w: number, hgt: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(hgt));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src.image, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** 透過 → トリミング → 余白をつけて縮小、の順に加工して out に描く。 */
function process(src: Source, opts: Options, out: HTMLCanvasElement): void {
  // 作業用の解像度。SVG は出力の4倍で描き直すので、どのサイズでも線が綺麗に出る
  const work = src.isSvg ? opts.size * 4 : 1;
  const scale = src.isSvg ? work / Math.max(src.width, src.height) : 1;
  const px = rasterize(src, src.width * scale, src.height * scale);
  if (opts.transparent) keyOutColor(px, opts.key, opts.tolerance);
  const bounds = (opts.trim ? opaqueBounds(px) : null) ?? { x: 0, y: 0, width: px.width, height: px.height };

  const tmp = document.createElement('canvas');
  tmp.width = px.width;
  tmp.height = px.height;
  tmp.getContext('2d')!.putImageData(px, 0, 0);

  // 大きく縮めるときは半分ずつ縮めて、細い線が消えないようにする
  let step: HTMLCanvasElement = cropTo(tmp, bounds);
  const fit = fitRect(step.width, step.height, opts.size, opts.padding);
  while (step.width / 2 >= fit.width && step.height / 2 >= fit.height) {
    const half = document.createElement('canvas');
    half.width = Math.ceil(step.width / 2);
    half.height = Math.ceil(step.height / 2);
    const hc = half.getContext('2d')!;
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(step, 0, 0, half.width, half.height);
    step = half;
  }
  out.width = opts.size;
  out.height = opts.size;
  const ctx = out.getContext('2d')!;
  ctx.clearRect(0, 0, opts.size, opts.size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(step, fit.x, fit.y, fit.width, fit.height);
}

function cropTo(c: HTMLCanvasElement, r: { x: number; y: number; width: number; height: number }): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = r.width;
  out.height = r.height;
  out.getContext('2d')!.drawImage(c, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return out;
}
