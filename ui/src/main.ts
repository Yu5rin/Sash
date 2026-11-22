// 画面全体の組み立てと、ファイル操作・反映・ショートカットの配線。

import './styles.css';
import { app } from './app';
import { invoke, isHosted, onHostEvent, sendDroppedFiles, type PartToSave, type Settings } from './bridge';
import { openCatalog } from './dialogs/catalogDialog';
import { ask, openModal } from './dialogs/modal';
import { $, h, svg } from './dom';
import { openIconDialog } from './icon/iconDialog';
import { uiIcons } from './icons';
import { mountLayout } from './layout';
import { duplicateElement, elementAt, pathOf } from './model';
import { enableMsoIcons } from './msoIcons';
import { elements } from './schema';
import { mountBottom } from './views/bottom';
import { mountCanvas } from './views/canvas';
import { mountHome } from './views/home';
import { mountInspector } from './views/inspector';
import { mountPalette } from './views/palette';
import { mountTree } from './views/tree';
import { mountXmlEditor } from './views/xmlEditor';

// ---- 通知 ----

let toastTimer: number | undefined;
function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === 'error' ? 8000 : 4000);
}

// ---- ツールバー ----

const iconText = (id: string, icon: string, text: string) => $(id).replaceChildren(svg(icon), h('span', null, text));
iconText('btn-open', uiIcons.open, '開く');
iconText('btn-save', uiIcons.save, '保存');
iconText('btn-apply', uiIcons.apply, '反映 F5');
$('btn-undo').replaceChildren(svg(uiIcons.undo));
$('btn-redo').replaceChildren(svg(uiIcons.redo));
$('btn-format').replaceChildren(svg(uiIcons.format));
$('btn-catalog').replaceChildren(svg(uiIcons.catalog));
$('btn-settings').replaceChildren(svg(uiIcons.settings));

function updateToolbar(): void {
  const s = app.session;
  const store = app.store;
  const dirty = app.dirty;
  $('file-name').textContent = s ? `${s.path}${dirty ? '（未保存）' : ''}` : '';
  document.title = s ? `${dirty ? '* ' : ''}${s.path.split(/[\\/]/).pop()} - Sash` : 'Sash';
  $<HTMLButtonElement>('btn-save').disabled = !s;
  $<HTMLButtonElement>('btn-apply').disabled = !s;
  $<HTMLButtonElement>('btn-apply').title = app.info.excelInstalled ? 'Excelへ反映 (F5)' : 'Excelが見つからないため、ファイルへの書き込みだけを行います (F5)';
  $<HTMLButtonElement>('btn-undo').disabled = !store?.canUndo;
  $<HTMLButtonElement>('btn-redo').disabled = !store?.canRedo;
  $<HTMLButtonElement>('btn-format').disabled = !store || store.syncError !== null;
  $<HTMLButtonElement>('btn-catalog').disabled = !s;

  const sw = $<HTMLSelectElement>('part-switch');
  sw.hidden = !s || s.parts.size < 2;
  if (s && s.parts.size >= 2) {
    sw.replaceChildren(
      ...[...s.parts.keys()].map((v) => h('option', { value: v, selected: s.active.version === v }, v === 'office2010' ? 'customUI14.xml（2010以降）' : 'customUI.xml（2007）')),
    );
  }
}

// ---- ファイル操作 ----

async function confirmDiscard(): Promise<boolean> {
  if (!app.dirty) return true;
  const r = await ask('未保存の変更があります', '変更を保存しますか？', [
    { value: 'save', label: '保存する', primary: true },
    { value: 'discard', label: '保存しない' },
    { value: 'cancel', label: 'キャンセル' },
  ]);
  if (r === 'save') return save();
  return r === 'discard';
}

