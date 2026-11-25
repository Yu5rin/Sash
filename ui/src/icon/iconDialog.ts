// アイコンの作成（仕様書 §6）。画像・ICO・SVG・EXE / DLL・imageMso・クリップボードから、リボン向けの透過PNGを作って設定する。
// 加工は元画像に対して毎回やり直すので、設定を変えても画質が落ちない（非破壊）。
// 作った画像には元画像と設定を持たせておき、同じセッションの間はあとから加工し直せる。

import { app } from '../app';
import { invoke } from '../bridge';
import { openCatalog } from '../dialogs/catalogDialog';
import { detailToBlobs, openLibrary } from '../dialogs/libraryDialog';
import type { LibraryIconDetail } from '../bridge';
import { openModal } from '../dialogs/modal';
import { notify } from '../clipboard';
import { h } from '../dom';
import { elementAt, pathOf, samePath, setAttr, type Path } from '../model';
import { iconTargetPath } from '../iconTarget';
import { ID_PATTERN } from '../schema';
import { t as tr } from '../i18n';
import type { FluentPick } from '../fluent/fluentDialog';
import { reportRefusal, type ImageEntry } from '../store';
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

export interface IconDialogOptions {
  /** 閉じたときに呼ぶ。applied は画像を設定（追加）したか。取り消したときに呼び出し元の表示を戻すのに使う。 */
  onClose?: (applied: boolean) => void;
  /** アイコン集（Fluent・Tabler）で選んだアイコンを元画像にして開く。 */
  fluent?: FluentPick;
}

/**
 * アイコン集（Fluent・Tabler）を開く。ダイアログとデータは、ここで初めて読み込む（最初の画面を重くしないため）。
 * 読み込みに失敗したら知らせて、閉じた扱いにする。
 */
export function openFluentIcons(onPick: (pick: FluentPick) => void, onClose?: (picked: boolean) => void): void {
  void import('../fluent/fluentDialog')
    .then((m) => m.openFluentPicker(onPick, { onClose }))
    .catch((e: unknown) => {
      notify({ kind: 'error', message: tr('アイコン集を読み込めませんでした：{message}', { message: e instanceof Error ? e.message : String(e) }) });
      onClose?.(false);
    });
}

/**
 * アイコンエディタを開く。target が null のときは、コントロールには設定せずに画像だけを作る（一括取り込み用）。
 * existing を渡すと、その画像の元画像と設定から加工し直す。
 */
