// 画面全体の組み立てと、ファイル操作・反映・ショートカットの配線。

import './styles.css';
import { app } from './app';
import { invoke, isHosted, onHostEvent, sendDroppedFiles, type PartToSave, type Settings } from './bridge';
import { insertStubs, setupRibbonHolder, vba } from './callbacks';
import { checkForUpdates, checkOnStartup, initUpdates, notifyUpdated, renderUpdateSettings } from './updates';
import { openCatalog } from './dialogs/catalogDialog';
import { openDiff } from './dialogs/diffDialog';
import { exportSash, parseSash, partXml } from './sashJson';
import { openCommandPalette, type Command } from './dialogs/commandPalette';
import { applyRecipe, openRecipes, saveAsRecipe } from './dialogs/recipeDialog';
import { builtinRecipes } from './recipes';
import { ask, openModal } from './dialogs/modal';
import { $, h, svg } from './dom';
import { lang, storeLang, t, translateDocument, type Lang } from './i18n';
import { applyLibraryIcon, openIconDialog } from './icon/iconDialog';
import { openLibrary } from './dialogs/libraryDialog';
import { uiIcons } from './icons';
import { mountLayout } from './layout';
import { duplicateElement, elementAt, pathOf } from './model';
import { enableMsoIcons } from './msoIcons';
import type { ImageEntry } from './store';
import { defFor, titleOf } from './schema';
import { mountBottom, showBottomTab } from './views/bottom';
import { mountCanvas, tabIdToActivate } from './views/canvas';
import { mountHome } from './views/home';
import { mountInspector } from './views/inspector';
import { insertNearSelection, mountPalette, PALETTE_ITEMS } from './views/palette';
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

translateDocument();
for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))) el.setAttribute('aria-label', t(el.getAttribute('aria-label')!));
const iconText = (id: string, icon: string, text: string) => $(id).replaceChildren(svg(icon), h('span', null, text));
iconText('btn-open', uiIcons.open, t('開く'));
iconText('btn-save', uiIcons.save, t('保存'));
iconText('btn-apply', uiIcons.apply, t('反映 F5'));
$('btn-undo').replaceChildren(svg(uiIcons.undo));
$('btn-redo').replaceChildren(svg(uiIcons.redo));
$('btn-format').replaceChildren(svg(uiIcons.format));
$('btn-catalog').replaceChildren(svg(uiIcons.catalog));
$('btn-settings').replaceChildren(svg(uiIcons.settings));
$('btn-recipes').replaceChildren(svg(uiIcons.recipe));
$('btn-diff').replaceChildren(svg(uiIcons.diff));
$('btn-command').replaceChildren(svg(uiIcons.command));

function updateToolbar(): void {
  const s = app.session;
  const store = app.store;
  const dirty = app.dirty;
  $('file-name').textContent = s ? `${s.path}${dirty ? t('（未保存）') : ''}` : '';
  document.title = s ? `${dirty ? '* ' : ''}${s.path.split(/[\\/]/).pop()} - Sash` : 'Sash';
  $<HTMLButtonElement>('btn-save').disabled = !s;
  $<HTMLButtonElement>('btn-apply').disabled = !s;
  $<HTMLButtonElement>('btn-apply').title = app.info.excelInstalled ? t('Excelへ反映 (F5)') : t('Excelが見つからないため、ファイルへの書き込みだけを行います (F5)');
  $<HTMLButtonElement>('btn-undo').disabled = !store?.canUndo;
  $<HTMLButtonElement>('btn-redo').disabled = !store?.canRedo;
  $<HTMLButtonElement>('btn-format').disabled = !store || store.syncError !== null;
  $<HTMLButtonElement>('btn-catalog').disabled = !s;
  $<HTMLButtonElement>('btn-recipes').disabled = !s;
  $<HTMLButtonElement>('btn-diff').disabled = !s;

  const sw = $<HTMLSelectElement>('part-switch');
  sw.hidden = !s || s.parts.size < 2;
  if (s && s.parts.size >= 2) {
    sw.replaceChildren(
      ...[...s.parts.keys()].map((v) => h('option', { value: v, selected: s.active.version === v }, v === 'office2010' ? t('customUI14.xml（2010以降）') : t('customUI.xml（2007）'))),
    );
  }
}

