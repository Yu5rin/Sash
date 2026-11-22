// アイコンの作成（仕様書 §6）。画像・ICO・SVG・EXE / DLL・imageMso・クリップボードから、リボン向けの透過PNGを作って設定する。
// 加工は元画像に対して毎回やり直すので、設定を変えても画質が落ちない（非破壊）。
// 作った画像には元画像と設定を持たせておき、同じセッションの間はあとから加工し直せる。

import { app } from '../app';
import { invoke } from '../bridge';
import { openCatalog } from '../dialogs/catalogDialog';
import { detailToBlobs, openLibrary } from '../dialogs/libraryDialog';
import type { LibraryIconDetail } from '../bridge';
import { openModal } from '../dialogs/modal';
import { h } from '../dom';
import { elementAt, pathOf, setAttr, type Path } from '../model';
import { ID_PATTERN } from '../schema';
import type { ImageEntry } from '../store';
import {
  adjustBrightness, cornerColor, fitRect, keyOutColor, monochrome, opaqueBounds, parseHex, parseIco, pickIcoEntry,
  replaceColor, shapeMask, sharpen, squareCrop, toHex, type IcoEntry, type Rgb,
} from './process';

interface Source {
  name: string;
  blob: Blob;
  /** 描画元。SVG は出力サイズに合わせて描き直すため、元の画像をそのまま持つ。 */
  image: HTMLImageElement | ImageBitmap;
  isSvg: boolean;
  width: number;
  height: number;
  ico?: { entries: IcoEntry[]; selected: IcoEntry };
}

type Badge = 'none' | 'dot' | 'plus' | 'check' | 'exclaim';

export interface IconOptions {
  size: 32 | 64;
  padding: number;
  trim: boolean;
  crop: { x: number; y: number; width: number; height: number } | null;
  transparent: boolean;
  key: Rgb;
  tolerance: number;
  mono: boolean;
  monoColor: string;
  replace: boolean;
  replaceFrom: string;
  replaceTo: string;
  brightness: number;
  shape: 'none' | 'rounded' | 'circle';
  radius: number;
  badge: Badge;
  badgeColor: string;
  sharpen: number;
}

const ACCEPT = '.png,.jpg,.jpeg,.bmp,.gif,.webp,.svg,.ico';
const IMAGE_FILE = /\.(png|jpe?g|bmp|gif|webp|svg|ico)$/i;

function defaultOptions(): IconOptions {
  return {
    size: app.settings.iconSize,
    padding: 8,
    trim: true,
    crop: null,
    transparent: false,
    key: { r: 255, g: 255, b: 255 },
    tolerance: 12,
    mono: false,
    monoColor: '#1e7145',
    replace: false,
    replaceFrom: '#000000',
    replaceTo: '#1e7145',
    brightness: 0,
    shape: 'none',
    radius: 20,
    badge: 'none',
    badgeColor: '#c42b1c',
    sharpen: 0,
  };
}

/**
 * アイコンエディタを開く。target が null のときは、コントロールには設定せずに画像だけを作る（一括取り込み用）。
 * existing を渡すと、その画像の元画像と設定から加工し直す。
 */