export function openIconDialog(target: Path | null, files?: FileList | File[], existing?: ImageEntry, dialogOpts: IconDialogOptions = {}): void {
  const store = app.store;
  // 分割ボタンにはアイコンを付けられない（スキーマ違反になる）ので、中のボタンに付け替える。
  // どの入口から呼ばれても同じ結果になるよう、ここでも付け替える
  if (store && target) {
    const resolved = iconTargetPath(store.doc, target);
    // アイコンを付けられない要素（中が空の分割ボタン・tab など）には付けない。付けると、スキーマ違反の属性を作ってしまう
    if (!resolved) {
      notify({ kind: 'warning', message: tr('この要素にはアイコンを設定できません') });
      dialogOpts.onClose?.(false);
      return;
    }
    target = resolved;
  }
  const el = store && target ? elementAt(store.doc, target) : null;
  if (!store || (target && !el)) {
    dialogOpts.onClose?.(false);
    return;
  }
  // XML の構文エラー中は、コントロールに設定できない（確定で断られる）。画像を作り込んでから断られないよう、開く前に断る。
  // 一覧から開いたとき（target なし）は画像だけを作り直すので、そのまま開く
  if (target && store.syncError) {
    reportRefusal(tr('XMLに構文エラーがあるため、この操作はできません。先にXMLエディタでエラーを直してください'));
    dialogOpts.onClose?.(false);
    return;
  }
  let applied = false;
  /** ライブラリから選び直して開き直すときは、閉じた通知をそちらに引き継ぐ。 */
  let handedOff = false;
  // 作った object URL は閉じるときにまとめて解放する（開くたびに残り続けないように。不具合 31）
  const objectUrls: string[] = [];
  const objectUrl = (b: Blob) => {
    const u = URL.createObjectURL(b);
    objectUrls.push(u);
    return u;
  };
  const reportError = (e: unknown) => {
    const message = tr('画像を読み込めませんでした：{message}', { message: e instanceof Error ? e.message : String(e) });
    sourceHint.textContent = message;
    notify({ kind: 'error', message });
  };

  let source: Source | null = null;
  const opts: IconOptions = { ...defaultOptions(), ...((existing?.edit?.options as Partial<IconOptions>) ?? {}) };
  let name = existing?.id ?? `img_${el?.getAttribute('id') ?? 'icon'}`;
  let dragStart: { x: number; y: number } | null = null;

  const fileInput = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: () => fileInput.files?.[0] && void loadFile(fileInput.files[0]).catch(reportError) });
  const folderInput = h('input', { type: 'file', hidden: true, multiple: true, webkitdirectory: true, onchange: () => folderInput.files && void bulkImport(Array.from(folderInput.files)) });
  const sources = h(
    'div',
    { class: 'icon-sources' },
    h('button', { type: 'button', onclick: () => fileInput.click() }, tr('ファイル')),
    h('button', { type: 'button', title: tr('EXE / DLL に埋め込まれたアイコンから選ぶ'), onclick: () => void fromExecutable() }, 'EXE / DLL'),
    h('button', { type: 'button', title: tr('同梱のアイコン集（Fluent・Tabler、約 8,000 個）から選ぶ。ビジネス・動物・乗り物・食べ物・文字などを、あいまいな言葉で探せます。Excel がなくても使えます'), onclick: () => openFluentIcons((p) => void loadFluent(p).catch(reportError)) }, tr('アイコン集')),
    app.info.excelInstalled ? h('button', { type: 'button', title: tr('組み込みアイコン（imageMso）を元にする'), onclick: () => fromImageMso() }, tr('組み込みアイコン')) : null,
    h('button', { type: 'button', title: tr('アイコンライブラリから選ぶ（元画像と設定があれば加工し直せます）'), onclick: () => fromLibrary() }, tr('ライブラリ')),
    h('button', { type: 'button', title: tr('フォルダ内の画像を、今の加工設定でまとめて取り込む（コントロールには設定しません）'), onclick: () => folderInput.click() }, tr('フォルダを一括')),
    fileInput,
    folderInput,
  );
  const drop = h('div', { class: 'icon-drop', tabIndex: 0 }, h('p', null, tr('画像をドロップ、Ctrl+V で貼り付け、または')), sources, h('p', { class: 'muted' }, 'PNG / JPG / BMP / GIF / WebP / SVG / ICO'));
  const sourceView = h('canvas', { class: 'icon-source', title: tr('ドラッグで正方形に切り抜き、クリックで透過する色を選びます') });
  const sourceHint = h('div', { class: 'muted small' });
  const icoList = h('div', { class: 'segmented wrap ico-sizes' });
  const exeList = h('div', { class: 'exe-icons' });
  const previews = h('div', { class: 'icon-previews' });
  const nameInput = h('input', { type: 'text', value: name, spellcheck: false });
  const nameError = h('span', { class: 'field-error' });
  const okButton = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => confirm() }, target ? tr('設定する') : tr('追加する'));
  const output = document.createElement('canvas');
  const saveToLibrary = h('input', { type: 'checkbox' });
  const libraryTags = h('input', { type: 'text', placeholder: tr('カンマ区切り（例：社内, 集計）'), spellcheck: false });

  // ---- 設定の入力欄 ----

  const range = (key: 'padding' | 'tolerance' | 'brightness' | 'radius' | 'sharpen', min: number, max: number, unit = '') => {
    const label = h('span', { class: 'range-value', dataset: { optValue: key, unit } }, `${opts[key]}${unit}`);
    const input = h('input', { type: 'range', min, max, value: opts[key], dataset: { opt: key }, oninput: (e: Event) => { opts[key] = Number((e.target as HTMLInputElement).value); label.textContent = `${opts[key]}${unit}`; render(); } });
    return [input, label];
  };
  const check = (key: 'trim' | 'transparent' | 'mono' | 'replace', text: string) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts[key], dataset: { opt: key }, onchange: (e: Event) => { opts[key] = (e.target as HTMLInputElement).checked; render(); } }), tr(text));
  const color = (key: 'monoColor' | 'replaceFrom' | 'replaceTo' | 'badgeColor') =>
    h('input', { type: 'color', value: opts[key], oninput: (e: Event) => { opts[key] = (e.target as HTMLInputElement).value; render(); } });
  const select = <K extends 'size' | 'shape' | 'badge'>(key: K, options: [string, string][]) =>
    h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; (opts as unknown as Record<string, unknown>)[key] = key === 'size' ? Number(v) : v; if (key === 'size' && source?.ico) selectIco(pickIcoEntry(source.ico.entries, opts.size)); else render(); } },
      options.map(([v, t]) => h('option', { value: v, selected: String(opts[key]) === v }, tr(t))));
  const keySwatch = h('span', { class: 'swatch' });
  const cropReset = h('button', { type: 'button', class: 'small', onclick: () => { opts.crop = null; render(); } }, tr('切り抜きを解除'));

  const section = (title: string, ...rows: HTMLElement[]) => h('fieldset', null, h('legend', null, tr(title)), ...rows);
  const row = (label: string, ...ctl: (HTMLElement | HTMLElement[] | null)[]) => h('label', null, h('span', { class: 'opt-label' }, tr(label)), ...ctl.flat().filter((x): x is HTMLElement => x !== null));

  const controls = h(
    'div',
    { class: 'icon-options' },
    section('サイズと余白',
      row('出力サイズ', select('size', [['32', '32 × 32'], ['64', '64 × 64（高DPI）']])),
      row('余白', ...range('padding', 0, 30, '%')),
      check('trim', '余白を自動でカットしてから収める'),
      h('div', { class: 'inline' }, cropReset)),
    section('背景の透過',
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts.transparent, dataset: { opt: 'transparent' }, onchange: (e: Event) => { opts.transparent = (e.target as HTMLInputElement).checked; render(); } }), tr('背景を透過する'), keySwatch),
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
      h('label', { class: 'check' }, saveToLibrary, tr('アイコンライブラリにも保存する（別のブックで使い回せます）')),
      row('タグ', libraryTags)),
  );

  const content = h('div', { class: 'icon-editor' }, h('div', { class: 'icon-left' }, drop, sourceView, sourceHint, icoList, exeList, h('h3', null, tr('プレビュー（実寸）')), previews), h('div', { class: 'icon-right' }, controls));
  const title = target ? tr('アイコンを作る：{name}', { name: el!.getAttribute('id') ?? el!.localName }) : tr('アイコンを作る');
  const modal = openModal(title, content, {
    wide: true,
    footer: [h('button', { type: 'button', onclick: () => modal.close() }, tr('キャンセル')), okButton],
    onClose: () => {
      document.removeEventListener('paste', onPaste);
      for (const u of objectUrls) URL.revokeObjectURL(u);
      if (!handedOff) dialogOpts.onClose?.(applied);
    },
  });

  // ---- 入力 ----

  const onPaste = (e: ClipboardEvent) => {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void loadFile(file).catch(reportError);
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
    if (list.length > 1) void bulkImport(list).catch(reportError);
    else if (list[0]) void loadFile(list[0]).catch(reportError);
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
    let err = valid ? '' : tr('英字か _ で始め、英数字と _ . - だけを使ってください');
    if (valid && store!.images.has(name) && name !== existing?.id && name !== el?.getAttribute('image')) err = tr('同じ名前の画像があります（上書きします）');
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
      const img = await loadImage(objectUrl(new Blob([buf], { type: 'image/svg+xml' })));
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

  /**
   * アイコン集のアイコンを元にする。余白の自動カットを切り、余白を 0 にする。
   * Fluent・Tabler のアイコンは 24px の枠の中で余白まで含めて形をそろえてあるので、そのまま使うと
   * 並べたボタンのアイコンの大きさがそろう（カットすると、小さな形ほど大きく引き伸ばされてしまう）。
   */
  async function loadFluent(pick: FluentPick): Promise<void> {
    opts.trim = false;
    opts.padding = 0;
    syncControls();
    await loadBlob(pick.blob, pick.fileName);
  }

  /** 設定をコードで変えたときに、入力欄の表示を合わせる。 */
  function syncControls(): void {
    const trim = controls.querySelector<HTMLInputElement>('[data-opt="trim"]');
    if (trim) trim.checked = opts.trim;
    const padding = controls.querySelector<HTMLInputElement>('input[type="range"][data-opt="padding"]');
    if (padding) padding.value = String(opts.padding);
    const label = controls.querySelector<HTMLElement>('[data-opt-value="padding"]');
    if (label) label.textContent = `${opts.padding}${label.dataset['unit'] ?? ''}`;
  }

  /** EXE / DLL の埋め込みアイコンを一覧にして選ばせる（社内ツールのアイコンを流用する用途）。 */
  async function fromExecutable(): Promise<void> {
    try {
      const res = await invoke('icons.fromExecutable');
      if (!res) return;
      if (res.icons.length === 0) {
        sourceHint.textContent = tr('このファイルにはアイコンがありません');
        return;
      }
      const items = await Promise.all(
        res.icons.map(async (ic) => {
          const blob = new Blob([Uint8Array.from(atob(ic.base64), (c) => c.charCodeAt(0))], { type: 'image/x-icon' });
          const entries = parseIco(await blob.arrayBuffer());
          const thumb = entries ? objectUrl(pickIcoEntry(entries, 32).blob) : '';
          return h('button', { type: 'button', class: 'exe-icon', title: ic.name, onclick: () => void loadBlob(blob, `${res.fileName}_${ic.name}.ico`).catch(reportError) }, h('img', { src: thumb, width: 32, height: 32, alt: '' }));
        }),
      );
      exeList.replaceChildren(h('div', { class: 'muted small' }, tr('{file}：{n} 個', { file: res.fileName, n: res.icons.length })), ...items);
    } catch (e) {
      reportError(e);
    }
  }

  /** 組み込みアイコンを大きめのサイズで取り出し、加工の元にする。 */
  function fromImageMso(): void {
    openCatalog('imageMso', '', (msoName) => {
      void invoke('excel.imageMso', { names: [msoName], size: 128 })
        .then((r) => {
          const b64 = r[msoName];
          if (!b64) {
            const message = tr('{name} を取り出せませんでした', { name: msoName });
            sourceHint.textContent = message;
            notify({ kind: 'warning', message });
            return;
          }
          return loadBlob(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }), `${msoName}.png`);
        })
        .catch(reportError);
    });
  }

  /** ライブラリのアイコンを元にする。元画像と設定があれば、それを読み込んで加工し直せる状態で開き直す。 */
  function fromLibrary(): void {
    void openLibrary((d) => {
      handedOff = true;
      modal.close();
      const { png, source } = detailToBlobs(d);
      const edit = source ? { source, sourceName: d.sourceName ?? `${d.id}.png`, options: d.options ?? {} } : { source: dataUrlToBlob(png), sourceName: `${d.id}.png`, options: {} };
      openIconDialog(target, undefined, { id: name, dataUrl: png, isNew: true, edit }, dialogOpts);
    }, (m, k) => notify({ kind: k ?? 'info', message: m }));
  }

  /** フォルダの画像を、今の設定でまとめて取り込む（仕様書 §6.3）。 */
  async function bulkImport(files: File[]): Promise<void> {
    const images = files.filter((f) => IMAGE_FILE.test(f.name));
    if (images.length === 0) {
      sourceHint.textContent = tr('取り込める画像がありません');
      return;
    }
    const entries: ImageEntry[] = [];
    const failed: string[] = [];
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
        // 読めない画像は飛ばして、最後にまとめて知らせる
        failed.push(f.name);
      }
    }
    if (failed.length) notify({ kind: 'warning', message: tr('{n} 個の画像を読み込めませんでした：{list}', { n: failed.length, list: failed.slice(0, 5).join(tr('、')) + (failed.length > 5 ? '…' : '') }) });
    if (entries.length) {
      store!.addImages(entries);
      applied = true;
      modal.close();
    }
  }

  function selectIco(entry: IcoEntry): void {
    if (!source?.ico) return;
    void createImageBitmap(entry.blob)
      .then((bmp) => {
        source = { ...source!, image: bmp, width: entry.width, height: entry.height, ico: { entries: source!.ico!.entries, selected: entry } };
        opts.crop = null;
        renderIcoList();
        render();
      })
      .catch(reportError);
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
    // SVG は拡大しても粗くならないので、小さなもの（アイコン集の 24px など）は 128px まで大きくして見せる
    const ratio = source.isSvg ? Math.max(Math.min(256 / source.width, 256 / source.height, 1), Math.min(128 / source.width, 128 / source.height)) : Math.min(256 / source.width, 256 / source.height, 1);
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
    sourceHint.textContent = tr('{name}（{width} × {height}）', { name: source.name, width: source.width, height: source.height });

    process(source, opts, output);
    const url = output.toDataURL('image/png');
    const preview = (bg: string, px: number) => h('div', { class: `icon-preview ${bg}` }, h('img', { src: url, width: px, height: px, alt: '' }), h('span', null, px === 16 ? tr('小') : tr('大')));
    previews.replaceChildren(h('div', { class: 'icon-preview-row' }, preview('light', 16), preview('light', 32), preview('dark', 16), preview('dark', 32)));
    validateName();
  }

  function confirm(): void {
    if (!source || !validateName()) return;
    const entry: ImageEntry = { id: name, dataUrl: output.toDataURL('image/png'), isNew: true, edit: { source: source.blob, sourceName: source.name, options: { ...opts } } };
    if (!target) {
      store!.addImage(entry);
    } else {
      const ok = store!.addImageAndApply(entry, (doc) => {
        const t = elementAt(doc, target);
        if (!t) return undefined;
        setAttr(t, 'imageMso', null);
        setAttr(t, 'getImage', null);
        setAttr(t, 'image', name);
        // 分割ボタンを選んだまま中のボタンに設定したときは、選択を動かさない
        return samePath(store!.selection, target) ? pathOf(t) : undefined;
      });
      // 断られたとき（XML の構文エラー中など）は、作った画像を捨てないようダイアログを開いたままにする。
      // ライブラリにも保存しない（ブックには入っていないのに、入ったように見えてしまうため）
      if (!ok) return;
    }
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
      ).catch((e: unknown) => notify({ kind: 'error', message: tr('ライブラリに保存できませんでした：{message}', { message: e instanceof Error ? e.message : String(e) }) }));
    }
    applied = true;
    modal.close();
  }

  // ---- 起動時の読み込み ----

  if (existing?.edit) {
    void loadBlob(existing.edit.source, existing.edit.sourceName, true).catch(reportError);
  } else if (dialogOpts.fluent) {
    void loadFluent(dialogOpts.fluent).catch(reportError);
  } else {
    const first = files ? Array.from(files)[0] : undefined;
    if (first) void loadFile(first).catch(reportError);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(tr('画像を読み込めませんでした')));
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
export function applyLibraryIcon(requested: Path, d: LibraryIconDetail): void {
  const store = app.store;
  if (!store) return;
  // 分割ボタンには付けられないので、中のボタンに付け替える
  const target = iconTargetPath(store.doc, requested);
  if (!target) {
    notify({ kind: 'warning', message: tr('この要素にはアイコンを設定できません') });
    return;
  }
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
    return samePath(store.selection, target) ? pathOf(t) : undefined;
  });
}