async function open(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    const doc = await invoke('file.open', path ? { path } : undefined);
    if (!doc) return;
    app.open(doc);
    const s = app.session!;
    if (s.created) toast('このブックにはリボン定義がないので、customUI14 を新しく作りました');
    else if (s.parts.size >= 2) toast('customUI と customUI14 の両方があります。2010以降のExcelは customUI14 を優先します');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function partsToSave(): PartToSave[] {
  const s = app.session!;
  return [...s.parts.values()]
    .filter((p) => p.dirty || s.created)
    .map((p) => ({
      version: p.version,
      xml: p.text,
      addImages: [...p.images.values()].filter((i) => i.isNew).map((i) => ({ id: i.id, base64: i.dataUrl.slice(i.dataUrl.indexOf(',') + 1) })),
      removeImages: [...p.removedImages],
    }));
}

/** 構文エラーや Lint のエラーがあるときは、本当に書き込むかを確認する。 */
async function confirmErrors(action: string): Promise<boolean> {
  const s = app.session!;
  const broken = [...s.parts.values()].some((p) => p.syncError);
  const errors = app.problems.filter((p) => p.severity === 'error').length;
  if (!broken && errors === 0) return true;
  const msg = broken ? 'XMLの構文が壊れています。このまま書き込むと、Excelでリボンが表示されません。' : `エラーが ${errors} 件あります。このまま書き込むと、Excelでリボンが表示されない可能性があります。`;
  return (await ask(`${action}の前に確認`, msg, [{ value: 'go', label: `${action}する` }, { value: 'cancel', label: 'キャンセル', primary: true }])) === 'go';
}

async function save(): Promise<boolean> {
  const s = app.session;
  if (!s) return false;
  if (!(await confirmErrors('保存'))) return false;
  const parts = partsToSave();
  if (parts.length === 0) {
    toast('変更はありません');
    return true;
  }
  try {
    const res = await invoke('file.save', { path: s.path, parts });
    for (const p of s.parts.values()) p.markSaved();
    s.created = false;
    toast(`保存しました（バックアップ：${res.backup}）`);
    return true;
  } catch (e) {
    toast(`保存できませんでした：${(e as Error).message}`, 'error');
    return false;
  }
}

async function applyToExcel(): Promise<void> {
  const s = app.session;
  if (!s) return;
  if (!(await confirmErrors('反映'))) return;
  if (app.info.excelInstalled && !app.settings.ribbonErrorsHintShown) {
    await ask(
      'リボンのエラーを表示する設定',
      'リボンのXMLに誤りがあると、Excelは何も言わずにリボンを表示しません。原因を確認できるよう、Excelの［ファイル］→［オプション］→［詳細設定］→［全般］にある「アドインのユーザー インターフェイス エラーを表示する」をオンにすることをおすすめします（Sashはこの設定を変更しません）。',
      [{ value: 'ok', label: 'わかりました', primary: true }],
    );
    app.settings = await invoke('settings.set', { ribbonErrorsHintShown: true });
  }

  const run = async (saveIfDirty: boolean) => {
    const parts = partsToSave();
    toast('反映しています…');
    return invoke('excel.apply', { path: s.path, parts, saveIfDirty });
  };
  try {
    let res = await run(false);
    if (res.status === 'needsSave') {
      const r = await ask('Excel側に未保存の変更があります', `${s.path.split(/[\\/]/).pop()} はExcelで開かれていて、未保存の変更があります。Excelで保存してから反映しますか？`, [
        { value: 'go', label: '保存して反映', primary: true },
        { value: 'cancel', label: '中止' },
      ]);
      if (r !== 'go') {
        toast('反映を中止しました');
        return;
      }
      res = await run(true);
    }
    if (res.status === 'applied' || res.status === 'written' || res.status === 'blocked') {
      for (const p of s.parts.values()) p.markSaved();
      s.created = false;
    }
    toast(res.message, res.status === 'blocked' ? 'error' : 'info');
  } catch (e) {
    toast(`反映できませんでした：${(e as Error).message}`, 'error');
  }
}

// ---- 編集コマンド ----

function undo(): void {
  app.store?.undo();
}

function redo(): void {
  app.store?.redo();
}

function deleteSelection(): void {
  const store = app.store;
  const el = store?.selectedElement;
  if (!store || !el || el === store.doc.documentElement) return;
  store.edit('other', () => {
    const target = store.selectedElement!;
    const parent = target.parentElement!;
    const next = target.nextElementSibling ?? target.previousElementSibling;
    target.remove();
    return next ? pathOf(next) : pathOf(parent);
  });
}

function duplicateSelection(): void {
  const store = app.store;
  const el = store?.selectedElement;
  if (!store || !el || el === store.doc.documentElement || el.localName === 'customUI') return;
  store.edit('other', () => pathOf(duplicateElement(store.selectedElement!)));
}

function openImageEditor(files?: FileList | File[]): void {
  const store = app.store;
  if (!store?.selection) return;
  const el = store.selectedElement;
  if (!el || !elements.get(el.localName)?.attrs.includes('image')) {
    toast('この要素にはアイコンを設定できません');
    return;
  }
  openIconDialog(store.selection, files);
}

function openSettings(): void {
  const s = app.settings;
  const update = async (patch: Partial<Settings>) => {
    app.settings = await invoke('settings.set', patch);
    applyTheme();
    app.emit('settings');
  };
  const content = h(
    'div',
    { class: 'settings' },
    h('label', null, 'テーマ', h('select', { onchange: (e: Event) => void update({ theme: (e.target as HTMLSelectElement).value as Settings['theme'] }) },
      h('option', { value: 'system', selected: s.theme === 'system' }, 'システムに合わせる'),
      h('option', { value: 'light', selected: s.theme === 'light' }, 'ライト'),
      h('option', { value: 'dark', selected: s.theme === 'dark' }, 'ダーク'))),
    h('label', null, 'レイアウト', h('select', { onchange: (e: Event) => void update({ xmlOnTop: (e.target as HTMLSelectElement).value === 'xml' }) },
      h('option', { value: 'canvas', selected: !s.xmlOnTop }, 'キャンバスを上に'),
      h('option', { value: 'xml', selected: s.xmlOnTop }, 'XMLエディタを上に'))),
    h('label', null, 'アイコンの出力サイズ', h('select', { onchange: (e: Event) => void update({ iconSize: Number((e.target as HTMLSelectElement).value) as 32 | 64 }) },
      h('option', { value: '32', selected: s.iconSize === 32 }, '32 × 32'),
      h('option', { value: '64', selected: s.iconSize === 64 }, '64 × 64（高DPI）'))),
    h('p', { class: 'muted' }, `Sash ${app.info.version} ・ Excel ${app.info.excelInstalled ? 'あり' : 'なし（ファイル編集のみ）'}`),
  );
  openModal('設定', content);
}

// ---- テーマ ----

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let xmlHandle: ReturnType<typeof mountXmlEditor>;

function applyTheme(): void {
  const t = app.settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset['theme'] = t;
  const dark = t === 'dark' || (t === 'system' && darkQuery.matches);
  xmlHandle?.setTheme(dark);
  $('app').classList.toggle('xml-on-top', app.settings.xmlOnTop);
}
darkQuery.addEventListener('change', applyTheme);

// ---- 組み立て ----

mountLayout($('app'));
mountPalette($('palette-list'));
mountTree($('tree'));
mountCanvas($('canvas'), { onImageDrop: (files, target) => {
  app.store?.select(target, 'canvas');
  openIconDialog(target, files);
} });
xmlHandle = mountXmlEditor($('xml-editor'), $('xml-status'), { undo, redo });
mountInspector($('inspector'), {
  pickIdMso: (cur, apply) => {
    const tag = app.store?.selectedElement?.localName ?? '';
    openCatalog('idMso', cur, apply, tag === 'tab' || tag === 'group' ? tag : '');
  },
  pickImageMso: (cur, apply) => openCatalog('imageMso', cur, apply),
  editImage: () => openImageEditor(),
});
mountBottom($('bottom-tabs'), $('bottom-body'), toast);
mountHome($('home'), (p) => void open(p));

app.on('session', updateToolbar);
app.on('store', updateToolbar);

$('btn-open').addEventListener('click', () => void open());
$('btn-save').addEventListener('click', () => void save());
$('btn-apply').addEventListener('click', () => void applyToExcel());
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-format').addEventListener('click', () => app.store?.format());
$('btn-settings').addEventListener('click', openSettings);
$('btn-catalog').addEventListener('click', () => {
  const el = app.store?.selectedElement;
  const canIcon = el && elements.get(el.localName)?.attrs.includes('imageMso');
  openCatalog('imageMso', el?.getAttribute('imageMso') ?? '', (v) => {
    if (!canIcon || !app.store) {
      void navigator.clipboard.writeText(v).then(() => toast(`${v} をコピーしました`));
      return;
    }
    app.store.edit('inspector', (doc) => {
      const t = elementAt(doc, app.store!.selection!)!;
      t.removeAttribute('image');
      t.removeAttribute('getImage');
      t.setAttribute('imageMso', v);
      return undefined;
    });
  });
});
$<HTMLSelectElement>('part-switch').addEventListener('change', (e) => app.switchPart((e.target as HTMLSelectElement).value as 'office2007' | 'office2010'));

function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.closest('#xml-editor') !== null || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === 'F5') {
    e.preventDefault();
    void applyToExcel();
  } else if (ctrl && k === 's') {
    e.preventDefault();
    void save();
  } else if (ctrl && k === 'o') {
    e.preventDefault();
    void open();
  } else if (ctrl && (k === '1' || k === '2' || k === '3')) {
    e.preventDefault();
    if (k === '1') $('canvas').focus();
    if (k === '2') $('tree').focus();
    if (k === '3') xmlHandle.focus();
  } else if (inTextField(e.target)) {
    return;
  } else if (ctrl && k === 'z') {
    e.preventDefault();
    undo();
  } else if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) {
    e.preventDefault();
    redo();
  } else if (ctrl && k === 'd') {
    e.preventDefault();
    duplicateSelection();
  } else if (e.key === 'Delete') {
    e.preventDefault();
    deleteSelection();
  }
});

// ファイルのドロップ。xlsm / xlam はホストにパスを調べてもらって開く
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files') && !(e.target as HTMLElement).closest('#canvas, .modal')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if ((e.target as HTMLElement).closest('#canvas, .modal')) return;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  e.preventDefault();
  if (!/\.(xlsm|xlam)$/i.test(files[0]!.name)) {
    toast('.xlsm か .xlam のファイルをドロップしてください', 'error');
    return;
  }
  if (isHosted) sendDroppedFiles(files);
  else void open();
});

onHostEvent((e) => {
  if (e.event === 'fileDropped') void open(e.path);
  if (e.event === 'closeRequested') {
    void confirmDiscard().then((ok) => {
      if (ok) void invoke('app.close');
    });
  }
});

// ---- 起動 ----

const [ready, info, settings] = await Promise.all([invoke('app.ready'), invoke('app.info'), invoke('settings.get')]);
app.info = info;
app.settings = settings;
enableMsoIcons(info.excelInstalled);
applyTheme();
updateToolbar();
if (ready.initialFile) await open(ready.initialFile);
else if (!isHosted && new URLSearchParams(location.search).has('sample')) await open();