export function openIconDialog(target: Path | null, files?: FileList | File[], existing?: ImageEntry): void {
  const store = app.store;
  const el = store && target ? elementAt(store.doc, target) : null;
  if (!store || (target && !el)) return;

  let source: Source | null = null;
  const opts: IconOptions = { ...defaultOptions(), ...((existing?.edit?.options as Partial<IconOptions>) ?? {}) };
  let name = existing?.id ?? `img_${el?.getAttribute('id') ?? 'icon'}`;
  let dragStart: { x: number; y: number } | null = null;

  const fileInput = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: () => fileInput.files?.[0] && void loadFile(fileInput.files[0]) });
  const folderInput = h('input', { type: 'file', hidden: true, multiple: true, webkitdirectory: true, onchange: () => folderInput.files && void bulkImport(Array.from(folderInput.files)) });
  const sources = h(
    'div',
    { class: 'icon-sources' },
    h('button', { type: 'button', onclick: () => fileInput.click() }, 'ファイル'),
    h('button', { type: 'button', title: 'EXE / DLL に埋め込まれたアイコンから選ぶ', onclick: () => void fromExecutable() }, 'EXE / DLL'),
    app.info.excelInstalled ? h('button', { type: 'button', title: '組み込みアイコン（imageMso）を元にする', onclick: () => fromImageMso() }, '組み込みアイコン') : null,
    h('button', { type: 'button', title: 'アイコンライブラリから選ぶ（元画像と設定があれば加工し直せます）', onclick: () => fromLibrary() }, 'ライブラリ'),
    h('button', { type: 'button', title: 'フォルダ内の画像を、今の加工設定でまとめて取り込む（コントロールには設定しません）', onclick: () => folderInput.click() }, 'フォルダを一括'),
    fileInput,
    folderInput,
  );
  const drop = h('div', { class: 'icon-drop', tabIndex: 0 }, h('p', null, '画像をドロップ、Ctrl+V で貼り付け、または'), sources, h('p', { class: 'muted' }, 'PNG / JPG / BMP / GIF / WebP / SVG / ICO'));
  const sourceView = h('canvas', { class: 'icon-source', title: 'ドラッグで正方形に切り抜き、クリックで透過する色を選びます' });
  const sourceHint = h('div', { class: 'muted small' });
  const icoList = h('div', { class: 'segmented wrap ico-sizes' });
  const exeList = h('div', { class: 'exe-icons' });
  const previews = h('div', { class: 'icon-previews' });
  const nameInput = h('input', { type: 'text', value: name, spellcheck: false });
  const nameError = h('span', { class: 'field-error' });
  const okButton = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => confirm() }, target ? '設定する' : '追加する');
  const output = document.createElement('canvas');
  const saveToLibrary = h('input', { type: 'checkbox' });
  const libraryTags = h('input', { type: 'text', placeholder: 'カンマ区切り（例：社内, 集計）', spellcheck: false });

  // ---- 設定の入力欄 ----

  const range = (key: 'padding' | 'tolerance' | 'brightness' | 'radius' | 'sharpen', min: number, max: number, unit = '') => {
    const label = h('span', { class: 'range-value' }, `${opts[key]}${unit}`);
    const input = h('input', { type: 'range', min, max, value: opts[key], oninput: (e: Event) => { opts[key] = Number((e.target as HTMLInputElement).value); label.textContent = `${opts[key]}${unit}`; render(); } });
    return [input, label];
  };
  const check = (key: 'trim' | 'transparent' | 'mono' | 'replace', text: string) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts[key], dataset: { opt: key }, onchange: (e: Event) => { opts[key] = (e.target as HTMLInputElement).checked; render(); } }), text);
  const color = (key: 'monoColor' | 'replaceFrom' | 'replaceTo' | 'badgeColor') =>
    h('input', { type: 'color', value: opts[key], oninput: (e: Event) => { opts[key] = (e.target as HTMLInputElement).value; render(); } });
  const select = <K extends 'size' | 'shape' | 'badge'>(key: K, options: [string, string][]) =>
    h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; (opts as unknown as Record<string, unknown>)[key] = key === 'size' ? Number(v) : v; if (key === 'size' && source?.ico) selectIco(pickIcoEntry(source.ico.entries, opts.size)); else render(); } },
      options.map(([v, t]) => h('option', { value: v, selected: String(opts[key]) === v }, t)));
  const keySwatch = h('span', { class: 'swatch' });
  const cropReset = h('button', { type: 'button', class: 'small', onclick: () => { opts.crop = null; render(); } }, '切り抜きを解除');

  const section = (title: string, ...rows: HTMLElement[]) => h('fieldset', null, h('legend', null, title), ...rows);
  const row = (label: string, ...ctl: (HTMLElement | HTMLElement[] | null)[]) => h('label', null, h('span', { class: 'opt-label' }, label), ...ctl.flat().filter((x): x is HTMLElement => x !== null));

  const controls = h(
    'div',
    { class: 'icon-options' },
    section('サイズと余白',
      row('出力サイズ', select('size', [['32', '32 × 32'], ['64', '64 × 64（高DPI）']])),
      row('余白', ...range('padding', 0, 30, '%')),
      check('trim', '余白を自動でカットしてから収める'),
      h('div', { class: 'inline' }, cropReset)),
    section('背景の透過',
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts.transparent, dataset: { opt: 'transparent' }, onchange: (e: Event) => { opts.transparent = (e.target as HTMLInputElement).checked; render(); } }), '背景を透過する', keySwatch),
      row('許容値', ...range('tolerance', 0, 60))),
    section('色',
      h('div', { class: 'inline' }, check('mono', '単色にする'), color('monoColor')),
      h('div', { class: 'inline' }, check('replace', '色を置き換える'), color('replaceFrom'), h('span', null, '→'), color('replaceTo')),
      row('明るさ', ...range('brightness', -60, 60))),
    section('形と仕上げ',
      row('形', select('shape', [['none', 'そのまま'], ['rounded', '角丸'], ['circle', '円形']])),
      row('角丸の大きさ', ...range('radius', 5, 50, '%')),
      row('バッジ', select('badge', [['none', 'なし'], ['dot', '点'], ['plus', 'プラス'], ['check', 'チェック'], ['exclaim', '注意']]), color('badgeColor')),
      row('シャープ', ...range('sharpen', 0, 100))),
    section('画像名', row('名前', nameInput), nameError),
    section('ライブラリ',
      h('label', { class: 'check' }, saveToLibrary, 'アイコンライブラリにも保存する（別のブックで使い回せます）'),
      row('タグ', libraryTags)),
  );

  const content = h('div', { class: 'icon-editor' }, h('div', { class: 'icon-left' }, drop, sourceView, sourceHint, icoList, exeList, h('h3', null, 'プレビュー（実寸）'), previews), h('div', { class: 'icon-right' }, controls));
  const title = target ? `アイコンを作る：${el!.getAttribute('id') ?? el!.localName}` : 'アイコンを作る';
  const modal = openModal(title, content, {
    wide: true,
    footer: [h('button', { type: 'button', onclick: () => modal.close() }, 'キャンセル'), okButton],
    onClose: () => document.removeEventListener('paste', onPaste),
  });

  // ---- 入力 ----

  const onPaste = (e: ClipboardEvent) => {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void loadFile(file);
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
    const list = Array.from(e.dataTransfer?.files ?? []);
    if (list.length > 1) void bulkImport(list);
    else if (list[0]) void loadFile(list[0]);
  });
  nameInput.addEventListener('input', () => {
    name = nameInput.value.trim();
    validateName();
  });

  // 元画像の上：ドラッグで正方形に切り抜き、クリックで透過する色を選ぶ
  const toSource = (e: MouseEvent) => {
    const r = sourceView.getBoundingClientRect();
    const scale = source ? source.width / sourceView.width : 1;
    return { x: ((e.clientX - r.left) / r.width) * sourceView.width * scale, y: ((e.clientY - r.top) / r.height) * sourceView.height * scale, vx: ((e.clientX - r.left) / r.width) * sourceView.width, vy: ((e.clientY - r.top) / r.height) * sourceView.height };
  };
  sourceView.addEventListener('mousedown', (e) => {
    if (!source) return;
    dragStart = toSource(e);
  });
  sourceView.addEventListener('mouseup', (e) => {
    if (!source || !dragStart) return;
    const end = toSource(e);
    const crop = squareCrop(dragStart.x, dragStart.y, end.x, end.y, source.width, source.height);
    if (crop && crop.width > source.width * 0.03) {
      opts.crop = crop;
    } else {
      const [rr, g, b] = sourceView.getContext('2d')!.getImageData(Math.floor(end.vx), Math.floor(end.vy), 1, 1).data;
      opts.key = { r: rr!, g: g!, b: b! };
      opts.transparent = true;
      controls.querySelector<HTMLInputElement>('[data-opt="transparent"]')!.checked = true;
    }
    dragStart = null;
    render();
  });

  function validateName(): boolean {
    const valid = ID_PATTERN.test(name);
    let err = valid ? '' : '英字か _ で始め、英数字と _ . - だけを使ってください';
    if (valid && store!.images.has(name) && name !== existing?.id && name !== el?.getAttribute('image')) err = '同じ名前の画像があります（上書きします）';
    nameError.textContent = err;
    okButton.disabled = !source || !valid;
    return valid;
  }

  async function loadBlob(blob: Blob, fileName: string, keepCrop = false): Promise<void> {
    const buf = await blob.arrayBuffer();
    const isIco = /\.ico$/i.test(fileName) || blob.type === 'image/x-icon' || blob.type === 'image/vnd.microsoft.icon';
    const entries = isIco ? parseIco(buf) : null;
    if (entries) {
      const selected = pickIcoEntry(entries, opts.size);
      source = { name: fileName, blob, image: await createImageBitmap(selected.blob), isSvg: false, width: selected.width, height: selected.height, ico: { entries, selected } };
    } else if (blob.type === 'image/svg+xml' || /\.svg$/i.test(fileName)) {
      const img = await loadImage(URL.createObjectURL(new Blob([buf], { type: 'image/svg+xml' })));
      source = { name: fileName, blob, image: img, isSvg: true, width: img.naturalWidth || 256, height: img.naturalHeight || 256 };
    } else {
      // GIF は最初のフレームが使われる
      const bmp = await createImageBitmap(new Blob([buf], { type: blob.type || 'image/png' }));
      source = { name: fileName, blob, image: bmp, isSvg: false, width: bmp.width, height: bmp.height };
    }
    if (!keepCrop) {
      opts.crop = null;
      // 背景色は四隅から推定しておく（透過を有効にしたときの初期値）
      opts.key = cornerColor(rasterize(source, Math.min(source.width, 256), Math.min(source.height, 256)));
    }
    drop.classList.add('loaded');
    exeList.replaceChildren();
    renderIcoList();
    render();
  }

  async function loadFile(file: File): Promise<void> {
    await loadBlob(file, file.name);
  }

  /** EXE / DLL の埋め込みアイコンを一覧にして選ばせる（社内ツールのアイコンを流用する用途）。 */
  async function fromExecutable(): Promise<void> {
    try {
      const res = await invoke('icons.fromExecutable');
      if (!res) return;
      if (res.icons.length === 0) {
        sourceHint.textContent = 'このファイルにはアイコンがありません';
        return;
      }
      const items = await Promise.all(
        res.icons.map(async (ic) => {
          const blob = new Blob([Uint8Array.from(atob(ic.base64), (c) => c.charCodeAt(0))], { type: 'image/x-icon' });
          const entries = parseIco(await blob.arrayBuffer());
          const thumb = entries ? URL.createObjectURL(pickIcoEntry(entries, 32).blob) : '';
          return h('button', { type: 'button', class: 'exe-icon', title: ic.name, onclick: () => void loadBlob(blob, `${res.fileName}_${ic.name}.ico`) }, h('img', { src: thumb, width: 32, height: 32, alt: '' }));
        }),
      );
      exeList.replaceChildren(h('div', { class: 'muted small' }, `${res.fileName}：${res.icons.length} 個`), ...items);
    } catch (e) {
      sourceHint.textContent = (e as Error).message;
    }
  }

  /** 組み込みアイコンを大きめのサイズで取り出し、加工の元にする。 */
  function fromImageMso(): void {
    openCatalog('imageMso', '', (msoName) => {
      void invoke('excel.imageMso', { names: [msoName], size: 128 }).then((r) => {
        const b64 = r[msoName];
        if (!b64) {
          sourceHint.textContent = `${msoName} を取り出せませんでした`;
          return;
        }
        void loadBlob(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }), `${msoName}.png`);
      });
    });
  }

  /** ライブラリのアイコンを元にする。元画像と設定があれば、それを読み込んで加工し直せる状態で開き直す。 */
  function fromLibrary(): void {
    void openLibrary((d) => {
      modal.close();
      const { png, source } = detailToBlobs(d);
      const edit = source ? { source, sourceName: d.sourceName ?? `${d.id}.png`, options: d.options ?? {} } : { source: dataUrlToBlob(png), sourceName: `${d.id}.png`, options: {} };
      openIconDialog(target, undefined, { id: name, dataUrl: png, isNew: true, edit });
    });
  }

  /** フォルダの画像を、今の設定でまとめて取り込む（仕様書 §6.3）。 */
  async function bulkImport(files: File[]): Promise<void> {
    const images = files.filter((f) => IMAGE_FILE.test(f.name));
    if (images.length === 0) {
      sourceHint.textContent = '取り込める画像がありません';
      return;
    }
    const entries: ImageEntry[] = [];
    const used = new Set(store!.images.keys());
    const bulkOpts = { ...opts, crop: null };
    for (const f of images) {
      try {
        await loadBlob(f, f.name);
        process(source!, { ...bulkOpts, key: opts.key }, output);
        let id = `img_${f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_.-]/g, '_')}`;
        if (!/^[A-Za-z_]/.test(id)) id = `img_${id}`;
        let unique = id;
        for (let n = 2; used.has(unique); n++) unique = `${id}_${n}`;
        used.add(unique);
        entries.push({ id: unique, dataUrl: output.toDataURL('image/png'), isNew: true, edit: { source: f, sourceName: f.name, options: { ...bulkOpts } } });
      } catch {
        // 読めない画像は飛ばす
      }
    }
    store!.addImages(entries);
    modal.close();
  }

  function selectIco(entry: IcoEntry): void {
    if (!source?.ico) return;
    void createImageBitmap(entry.blob).then((bmp) => {
      source = { ...source!, image: bmp, width: entry.width, height: entry.height, ico: { entries: source!.ico!.entries, selected: entry } };
      opts.crop = null;
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
    const ratio = Math.min(256 / source.width, 256 / source.height, 1);
    sourceView.width = Math.max(1, Math.round(source.width * ratio));
    sourceView.height = Math.max(1, Math.round(source.height * ratio));
    const ctx = sourceView.getContext('2d')!;
    ctx.drawImage(source.image, 0, 0, sourceView.width, sourceView.height);
    if (opts.crop) {
      // 切り抜く範囲の外を暗くする
      const c = opts.crop;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.rect(0, 0, sourceView.width, sourceView.height);
      ctx.rect(c.x * ratio, c.y * ratio, c.width * ratio, c.height * ratio);
      ctx.fill('evenodd');
    }
    keySwatch.style.background = `rgb(${opts.key.r},${opts.key.g},${opts.key.b})`;
    keySwatch.title = toHex(opts.key);
    cropReset.hidden = !opts.crop;
    sourceHint.textContent = `${source.name}（${source.width} × ${source.height}）`;

    process(source, opts, output);
    const url = output.toDataURL('image/png');
    const preview = (bg: string, px: number) => h('div', { class: `icon-preview ${bg}` }, h('img', { src: url, width: px, height: px, alt: '' }), h('span', null, px === 16 ? '小' : '大'));
    previews.replaceChildren(h('div', { class: 'icon-preview-row' }, preview('light', 16), preview('light', 32), preview('dark', 16), preview('dark', 32)));
    validateName();
  }

  function confirm(): void {
    if (!source || !validateName()) return;
    if (saveToLibrary.checked) {
      const src = source;
      void src.blob.arrayBuffer().then((buf) =>
        invoke('library.save', {
          name,
          tags: libraryTags.value.split(/[,、]/).map((t) => t.trim()).filter(Boolean),
          png: output.toDataURL('image/png').split(',')[1]!,
          source: bytesToBase64(new Uint8Array(buf)),
          sourceName: src.name,
          sourceContentType: src.blob.type || 'application/octet-stream',
          options: { ...opts },
        }),
      );
    }
    const entry: ImageEntry = { id: name, dataUrl: output.toDataURL('image/png'), isNew: true, edit: { source: source.blob, sourceName: source.name, options: { ...opts } } };
    if (!target) {
      store!.addImage(entry);
    } else {
      store!.addImageAndApply(entry, (doc) => {
        const t = elementAt(doc, target);
        if (!t) return undefined;
        setAttr(t, 'imageMso', null);
        setAttr(t, 'getImage', null);
        setAttr(t, 'image', name);
        return pathOf(t);
      });
    }
    modal.close();
  }

  // ---- 起動時の読み込み ----

  if (existing?.edit) {
    void loadBlob(existing.edit.source, existing.edit.sourceName, true);
  } else {
    const first = files ? Array.from(files)[0] : undefined;
    if (first) void loadFile(first);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

function rasterize(src: Source, w: number, hgt: number, crop?: { x: number; y: number; width: number; height: number } | null) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(hgt));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (crop) ctx.drawImage(src.image, crop.x, crop.y, crop.width, crop.height, 0, 0, c.width, c.height);
  else ctx.drawImage(src.image, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/**
 * 加工の順番：切り抜き → 透過 → トリミング → 余白をつけて縮小 → 色 → 形 → バッジ → シャープ。
 * 色と形は出力サイズで処理するので、縮小後の見え方がそのまま確認できる。
 */
function process(src: Source, opts: IconOptions, out: HTMLCanvasElement): void {
  const area = opts.crop ?? { x: 0, y: 0, width: src.width, height: src.height };
  // SVG は出力の4倍の解像度で描き直すので、どのサイズでも線が綺麗に出る
  const scale = src.isSvg ? (opts.size * 4) / Math.max(area.width, area.height) : 1;
  const px = rasterize(src, area.width * scale, area.height * scale, opts.crop && !src.isSvg ? opts.crop : null);
  if (src.isSvg && opts.crop) {
    // SVG の切り抜きは、描き直した画像の上で行う
    const full = rasterize(src, src.width * scale, src.height * scale);
    const tmp = document.createElement('canvas');
    tmp.width = full.width;
    tmp.height = full.height;
    tmp.getContext('2d')!.putImageData(full, 0, 0);
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    ctx.canvas.width = px.width;
    ctx.canvas.height = px.height;
    ctx.drawImage(tmp, opts.crop.x * scale, opts.crop.y * scale, opts.crop.width * scale, opts.crop.height * scale, 0, 0, px.width, px.height);
    px.data.set(ctx.getImageData(0, 0, px.width, px.height).data);
  }
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
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, opts.size, opts.size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(step, fit.x, fit.y, fit.width, fit.height);

  const result = ctx.getImageData(0, 0, opts.size, opts.size);
  if (opts.mono) monochrome(result, parseHex(opts.monoColor));
  if (opts.replace) replaceColor(result, parseHex(opts.replaceFrom), parseHex(opts.replaceTo), 25);
  adjustBrightness(result, opts.brightness);
  shapeMask(result, opts.shape, opts.radius);
  ctx.putImageData(result, 0, 0);
  drawBadge(ctx, opts);
  if (opts.sharpen > 0) {
    const s = ctx.getImageData(0, 0, opts.size, opts.size);
    sharpen(s, opts.sharpen);
    ctx.putImageData(s, 0, 0);
  }
}

/** 右下に小さな印を重ねる。 */
function drawBadge(ctx: CanvasRenderingContext2D, opts: IconOptions): void {
  if (opts.badge === 'none') return;
  const size = opts.size;
  const r = size * 0.22;
  const cx = size - r - size * 0.02;
  const cy = size - r - size * 0.02;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + size * 0.04, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = opts.badgeColor;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, size * 0.06);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const g = r * 0.5;
  ctx.beginPath();
  if (opts.badge === 'plus') {
    ctx.moveTo(cx - g, cy);
    ctx.lineTo(cx + g, cy);
    ctx.moveTo(cx, cy - g);
    ctx.lineTo(cx, cy + g);
  } else if (opts.badge === 'check') {
    ctx.moveTo(cx - g, cy);
    ctx.lineTo(cx - g * 0.2, cy + g * 0.7);
    ctx.lineTo(cx + g, cy - g * 0.6);
  } else if (opts.badge === 'exclaim') {
    ctx.moveTo(cx, cy - g);
    ctx.lineTo(cx, cy + g * 0.2);
    ctx.moveTo(cx, cy + g * 0.75);
    ctx.lineTo(cx, cy + g * 0.8);
  }
  ctx.stroke();
  ctx.restore();
}

function cropTo(c: HTMLCanvasElement, r: { x: number; y: number; width: number; height: number }): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = r.width;
  out.height = r.height;
  out.getContext('2d')!.drawImage(c, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return out;
}

function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(',');
  const type = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/png';
  return new Blob([Uint8Array.from(atob(b64 ?? ''), (c) => c.charCodeAt(0))], { type });
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** ライブラリのアイコンを、そのままコントロールに設定する。 */
export function applyLibraryIcon(target: Path, d: LibraryIconDetail): void {
  const store = app.store;
  if (!store) return;
  const { png, source } = detailToBlobs(d);
  const ascii = d.name.match(/[A-Za-z0-9]+/g)?.join('_');
  const base = `img_${ascii ?? 'lib'}`;
  let id = base;
  for (let n = 2; store.images.has(id); n++) id = `${base}_${n}`;
  const entry: ImageEntry = { id, dataUrl: png, isNew: true, edit: source ? { source, sourceName: d.sourceName ?? `${d.id}.png`, options: d.options ?? {} } : undefined };
  store.addImageAndApply(entry, (doc) => {
    const t = elementAt(doc, target);
    if (!t) return undefined;
    setAttr(t, 'imageMso', null);
    setAttr(t, 'getImage', null);
    setAttr(t, 'image', id);
    return pathOf(t);
  });
}