// ---- ファイル操作 ----

async function confirmDiscard(): Promise<boolean> {
  if (!app.dirty) return true;
  const r = await ask(t('未保存の変更があります'), t('変更を保存しますか？'), [
    { value: 'save', label: t('保存する'), primary: true },
    { value: 'discard', label: t('保存しない') },
    { value: 'cancel', label: t('キャンセル') },
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
    if (s.created) toast(t('このブックにはリボン定義がないので、customUI14 を新しく作りました'));
    else if (s.parts.size >= 2) toast(t('customUI と customUI14 の両方があります。2010以降のExcelは customUI14 を優先します'));
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
async function confirmErrors(action: '保存' | '反映'): Promise<boolean> {
  const s = app.session!;
  const broken = [...s.parts.values()].some((p) => p.syncError);
  const errors = app.problems.filter((p) => p.severity === 'error').length;
  if (!broken && errors === 0) return true;
  const msg = broken ? t('XMLの構文が壊れています。このまま書き込むと、Excelでリボンが表示されません。') : t('エラーが {n} 件あります。このまま書き込むと、Excelでリボンが表示されない可能性があります。', { n: errors });
  const title = action === '保存' ? t('保存の前に確認') : t('反映の前に確認');
  const go = action === '保存' ? t('保存する') : t('反映する');
  return (await ask(title, msg, [{ value: 'go', label: go }, { value: 'cancel', label: t('キャンセル'), primary: true }])) === 'go';
}

async function save(): Promise<boolean> {
  const s = app.session;
  if (!s) return false;
  if (!(await confirmErrors('保存'))) return false;
  const parts = partsToSave();
  if (parts.length === 0) {
    toast(t('変更はありません'));
    return true;
  }
  try {
    const res = await invoke('file.save', { path: s.path, parts });
    for (const p of s.parts.values()) p.markSaved();
    s.created = false;
    toast(t('保存しました（バックアップ：{backup}）', { backup: res.backup }));
    return true;
  } catch (e) {
    toast(t('保存できませんでした：{message}', { message: (e as Error).message }), 'error');
    return false;
  }
}

async function applyToExcel(): Promise<void> {
  const s = app.session;
  if (!s) return;
  if (!(await confirmErrors('反映'))) return;
  if (app.info.excelInstalled && !app.settings.ribbonErrorsHintShown) {
    await ask(
      t('リボンのエラーを表示する設定'),
      t('リボンのXMLに誤りがあると、Excelは何も言わずにリボンを表示しません。原因を確認できるよう、Excelの［ファイル］→［オプション］→［詳細設定］→［全般］にある「アドインのユーザー インターフェイス エラーを表示する」をオンにすることをおすすめします（Sashはこの設定を変更しません）。'),
      [{ value: 'ok', label: t('わかりました'), primary: true }],
    );
    app.settings = await invoke('settings.set', { ribbonErrorsHintShown: true });
  }

  const run = async (saveIfDirty: boolean) => {
    const parts = partsToSave();
    toast(t('反映しています…'));
    return invoke('excel.apply', { path: s.path, parts, saveIfDirty, activateTab: tabIdToActivate() ?? undefined });
  };
  try {
    let res = await run(false);
    if (res.status === 'needsSave') {
      const r = await ask(t('Excel側に未保存の変更があります'), t('{file} はExcelで開かれていて、未保存の変更があります。Excelで保存してから反映しますか？', { file: s.path.split(/[\\/]/).pop()! }), [
        { value: 'go', label: t('保存して反映'), primary: true },
        { value: 'cancel', label: t('中止') },
      ]);
      if (r !== 'go') {
        toast(t('反映を中止しました'));
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
    toast(t('反映できませんでした：{message}', { message: (e as Error).message }), 'error');
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

function openImageEditor(files?: FileList | File[], existing?: ImageEntry): void {
  const store = app.store;
  if (!store) return;
  if (existing && !store.selection) {
    openIconDialog(null, undefined, existing);
    return;
  }
  if (!store.selection) return;
  const el = store.selectedElement;
  if (!el || !defFor(el)?.attrs.includes('image')) {
    toast(t('この要素にはアイコンを設定できません'));
    return;
  }
  openIconDialog(store.selection, files, existing);
}

// ---- 言語 ----

const REOPEN_KEY = 'sash.reopen';
const LANG_SYNC_KEY = 'sash.langSynced';

function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // 保存できない環境では何もしない
  }
}

/** 言語を切り替えて読み込み直す。未保存の変更があるときは切り替えない（false を返す）。 */
async function changeLanguage(next: Lang): Promise<boolean> {
  if (next === lang) return true;
  if (app.dirty) {
    toast(t('言語を切り替える前に、変更を保存してください'), 'error');
    return false;
  }
  storeLang(next);
  try {
    app.settings = await invoke('settings.set', { language: next });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
  if (app.session) sessionSet(REOPEN_KEY, app.session.path);
  location.reload();
  return true;
}

async function openSettings(): Promise<void> {
  const s = app.settings;
  const updateSection = await renderUpdateSettings(async (patch) => {
    app.settings = await invoke('settings.set', patch);
  }, s);
  const update = async (patch: Partial<Settings>) => {
    app.settings = await invoke('settings.set', patch);
    applyTheme();
    app.emit('settings');
  };
  const content = h(
    'div',
    { class: 'settings' },
    h('label', null, t('テーマ'), h('select', { onchange: (e: Event) => void update({ theme: (e.target as HTMLSelectElement).value as Settings['theme'] }) },
      h('option', { value: 'system', selected: s.theme === 'system' }, t('システムに合わせる')),
      h('option', { value: 'light', selected: s.theme === 'light' }, t('ライト')),
      h('option', { value: 'dark', selected: s.theme === 'dark' }, t('ダーク')))),
    h('label', null, t('レイアウト'), h('select', { onchange: (e: Event) => void update({ xmlOnTop: (e.target as HTMLSelectElement).value === 'xml' }) },
      h('option', { value: 'canvas', selected: !s.xmlOnTop }, t('キャンバスを上に')),
      h('option', { value: 'xml', selected: s.xmlOnTop }, t('XMLエディタを上に')))),
    h('label', null, t('言語'), h('select', { onchange: (e: Event) => { const sel = e.target as HTMLSelectElement; void changeLanguage(sel.value as Lang).then((ok) => { if (!ok) sel.value = lang; }); } },
      h('option', { value: 'ja', selected: lang === 'ja' }, '日本語'),
      h('option', { value: 'en', selected: lang === 'en' }, 'English'))),
    h('label', null, t('アイコンの出力サイズ'), h('select', { onchange: (e: Event) => void update({ iconSize: Number((e.target as HTMLSelectElement).value) as 32 | 64 }) },
      h('option', { value: '32', selected: s.iconSize === 32 }, '32 × 32'),
      h('option', { value: '64', selected: s.iconSize === 64 }, t('64 × 64（高DPI）')))),
    h('h3', null, t('アイコンライブラリ')),
    h('label', null, t('保存先'), h('div', { class: 'insp-inline' }, h('span', { class: 'muted path-text', title: s.iconLibraryPath }, s.iconLibraryPath), h('button', { type: 'button', class: 'small', onclick: async () => { const p = await invoke('library.chooseFolder'); if (p) { app.settings = await invoke('settings.get'); modal.close(); void openSettings(); } } }, t('変更')))),
    h('h3', null, t('コールバック')),
    h('label', null, t('名前の規則'), h('input', { type: 'text', value: s.callbackPattern, spellcheck: false, title: t('{id} と {attr} が置き換わります'), onchange: (e: Event) => void update({ callbackPattern: (e.target as HTMLInputElement).value.trim() }) })),
    h('label', null, t('Subの共有'), h('select', { onchange: (e: Event) => void update({ callbackShared: (e.target as HTMLSelectElement).value === 'shared' }) },
      h('option', { value: 'each', selected: !s.callbackShared }, t('コントロールごとに分ける')),
      h('option', { value: 'shared', selected: s.callbackShared }, t('1つのSubを共有し control.Id で振り分ける')))),
    h('label', null, t('共有するときの名前'), h('input', { type: 'text', value: s.callbackSharedPattern, spellcheck: false, title: t('{attr} が置き換わります'), onchange: (e: Event) => void update({ callbackSharedPattern: (e.target as HTMLInputElement).value.trim() }) })),
    h('label', null, t('挿入先のモジュール'), h('input', { type: 'text', value: s.callbackModule, spellcheck: false, onchange: (e: Event) => void update({ callbackModule: (e.target as HTMLInputElement).value.trim() }) })),
    updateSection,
    h('p', { class: 'muted' }, t('Sash {version} ・ Excel {excel}', { version: app.info.version, excel: app.info.excelInstalled ? t('あり') : t('なし（ファイル編集のみ）') })),
  );
  const modal = openModal(t('設定'), content);
}

// ---- .sash.json の書き出し・読み込み ----

async function exportSashFile(): Promise<void> {
  const s = app.session;
  if (!s) return;
  const base = s.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  try {
    const saved = await invoke('file.exportText', { defaultName: `${base}.sash.json`, filter: `${t('Sash のリボン定義 (*.sash.json)')}|*.sash.json`, content: exportSash([...s.parts.values()], s.path.split(/[\\/]/).pop()) });
    if (saved) toast(t('リボン定義を書き出しました：{path}', { path: saved }));
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function importSashFile(): void {
  const input = h('input', { type: 'file', accept: '.json,.sash.json' });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void file.text().then(applySash).catch((e: Error) => toast(e.message, 'error'));
  });
  input.click();
}

async function applySash(text: string): Promise<void> {
  const s = app.session;
  if (!s) return;
  const data = parseSash(text);
  const target = s.active;
  const part = data.parts.find((p) => p.version === target.version) ?? data.parts[0]!;
  const r = await ask(t('リボン定義を読み込む'), t('編集中の {part} を、{source} のリボン定義（画像 {n} 個を含む）で置き換えます。元に戻す（Ctrl+Z）で取り消せます。', { part: target.version === 'office2010' ? 'customUI14' : 'customUI', source: data.source ?? t('ファイル'), n: part.images.length }), [
    { value: 'ok', label: t('置き換える'), primary: true },
    { value: 'cancel', label: t('キャンセル') },
  ]);
  if (r !== 'ok') return;
  target.replaceAll(partXml(part), part.images.map((i) => ({ id: i.id, dataUrl: `data:${i.contentType};base64,${i.base64}`, isNew: true })));
  toast(part.version !== target.version ? t('形式（2007 / 2010以降）が違うリボン定義を読み込みました。名前空間を確認してください') : t('リボン定義を読み込みました'));
}

// ---- コマンドパレット ----

function openImageMsoCatalog(): void {
  $('btn-catalog').click();
}

function buildCommands(): Command[] {
  const has = () => app.session !== null;
  const hasSel = () => app.store?.selectedElement !== null && app.store?.selectedElement !== undefined;
  const run = (p: Promise<string>) => void p.then((m) => m && toast(m)).catch((e: Error) => toast(e.message, 'error'));
  const setTheme = (theme: Settings['theme']) => void invoke('settings.set', { theme }).then((st) => { app.settings = st; applyTheme(); });
  return [
    { id: 'file.open', group: t('ファイル'), title: t('ファイルを開く'), shortcut: 'Ctrl+O', run: () => void open() },
    { id: 'file.save', group: t('ファイル'), title: t('保存'), shortcut: 'Ctrl+S', enabled: has, run: () => void save() },
    { id: 'file.diff', group: t('ファイル'), title: t('保存済みとの差分を表示'), keywords: 'diff compare', enabled: has, run: openDiff },
    { id: 'file.export', group: t('ファイル'), title: t('リボン定義を書き出す（.sash.json）'), keywords: 'export json git', enabled: has, run: () => void exportSashFile() },
    { id: 'file.import', group: t('ファイル'), title: t('リボン定義を読み込む（.sash.json）'), keywords: 'import json', enabled: has, run: importSashFile },
    { id: 'file.apply', group: t('ファイル'), title: t('Excelへ反映'), shortcut: 'F5', keywords: 'apply reload', enabled: has, run: () => void applyToExcel() },
    { id: 'edit.undo', group: t('編集'), title: t('元に戻す'), shortcut: 'Ctrl+Z', enabled: () => app.store?.canUndo === true, run: undo },
    { id: 'edit.redo', group: t('編集'), title: t('やり直し'), shortcut: 'Ctrl+Y', enabled: () => app.store?.canRedo === true, run: redo },
    { id: 'edit.duplicate', group: t('編集'), title: t('選択中の要素を複製'), shortcut: 'Ctrl+D', enabled: hasSel, run: duplicateSelection },
    { id: 'edit.delete', group: t('編集'), title: t('選択中の要素を削除'), shortcut: 'Delete', enabled: hasSel, run: deleteSelection },
    { id: 'edit.format', group: t('編集'), title: t('XMLを整形'), shortcut: 'Shift+Alt+F', enabled: has, run: () => app.store?.format() },
    { id: 'edit.icon', group: t('編集'), title: t('選択中のコントロールのアイコンを作る'), keywords: 'image icon png', enabled: hasSel, run: () => openImageEditor() },
    ...PALETTE_ITEMS.map((tag): Command => ({ id: `insert.${tag}`, group: t('追加'), title: t('{name}を追加', { name: titleOf(tag) }), keywords: tag, enabled: has, run: () => insertNearSelection(tag) })),
    ...builtinRecipes.map((r): Command => ({ id: `recipe.${r.id}`, group: t('レシピ'), title: t(r.title), keywords: 'recipe template', enabled: has, run: () => run(applyRecipe(r)) })),
    { id: 'recipe.open', group: t('レシピ'), title: t('レシピの一覧を開く'), keywords: 'recipe', enabled: has, run: () => void openRecipes(toast) },
    { id: 'recipe.save', group: t('レシピ'), title: t('選択中のタブ・グループをレシピとして保存'), keywords: 'recipe save', enabled: hasSel, run: () => void saveAsRecipe(toast) },
    { id: 'vba.refresh', group: 'VBA', title: t('VBAを再読み込みして照合'), keywords: 'callback vba', enabled: () => has() && app.info.excelInstalled, run: () => void vba.refresh() },
    { id: 'vba.insert', group: 'VBA', title: t('未実装のコールバックをモジュールに挿入'), keywords: 'callback stub vba', enabled: () => has() && vba.canWrite, run: () => run(insertStubs(vba.statuses())) },
    { id: 'vba.holder', group: 'VBA', title: t('onLoad と Invalidate の雛形を入れる'), keywords: 'ribbon invalidate onload', enabled: has, run: () => run(setupRibbonHolder()) },
    { id: 'view.library', group: t('表示'), title: t('アイコンライブラリを開く'), keywords: 'icon library', run: () => void openLibrary(undefined, toast) },
    { id: 'view.catalog', group: t('表示'), title: t('imageMso カタログを開く'), keywords: 'icon catalog', enabled: has, run: openImageMsoCatalog },
    { id: 'view.idmso', group: t('表示'), title: t('idMso カタログを開く（IDをコピー）'), keywords: 'idmso catalog', enabled: has, run: () => openCatalog('idMso', '', (v) => void navigator.clipboard.writeText(v).then(() => toast(t('{value} をコピーしました', { value: v })))) },
    { id: 'view.problems', group: t('表示'), title: t('問題の一覧を表示'), enabled: has, run: () => showBottomTab('problems') },
    { id: 'view.callbacks', group: t('表示'), title: t('コールバックの一覧を表示'), enabled: has, run: () => showBottomTab('callbacks') },
    { id: 'view.images', group: t('表示'), title: t('アイコンの一覧を表示'), enabled: has, run: () => showBottomTab('images') },
    { id: 'view.canvas', group: t('表示'), title: t('キャンバスに移動'), shortcut: 'Ctrl+1', run: () => $('canvas').focus() },
    { id: 'view.tree', group: t('表示'), title: t('ツリーに移動'), shortcut: 'Ctrl+2', run: () => $('tree').focus() },
    { id: 'view.xml', group: t('表示'), title: t('XMLエディタに移動'), shortcut: 'Ctrl+3', run: () => xmlHandle.focus() },
    { id: 'view.theme.light', group: t('表示'), title: t('ライトテーマにする'), keywords: 'theme light', run: () => setTheme('light') },
    { id: 'view.theme.dark', group: t('表示'), title: t('ダークテーマにする'), keywords: 'theme dark', run: () => setTheme('dark') },
    { id: 'view.theme.system', group: t('表示'), title: t('テーマをシステムに合わせる'), keywords: 'theme system', run: () => setTheme('system') },
    { id: 'view.layout', group: t('表示'), title: t('キャンバスとXMLの上下を入れ替える'), keywords: 'layout swap', run: () => void invoke('settings.set', { xmlOnTop: !app.settings.xmlOnTop }).then((st) => { app.settings = st; applyTheme(); }) },
    { id: 'app.settings', group: t('設定'), title: t('設定を開く'), run: () => void openSettings() },
    { id: 'app.update', group: t('設定'), title: t('更新を確認'), keywords: 'update version', run: () => void checkForUpdates(true) },
    { id: 'app.language', group: t('設定'), title: lang === 'en' ? 'Switch language / 言語を切り替える' : '言語を切り替える / Switch language', keywords: 'language switch english japanese 言語 英語 日本語', run: () => void changeLanguage(lang === 'en' ? 'ja' : 'en') },
  ];
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
    openCatalog('idMso', cur, apply, tag === 'tab' || tag === 'group' || tag === 'contextMenu' ? tag : '');
  },
  pickImageMso: (cur, apply) => openCatalog('imageMso', cur, apply),
  editImage: (existing) => openImageEditor(undefined, existing),
  pickFromLibrary: () => {
    const sel = app.store?.selection;
    if (sel) void openLibrary((d) => applyLibraryIcon(sel, d), toast);
  },
});
mountBottom($('bottom-tabs'), $('bottom-body'), toast, (existing) => {
  // 一覧から開いたときは、コントロールには設定せずに画像だけを作り直す
  openIconDialog(null, undefined, existing);
});
mountHome($('home'), (p) => void open(p));

app.on('session', updateToolbar);
app.on('store', updateToolbar);

$('btn-open').addEventListener('click', () => void open());
$('btn-save').addEventListener('click', () => void save());
$('btn-apply').addEventListener('click', () => void applyToExcel());
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-format').addEventListener('click', () => app.store?.format());
$('btn-settings').addEventListener('click', () => void openSettings());
initUpdates({ confirmDiscard, toast });
$('btn-recipes').addEventListener('click', () => void openRecipes(toast));
$('btn-diff').addEventListener('click', openDiff);
$('btn-command').addEventListener('click', () => openCommandPalette(buildCommands));
$('btn-catalog').addEventListener('click', () => {
  const el = app.store?.selectedElement;
  const canIcon = el && defFor(el)?.attrs.includes('imageMso');
  openCatalog('imageMso', el?.getAttribute('imageMso') ?? '', (v) => {
    if (!canIcon || !app.store) {
      void navigator.clipboard.writeText(v).then(() => toast(t('{value} をコピーしました', { value: v })));
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
  } else if (ctrl && k === 'k') {
    e.preventDefault();
    openCommandPalette(buildCommands);
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

// ファイルのドロップ。xlsm / xlam / xltm / xlsb はホストにパスを調べてもらって開く
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files') && !(e.target as HTMLElement).closest('#canvas, .modal')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if ((e.target as HTMLElement).closest('#canvas, .modal')) return;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  e.preventDefault();
  if (!/\.(xlsm|xlam|xltm|xlsb)$/i.test(files[0]!.name)) {
    toast(t('.xlsm / .xlam / .xltm / .xlsb のファイルをドロップしてください'), 'error');
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
if (settings.language && settings.language !== lang && sessionGet(LANG_SYNC_KEY) === null) {
  // ホストの設定を優先する（読み込み直しは1回だけ）
  sessionSet(LANG_SYNC_KEY, '1');
  if (ready.initialFile && sessionGet(REOPEN_KEY) === null) sessionSet(REOPEN_KEY, ready.initialFile);
  storeLang(settings.language);
  location.reload();
} else {
  if (settings.language === lang) sessionSet(LANG_SYNC_KEY, null);
  enableMsoIcons(info.excelInstalled);
  applyTheme();
  updateToolbar();
  const reopen = sessionGet(REOPEN_KEY);
  if (reopen !== null) sessionSet(REOPEN_KEY, null);
  const initialFile = reopen ?? ready.initialFile;
  if (initialFile) await open(initialFile);
  else if (!isHosted && new URLSearchParams(location.search).has('sample')) await open();
  notifyUpdated(ready.updatedFrom, ready.version);
  // 更新した直後の起動では確認しない（入れ替えたばかりのため）
  if (!ready.updatedFrom) void checkOnStartup();
}
