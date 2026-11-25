// 画面全体の組み立てと、メニュー・ツールバー・ショートカット・ファイル操作の配線。
// 操作はすべて「コマンド」として 1 か所に定義し、メニュー・ツールバー・コマンドパレット・ショートカット一覧は
// そこから作る（どこから呼んでも同じ名前・同じショートカット・同じ有効条件になるように）。

import './styles.css';
import { app } from './app';
import { invoke, isHosted, onHostEvent, sendDroppedFiles } from './bridge';
import { insertStubs, setupRibbonHolder, vba } from './callbacks';
import { checkForUpdates, checkOnStartup, initUpdates, notifyUpdated } from './updates';
import { openCatalog } from './dialogs/catalogDialog';
import { openDiff } from './dialogs/diffDialog';
import { openCommandPalette, type Command } from './dialogs/commandPalette';
import { applyRecipe, openRecipes, saveAsRecipe } from './dialogs/recipeDialog';
import { ask, isModalOpen, openOnce } from './dialogs/modal';
import { $, h, svg } from './dom';
import { lang, storeLang, t, translateDocument } from './i18n';
import { applyLibraryIcon, openIconDialog } from './icon/iconDialog';
import { openLibrary } from './dialogs/libraryDialog';
import { uiIcons } from './icons';
import { mountLayout } from './layout';
import { delegatesToInner, iconTargetPath } from './iconTarget';
import { elementAt } from './model';
import { initMsoIcons } from './msoIcons';
import type { ImageEntry } from './store';
import { titleOf } from './schema';
import { builtinRecipes } from './recipes';
import { mountBottom, showBottomTab } from './views/bottom';
import { getCanvasMode, mountCanvas, setCanvasGrowHandler, setCanvasMode, startRenameOf, type CanvasMode } from './views/canvas';
import { setElementMenuHooks } from './views/contextMenu';
import { mountHome } from './views/home';
import { flushPendingEdits, mountInspector } from './views/inspector';
import { insertNearSelection, mountPalette, PALETTE_ITEMS } from './views/palette';
import { filteredTreePaths, focusTreeFilter, mountTree } from './views/tree';
import { openIdReplaceDialog } from './idReplaceDialog';
import { openSample } from './sample';
import { mountXmlEditor, revealInXml } from './views/xmlEditor';
import { probeInsert, setEditRefusedHandler } from './shell/compat';
import { openAboutDialog, openBackupDialog, openShortcutsDialog, RELEASES_URL, REPO_URL } from './shell/dialogs';
import { describeElement } from './elementHelp';
import { inTextField, runEditCommand } from './shell/editCommands';
import { applyToExcel, busyState, closeFile, confirmDiscard, exportSashFile, importSashFile, isQuitting, onBusyChange, openFile, quit, save, setPendingEditFlusher } from './shell/fileOps';
import { changeLanguage, LANG_SYNC_KEY, REOPEN_KEY, sessionGet, sessionSet } from './shell/language';
import { mountMenubar, type MenuDef, type MenuItemDef } from './shell/menubar';
import { cyclePane, focusPane, initPanes, toggleBottom } from './shell/panes';
import { openSettings } from './shell/settingsDialog';
import { matchShortcut, splitPath } from './shell/text';
import { applyTheme, setEditorThemeHandler, updateSettings } from './shell/theme';
import { notify, toast } from './shell/toast';
import { changePreview, currentPreview, fitExcelToPreview, SCALE_CHOICES, WIDTH_CHOICES, widthChoiceLabel } from './shell/previewCommands';
import { openDistributionCheck } from './dialogs/distributionDialog';
import { openHistoryDialog } from './dialogs/historyDialog';
import type { CheckItem } from './distributionCheck';
import { controlRows, toCsv, toTsv } from './controlList';
import { clipCount, copyText, moveDisabledReason, moveSelected, moveToNewGroupSelected, newGroupDisabledReason, setSizeSelected, sizeTargets } from './clipboard';
import { canRevealInVbe, revealInVbe, runMacroDisabledReason, runMacroFor, runSelectedMacro } from './vbaReveal';
import { callbacksAt } from './vba';

// ---- 文言 ----

translateDocument();
for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))) el.setAttribute('aria-label', t(el.getAttribute('aria-label')!));

// ---- 編集の小さな操作 ----

function undo(): void {
  app.store?.undo();
}

function redo(): void {
  app.store?.redo();
}

function openImageEditor(files?: FileList | File[], existing?: ImageEntry): void {
  const store = app.store;
  if (!store) return;
  if (existing && !store.selection) {
    openIconDialog(null, undefined, existing);
    return;
  }
  if (!store.selection) {
    toast({ kind: 'warning', message: t('アイコンを設定するコントロールを選択してください') });
    return;
  }
  const el = store.selectedElement;
  // 分割ボタンを選んでいるときは、中のボタンにアイコンを設定する（分割ボタン自身には付けられない）
  const target = iconTargetPath(store.doc, store.selection);
  if (!el || !target) {
    toast({
      kind: 'warning',
      message: el && delegatesToInner(el) ? t('分割ボタンの中にボタンがないため、アイコンを設定できません') : t('この要素にはアイコンを設定できません'),
    });
    return;
  }
  openIconDialog(target, files, existing);
}

function copyToClipboard(value: string): void {
  void navigator.clipboard.writeText(value)
    .then(() => toast({ kind: 'success', message: t('{value} をコピーしました', { value }) }))
    .catch(() => toast({ kind: 'error', message: t('クリップボードにコピーできませんでした') }));
}

function openImageMsoCatalog(): void {
  const store = app.store;
  // 分割ボタンを選んでいるときは、中のボタンの imageMso を直す
  const targetPath = store?.selection ? iconTargetPath(store.doc, store.selection) : null;
  const el = store && targetPath ? elementAt(store.doc, targetPath) : null;
  const canIcon = el !== null;
  openCatalog('imageMso', el?.getAttribute('imageMso') ?? '', (v) => {
    if (!canIcon || !app.store || !targetPath) {
      copyToClipboard(v);
      return;
    }
    app.store.edit('inspector', (doc) => {
      const target = elementAt(doc, targetPath)!;
      target.removeAttribute('image');
      target.removeAttribute('getImage');
      target.setAttribute('imageMso', v);
      return undefined;
    }, t('imageMso を {value} にする', { value: v }));
  });
}

function openIdMsoCatalog(): void {
  openCatalog('idMso', '', copyToClipboard);
}

/** 結果の文言を返す非同期の操作（VBA・レシピ）を実行して知らせる。 */
function runAndNotify(p: Promise<string>): void {
  void p.then((m) => m && toast({ kind: 'success', message: m })).catch((e: Error) => toast({ kind: 'error', message: e.message }));
}

// ---- 配布前チェック・コントロール一覧・試しに押す（仕様書 §18） ----

/** 配布前チェックの項目を押したときに、その場所へ移る。 */
function navigateToCheck(item: CheckItem): void {
  if (item.target === 'callbacks' || item.target === 'images') {
    layout.expand('bottom');
    showBottomTab(item.target);
  }
  if (item.path && app.store) {
    app.store.select(item.path, 'other');
    // 選んだ要素をキャンバスで見られるよう、リボンの表示に戻してからフォーカスを移す
    if (item.target === 'element') focusPane('canvas');
  }
}

/** ファイル名から拡張子を除いた名前（書き出すファイルの既定の名前に使う）。 */
function baseName(): string {
  const s = app.session;
  return s?.path ? splitPath(s.path).name.replace(/\.[^.]+$/, '') : 'ribbon';
}

/** コントロール一覧を CSV（BOM 付き UTF-8）で書き出す。 */
async function exportControlList(): Promise<void> {
  const store = app.store;
  if (!store) return;
  const rows = controlRows(store.doc);
  if (rows.length === 0) {
    toast({ kind: 'warning', message: t('書き出すコントロールがありません') });
    return;
  }
  try {
    const saved = await invoke('file.exportText', { defaultName: t('{name}_コントロール一覧.csv', { name: baseName() }), filter: `${t('CSV ファイル (*.csv)')}|*.csv`, content: toCsv(rows) });
    if (saved) toast({ kind: 'success', message: t('{n} 件のコントロールを書き出しました：{path}', { n: rows.length, path: saved }) });
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
}

/** コントロール一覧をタブ区切りでコピーする（Excel のセルにそのまま貼り付けられる）。 */
function copyControlList(): void {
  const store = app.store;
  if (!store) return;
  const rows = controlRows(store.doc);
  if (rows.length === 0) {
    toast({ kind: 'warning', message: t('書き出すコントロールがありません') });
    return;
  }
  copyText(toTsv(rows), t('{n} 件のコントロールをコピーしました。Excel のセルに貼り付けられます', { n: rows.length }));
}

/** ファイルのあるセッションか（サンプルはパスが空で、バックアップ・VBA・反映の対象にならない）。 */
function hasFile(): boolean {
  return !!app.session?.path;
}

/** 選択中のコントロールのマクロを試せるか（メニューを無効にする条件）。呼べない形のものも、理由が分かるよう無効で出す。 */
function canRunMacro(): boolean {
  return runMacroDisabledReason(app.store?.selectedElement ?? null) === '';
}

/** 選択中の要素のコールバックのうち、VBE で表示できる最初のもの。 */
function revealableCallback(): string | null {
  const store = app.store;
  if (!store?.selection) return null;
  return callbacksAt(store.doc, store.selection).map((c) => c.name).find(canRevealInVbe) ?? null;
}

// ---- コマンド ----

interface AppCommand extends Command {
  /** 入力欄や XML エディタの中でもショートカットを受けるか（保存・反映・ペインの移動など）。 */
  inText?: boolean;
  /** 表示とは別に受けるキー（やり直しの Ctrl+Shift+Z など）。 */
  altKeys?: string[];
}

const has = () => app.session !== null;
const hasSel = () => app.store?.selectedElement !== null && app.store?.selectedElement !== undefined;
const idle = () => busyState() === null;

/** 複数選択のときは、操作の名前に数を付ける（「削除（3 個）」。仕様書 §19）。 */
function countTitle(base: string, n = app.store?.selections.length ?? 0): string {
  return n > 1 ? t('{action}（{n} 個）', { action: base, n }) : base;
}

/** 元に戻す・やり直しの名前に、何が取り消されるかを付ける。 */
function historyTitle(base: string, label: string | null | undefined): string {
  return label ? t('{action}：{label}', { action: base, label }) : base;
}

function commands(): AppCommand[] {
  const G = { file: t('ファイル'), edit: t('編集'), view: t('表示'), insert: t('挿入'), tools: t('ツール'), help: t('ヘルプ'), recipe: t('レシピ') };
  return [
    { id: 'file.new', group: G.file, title: t('新しいリボンを作る…'), keywords: 'new create ribbon 新規 作成 はじめて', enabled: idle, run: () => void newRibbon() },
    { id: 'file.open', group: G.file, title: t('開く…'), shortcut: 'Ctrl+O', keywords: 'open file ファイルを開く', inText: true, enabled: idle, run: () => void openFile() },
    // 保存と反映は、実行中でも押せるようにしておき、押されたら「終わるまでお待ちください」と知らせる（黙って無視しない）
    { id: 'file.save', group: G.file, title: t('保存'), shortcut: 'Ctrl+S', keywords: 'save', inText: true, enabled: has, run: () => void save() },
    { id: 'file.close', group: G.file, title: t('閉じる'), shortcut: 'Ctrl+W', keywords: 'close ホームに戻る', inText: true, enabled: () => has() && idle(), run: () => void closeFile() },
    { id: 'file.backup', group: G.file, title: t('バックアップから復元…'), keywords: 'backup restore 戻す', enabled: () => has() && idle() && hasFile(), run: () => void openBackupDialog() },
    { id: 'file.export', group: G.file, title: t('.sash.json として書き出す…'), keywords: 'export json git', enabled: has, run: () => void exportSashFile() },
    { id: 'file.import', group: G.file, title: t('.sash.json を読み込む…'), keywords: 'import json', enabled: has, run: importSashFile },
    { id: 'file.exportControls', group: G.file, title: t('コントロール一覧を CSV で書き出す…'), keywords: 'export csv controls list 一覧 書き出し', enabled: has, run: () => void exportControlList() },
    { id: 'file.copyControls', group: G.file, title: t('コントロール一覧をコピー（Excel に貼り付け用）'), keywords: 'copy tsv controls list 一覧 クリップボード', enabled: has, run: copyControlList },
    { id: 'file.sample', group: G.file, title: t('サンプルを開く'), keywords: 'sample example サンプル 試す', enabled: idle, run: () => void openSample() },
    { id: 'file.quit', group: G.file, title: t('終了'), keywords: 'quit exit', enabled: () => isHosted, run: () => void quit() },

    { id: 'edit.undo', group: G.edit, title: historyTitle(t('元に戻す'), app.store?.undoLabel), shortcut: 'Ctrl+Z', keywords: 'undo', enabled: () => app.store?.canUndo === true, run: undo },
    { id: 'edit.redo', group: G.edit, title: historyTitle(t('やり直し'), app.store?.redoLabel), shortcut: 'Ctrl+Y', altKeys: ['Ctrl+Shift+Z'], keywords: 'redo', enabled: () => app.store?.canRedo === true, run: redo },
    { id: 'edit.history', group: G.edit, title: t('操作の履歴…'), keywords: 'history undo redo 履歴 元に戻す', enabled: () => !!app.store && (app.store.canUndo || app.store.canRedo), run: () => void openOnce('history', openHistoryDialog) },
    { id: 'edit.cut', group: G.edit, title: countTitle(t('切り取り')), shortcut: 'Ctrl+X', keywords: 'cut', enabled: hasSel, run: () => runEditCommand('cut') },
    { id: 'edit.copy', group: G.edit, title: countTitle(t('コピー')), shortcut: 'Ctrl+C', keywords: 'copy', enabled: hasSel, run: () => runEditCommand('copy') },
    { id: 'edit.paste', group: G.edit, title: countTitle(t('貼り付け'), clipCount()), shortcut: 'Ctrl+V', keywords: 'paste', enabled: has, run: () => runEditCommand('paste') },
    { id: 'edit.duplicate', group: G.edit, title: countTitle(t('複製')), shortcut: 'Ctrl+D', keywords: 'duplicate 選択中の要素を複製', enabled: hasSel, run: () => runEditCommand('duplicate') },
    { id: 'edit.delete', group: G.edit, title: countTitle(t('削除')), shortcut: 'Del', keywords: 'delete remove 選択中の要素を削除', enabled: hasSel, run: () => runEditCommand('delete') },
    // 複数選択とまとめての操作（仕様書 §19）。Ctrl+A は入力欄の外で受ける（入力欄の中は文字の全選択）
    // ツリーを絞り込んでいるときは、見えている行の兄弟だけを選ぶ（隠れた要素を続けて消してしまわないように。仕様書 §19.1）
    { id: 'edit.selectAll', group: G.edit, title: t('同じ階層をすべて選択'), shortcut: 'Ctrl+A', keywords: 'select all multi 複数選択 すべて選択', enabled: () => (app.store?.selection?.length ?? 0) > 0, run: () => app.store?.selectAll('other', filteredTreePaths() ?? undefined) },
    { id: 'edit.clearMulti', group: G.edit, title: t('複数選択を解除'), keywords: 'deselect multi 複数選択 解除', enabled: () => app.store?.isMulti === true, run: () => app.store?.clearMulti('other') },
    { id: 'edit.moveUp', group: G.edit, title: countTitle(t('上へ移動')), keywords: 'move up 並べ替え alt+up', enabled: () => has() && moveDisabledReason(-1) === null, run: () => moveSelected(-1, 'other') },
    { id: 'edit.moveDown', group: G.edit, title: countTitle(t('下へ移動')), keywords: 'move down 並べ替え alt+down', enabled: () => has() && moveDisabledReason(1) === null, run: () => moveSelected(1, 'other') },
    { id: 'edit.newGroup', group: G.edit, title: countTitle(t('新しいグループに移す')), keywords: 'new group split move グループを分ける 幅', enabled: () => has() && newGroupDisabledReason() === null, run: () => moveToNewGroupSelected('other') },
    { id: 'edit.sizeLarge', group: G.edit, title: countTitle(t('大きく（size=large）'), sizeTargets().length), keywords: 'size large 大きさ 一括', enabled: () => sizeTargets().length > 0, run: () => setSizeSelected('large', 'other') },
    { id: 'edit.sizeNormal', group: G.edit, title: countTitle(t('小さく（size=normal）'), sizeTargets().length), keywords: 'size normal small 大きさ 一括 幅', enabled: () => sizeTargets().length > 0, run: () => setSizeSelected('normal', 'other') },
    { id: 'edit.format', group: G.edit, title: t('XMLを整形'), shortcut: 'Shift+Alt+F', keywords: 'format', enabled: () => !!app.store && app.store.syncError === null, run: () => app.store?.format() },
    { id: 'edit.palette', group: G.edit, title: t('コマンドパレット'), shortcut: 'Ctrl+K', keywords: 'command', inText: true, run: () => openCommandPalette(paletteCommands) },

    { id: 'view.canvas', group: G.view, title: t('キャンバスに移動'), shortcut: 'Ctrl+1', inText: true, enabled: has, run: () => focusPane('canvas') },
    { id: 'view.tree', group: G.view, title: t('ツリーに移動'), shortcut: 'Ctrl+2', inText: true, enabled: has, run: () => focusPane('tree') },
    { id: 'view.xml', group: G.view, title: t('XMLエディタに移動'), shortcut: 'Ctrl+3', inText: true, enabled: has, run: () => focusPane('xml') },
    { id: 'view.inspector', group: G.view, title: t('インスペクタに移動'), shortcut: 'Ctrl+4', inText: true, enabled: has, run: () => focusPane('inspector') },
    { id: 'view.bottom', group: G.view, title: t('下部パネルの表示・非表示'), shortcut: 'Ctrl+J', inText: true, enabled: has, run: toggleBottom },
    { id: 'view.nextPane', group: G.view, title: t('次のペインへ移る'), shortcut: 'F6', inText: true, enabled: has, run: () => cyclePane(1) },
    { id: 'view.prevPane', group: G.view, title: t('前のペインへ移る'), shortcut: 'Shift+F6', inText: true, enabled: has, run: () => cyclePane(-1) },
    // ツリーの絞り込みは、ツリーの中で Ctrl+F でも移れる。左のペインを畳んでいたら開いてから移る
    { id: 'view.treeFilter', group: G.view, title: t('ツリーを絞り込む'), keywords: 'filter search tree 検索 絞り込み', enabled: has, run: () => { layout.expand('left'); focusTreeFilter(); } },
    { id: 'view.problems', group: G.view, title: t('問題の一覧を表示'), enabled: has, run: () => { layout.expand('bottom'); showBottomTab('problems'); } },
    { id: 'view.callbacks', group: G.view, title: t('コールバックの一覧を表示'), enabled: has, run: () => { layout.expand('bottom'); showBottomTab('callbacks'); } },
    { id: 'view.images', group: G.view, title: t('アイコンの一覧を表示'), enabled: has, run: () => { layout.expand('bottom'); showBottomTab('images'); } },
    ...WIDTH_CHOICES_ALL.map((w): AppCommand => ({ id: `view.width.${w ?? 'free'}`, group: G.view, title: t('画面の幅：{w}', { w: widthChoiceLabel(w) }), keywords: 'ribbon width preview 幅 プレビュー', enabled: has, run: () => changePreview({ width: w }) })),
    ...SCALE_CHOICES.map((sc): AppCommand => ({ id: `view.scale.${sc}`, group: G.view, title: t('拡大率：{s}%', { s: sc }), keywords: 'scale dpi zoom 拡大率', enabled: has, run: () => changePreview({ scale: sc }) })),
    { id: 'view.fit.fit', group: G.view, title: t('リボンの全体を表示'), keywords: 'fit preview 収める 全体', enabled: has, run: () => changePreview({ fit: 'fit' }) },
    { id: 'view.fit.actual', group: G.view, title: t('リボンを実寸で表示'), keywords: 'actual size preview 等倍 実寸', enabled: has, run: () => changePreview({ fit: 'actual' }) },
    { id: 'view.keytips', group: G.view, title: t('キーヒントの表示を切り替える'), keywords: 'keytip alt キーヒント', enabled: has, run: () => changePreview({ keytips: !currentPreview().keytips }) },
    { id: 'view.collapseSides', group: G.view, title: t('左右のペインを一時的に畳む'), keywords: 'collapse panes wide 広く', enabled: has, run: collapseSidePanes },
    { id: 'view.fitExcel', group: G.view, title: t('Excel をプレビューの幅にする'), keywords: 'excel window width 幅 合わせる', enabled: () => has() && app.info.excelInstalled && currentPreview().width !== null, run: () => void fitExcelToPreview() },
    { id: 'view.theme.system', group: G.view, title: t('テーマをシステムに合わせる'), keywords: 'theme system', run: () => void updateSettings({ theme: 'system' }) },
    { id: 'view.theme.light', group: G.view, title: t('ライトテーマにする'), keywords: 'theme light', run: () => void updateSettings({ theme: 'light' }) },
    { id: 'view.theme.dark', group: G.view, title: t('ダークテーマにする'), keywords: 'theme dark', run: () => void updateSettings({ theme: 'dark' }) },
    { id: 'view.swap', group: G.view, title: t('キャンバスとXMLの上下を入れ替える'), keywords: 'layout swap', run: () => void updateSettings({ xmlOnTop: !app.settings.xmlOnTop }) },
    { id: 'view.resetLayout', group: G.view, title: t('既定のレイアウトに戻す'), keywords: 'layout reset', run: () => layout.reset() },

    ...PALETTE_ITEMS.map((tag): AppCommand => ({ id: `insert.${tag}`, group: G.insert, title: t('{name}を追加', { name: titleOf(tag) }), keywords: tag, enabled: has, run: () => void insertNearSelection(tag) })),
    { id: 'insert.recipes', group: G.insert, title: t('レシピ…'), keywords: 'recipe template レシピを挿入', enabled: has, run: () => void openOnce('recipes', () => openRecipes(notify)) },
    { id: 'insert.saveRecipe', group: G.recipe, title: t('選択中のタブ・グループをレシピとして保存'), keywords: 'recipe save', enabled: hasSel, run: () => void saveAsRecipe(notify) },
    ...builtinRecipes.map((r): AppCommand => ({ id: `recipe.${r.id}`, group: G.recipe, title: t(r.title), keywords: 'recipe template', enabled: has, run: () => runAndNotify(applyRecipe(r)) })),
    { id: 'insert.idMso', group: G.insert, title: t('idMso カタログ…'), keywords: 'idmso catalog', enabled: has, run: openIdMsoCatalog },
    { id: 'insert.imageMso', group: G.insert, title: t('imageMso カタログ…'), keywords: 'imagemso icon catalog', enabled: has, run: openImageMsoCatalog },

    { id: 'tools.apply', group: G.tools, title: t('Excelへ反映'), shortcut: 'F5', keywords: 'apply reload', inText: true, enabled: has, run: () => void applyToExcel() },
    { id: 'tools.distCheck', group: G.tools, title: t('配布前チェック…'), keywords: 'check distribute release 配布 確認 チェック', enabled: has, run: () => void openOnce('distributionCheck', () => openDistributionCheck({ onNavigate: navigateToCheck })) },
    { id: 'tools.runMacro', group: G.tools, title: t('マクロを Excel で試す'), keywords: 'run macro test 試しに押す 実行 試す', enabled: () => has() && canRunMacro(), run: () => void runSelectedMacro() },
    { id: 'vba.reveal', group: 'VBA', title: t('選択中のコントロールのコールバックを VBE で表示'), keywords: 'vbe vba open procedure 開く', enabled: () => has() && revealableCallback() !== null, run: () => { const n = revealableCallback(); if (n) void revealInVbe(n); } },
    { id: 'tools.replaceIds', group: G.tools, title: t('ID の一括置換…'), keywords: 'id rename replace prefix 置換', enabled: has, run: () => openIdReplaceDialog() },
    { id: 'tools.diff', group: G.tools, title: t('保存済みとの差分…'), keywords: 'diff compare', enabled: has, run: () => void openOnce('diff', openDiff) },
    { id: 'vba.refresh', group: 'VBA', title: t('VBAを再読み込みして照合'), keywords: 'callback vba', enabled: () => has() && app.info.excelInstalled && hasFile(), run: () => void vba.refresh() },
    { id: 'vba.insert', group: 'VBA', title: t('未実装のコールバックをモジュールに挿入'), keywords: 'callback stub vba', enabled: () => has() && vba.canWrite, run: () => runAndNotify(insertStubs(vba.statuses())) },
    { id: 'vba.holder', group: 'VBA', title: t('onLoad と Invalidate の雛形を入れる'), keywords: 'ribbon invalidate onload', enabled: has, run: () => runAndNotify(setupRibbonHolder()) },
    { id: 'tools.icon', group: G.tools, title: t('選択中のコントロールのアイコンを作る…'), keywords: 'image icon png', enabled: hasSel, run: () => openImageEditor() },
    { id: 'tools.library', group: G.tools, title: t('アイコンライブラリ…'), keywords: 'icon library', run: () => void openOnce('library', () => openLibrary(undefined, notify, { onCreateIcon: (target) => openIconDialog(target) })) },
    { id: 'tools.settings', group: G.tools, title: t('設定…'), keywords: 'settings options', run: () => void openSettings() },
    { id: 'tools.language', group: G.tools, title: lang === 'en' ? 'Switch language / 言語を切り替える' : '言語を切り替える / Switch language', keywords: 'language switch english japanese 言語 英語 日本語', run: () => void changeLanguage(lang === 'en' ? 'ja' : 'en') },

    { id: 'help.shortcuts', group: G.help, title: t('キーボードショートカット'), keywords: 'keyboard shortcuts keys', run: () => openShortcutsDialog(shortcutCommands()) },
    { id: 'help.update', group: G.help, title: t('更新を確認…'), keywords: 'update version', run: () => void checkForUpdates(true) },
    { id: 'help.releases', group: G.help, title: t('リリースノートを開く'), keywords: 'release notes', run: () => openUrl(RELEASES_URL) },
    { id: 'help.github', group: G.help, title: t('GitHub のページを開く'), keywords: 'github repository', run: () => openUrl(REPO_URL) },
    { id: 'help.about', group: G.help, title: t('バージョン情報'), keywords: 'about version license', run: openAboutDialog },
  ];
}

/**
 * ショートカット一覧に出すコマンド。元に戻す・やり直しは、メニューでは「元に戻す：XMLの編集」のように
 * 取り消す操作の名前を付けるが、一覧ではキーの説明なので、操作の名前だけにする。
 */
function shortcutCommands(): Command[] {
  const fixed: Readonly<Record<string, string>> = { 'edit.undo': t('元に戻す'), 'edit.redo': t('やり直し') };
  return commands().map((c) => (fixed[c.id] ? { ...c, title: fixed[c.id]! } : c));
}

function openUrl(url: string): void {
  void invoke('update.openPage', { url }).catch((e: Error) => toast({ kind: 'error', message: e.message }));
}

/** コマンドパレットに出すもの（パレット自身は除く）。 */
function paletteCommands(): Command[] {
  return commands().filter((c) => c.id !== 'edit.palette');
}

// ---- メニュー ----

const byId = (id: string): AppCommand => commands().find((c) => c.id === id)!;

/** コマンドからメニューの項目を作る。label を渡すとメニューでの名前を変える。 */
function cmd(id: string, label?: string, extra: Partial<MenuItemDef> = {}): MenuItemDef {
  const c = byId(id);
  return { label: label ?? c.title, shortcut: c.shortcut, enabled: c.enabled?.() ?? true, run: c.run, ...extra };
}

const SEP: MenuItemDef = { type: 'separator' };

/**
 * 「新しいリボンを作る」。Sash はブックそのものは作れず、Excel のブックの中のリボン定義を編集する。
 * 「新規作成」を押して空のリボンが出るのを期待した人が、ファイルの選択で戸惑わないよう、選ぶものを先に伝える。
 * 選んだブックにリボン定義がなければ、openFile が新しく作る。
 */
async function newRibbon(): Promise<void> {
  const answer = await ask(
    t('新しいリボンを作る'),
    t('リボンを付けたいブック（.xlsm / .xlam）を選んでください。リボン定義がなければ新しく作ります'),
    [{ value: 'open', label: t('ブックを選ぶ…'), primary: true }, { value: 'cancel', label: t('キャンセル') }],
  );
  if (answer === 'open') void openFile();
}

async function recentItems(): Promise<MenuItemDef[]> {
  const recent = await invoke('file.recent').catch(() => []);
  if (recent.length === 0) return [{ label: t('最近使ったファイルはありません'), enabled: false }];
  const missing = recent.filter((r) => !r.exists);
  return [
    ...recent.map((r, i): MenuItemDef => ({
      label: `${i < 9 ? `${i + 1}  ` : ''}${splitPath(r.path).name}`,
      hint: r.exists ? r.path : t('{path}（見つかりません）', { path: r.path }),
      enabled: r.exists && idle(),
      run: () => void openFile(r.path),
    })),
    SEP,
    {
      label: t('一覧から消す'),
      // ホームの「最近使ったファイル」にも同じ一覧が出ているので、消したら取り直す
      items: () => recent.map((r): MenuItemDef => ({ label: splitPath(r.path).name, hint: r.path, run: () => void invoke('file.removeRecent', { path: r.path }).then(() => home.refresh()) })),
    },
    {
      label: t('見つからないファイルを一覧から消す'),
      enabled: missing.length > 0,
      run: () => void Promise.all(missing.map((r) => invoke('file.removeRecent', { path: r.path }))).then(() => {
        home.refresh();
        toast({ kind: 'success', message: t('{n} 件を一覧から消しました', { n: missing.length }) });
      }),
    },
  ];
}

/** 挿入メニューに直接並べる要素。残りは「その他」にまとめる。 */
const INSERT_COMMON = ['tab', 'group', 'button', 'toggleButton', 'checkBox', 'dropDown', 'comboBox', 'editBox', 'menu', 'splitButton', 'gallery', 'labelControl', 'separator'];

function insertItem(tag: string): MenuItemDef {
  const store = app.store;
  const reason = store ? probeInsert(store.doc, store.selection, tag) : t('ファイルを開くと追加できます');
  // ツールチップには何ができる部品かを出す。追加できないときは、その理由を添える
  const desc = describeElement(tag);
  const hint = [desc || tag, reason].filter(Boolean).join('\n');
  return { label: titleOf(tag), hint, enabled: reason === null, // 挿入メニューから足したときだけ、すぐ名前の入力にする（パレットのダブルクリックはパレットにフォーカスを残す）
    run: () => {
      if (insertNearSelection(tag)) startRenameOf(app.store?.selection);
    } };
}

const CANVAS_MODES: readonly { mode: CanvasMode; label: string }[] = [
  { mode: 'ribbon', label: 'リボン' },
  { mode: 'backstage', label: 'Backstage' },
  { mode: 'contextMenu', label: 'コンテキストメニュー' },
];

/** 「自由」を含めた幅の選択肢。 */
const WIDTH_CHOICES_ALL: readonly (number | null)[] = [null, ...WIDTH_CHOICES];

/** 表示 メニューの、リボンの幅のプレビューの項目（仕様書 §18.7）。 */
function previewMenuItems(): MenuItemDef[] {
  const p = currentPreview();
  const on = has();
  return [
    { label: t('画面の幅'), enabled: on, items: () => WIDTH_CHOICES_ALL.map((w): MenuItemDef => ({ label: widthChoiceLabel(w), checked: p.width === w, run: () => changePreview({ width: w }) })) },
    { label: t('拡大率'), enabled: on, items: () => SCALE_CHOICES.map((sc): MenuItemDef => ({ label: `${sc}%`, checked: p.scale === sc, run: () => changePreview({ scale: sc }) })) },
    {
      label: t('表示のしかた'), enabled: on, items: () => [
        { label: t('全体を表示'), checked: p.fit === 'fit', run: () => changePreview({ fit: 'fit' }) },
        { label: t('実寸'), checked: p.fit === 'actual', run: () => changePreview({ fit: 'actual' }) },
      ],
    },
    { label: t('キーヒントを表示'), enabled: on, checked: p.keytips, run: () => changePreview({ keytips: !p.keytips }) },
    cmd('view.collapseSides'),
    cmd('view.fitExcel', undefined, { hint: p.width === null ? t('画面の幅を選ぶと使えます') : app.info.excelInstalled ? undefined : t('Excel が見つからないため使えません') }),
  ];
}

/** 「マクロを Excel で試す」が使えないときの理由（メニューのツールチップ）。 */
function runMacroHint(): string | undefined {
  const el = app.store?.selectedElement ?? null;
  if (app.info.excelInstalled && !el?.hasAttribute('onAction')) return t('onAction のあるコントロールを選ぶと使えます');
  return runMacroDisabledReason(el) || t('引数のない Sub と、IRibbonControl を 1 つ受け取る Sub を実行できます（control には Nothing を渡します）');
}

const MENUS: MenuDef[] = [
  {
    id: 'file', label: t('ファイル'), mnemonic: 'F', items: () => [
      cmd('file.new'),
      cmd('file.open'),
      { label: t('最近使ったファイル'), items: recentItems },
      cmd('file.sample'),
      SEP,
      cmd('file.save'),
      cmd('file.close'),
      SEP,
      cmd('file.backup', undefined, { hint: app.session && !hasFile() ? t('サンプルにはバックアップがありません') : undefined }),
      cmd('file.export'),
      cmd('file.import'),
      {
        label: t('コントロール一覧'), items: () => [
          cmd('file.exportControls', t('CSV ファイルに書き出す…')),
          cmd('file.copyControls', t('クリップボードにコピー')),
        ],
      },
      SEP,
      cmd('file.quit', undefined, { hint: isHosted ? undefined : t('ブラウザで動かしているときは使えません') }),
    ],
  },
  {
    id: 'edit', label: t('編集'), mnemonic: 'E', items: () => [
      cmd('edit.undo'),
      cmd('edit.redo'),
      cmd('edit.history'),
      SEP,
      cmd('edit.cut'),
      cmd('edit.copy'),
      cmd('edit.paste'),
      cmd('edit.duplicate'),
      cmd('edit.delete'),
      SEP,
      cmd('edit.selectAll'),
      cmd('edit.clearMulti'),
      {
        // まとめての操作。使えないときは理由をツールチップに出す（隠さずに無効で見せる）
        label: t('並べ替えと大きさ'), enabled: has(), items: () => [
          cmd('edit.moveUp', undefined, { hint: moveDisabledReason(-1) ?? undefined }),
          cmd('edit.moveDown', undefined, { hint: moveDisabledReason(1) ?? undefined }),
          cmd('edit.newGroup', undefined, { hint: newGroupDisabledReason() ?? undefined }),
          SEP,
          cmd('edit.sizeLarge', undefined, { hint: sizeTargets().length ? undefined : t('大きさ（size）を持つ要素を選択してください') }),
          cmd('edit.sizeNormal', undefined, { hint: sizeTargets().length ? undefined : t('大きさ（size）を持つ要素を選択してください') }),
        ],
      },
      SEP,
      cmd('edit.format'),
      SEP,
      cmd('edit.palette'),
    ],
  },
  {
    id: 'view', label: t('表示'), mnemonic: 'V', items: () => {
      const s = app.session;
      const is2007 = app.store?.version === 'office2007';
      const modes = CANVAS_MODES.map((m): MenuItemDef => ({
        label: t(m.label),
        checked: has() && getCanvasMode() === m.mode,
        enabled: has() && (m.mode === 'ribbon' || !is2007),
        hint: is2007 && m.mode !== 'ribbon' ? t('customUI（2007）では使えません') : undefined,
        run: () => {
          setCanvasMode(m.mode);
          focusPane('canvas');
        },
      }));
      const parts: MenuItemDef[] = s && s.parts.size >= 2
        ? [SEP, ...[...s.parts.keys()].map((v): MenuItemDef => ({ label: v === 'office2010' ? t('customUI14.xml（2010以降）') : t('customUI.xml（2007）'), checked: s.active.version === v, run: () => app.switchPart(v) }))]
        : [];
      const theme = app.settings.theme;
      return [
        cmd('view.canvas', t('キャンバス')),
        cmd('view.tree', t('ツリー')),
        cmd('view.xml', t('XMLエディタ')),
        cmd('view.inspector', t('インスペクタ')),
        cmd('view.bottom', t('下部パネル'), { checked: !layout.isCollapsed('bottom') }),
        cmd('view.treeFilter'),
        SEP,
        ...modes,
        ...parts,
        SEP,
        ...previewMenuItems(),
        SEP,
        cmd('view.problems', t('問題')),
        cmd('view.callbacks', t('コールバック')),
        cmd('view.images', t('アイコン')),
        SEP,
        {
          label: t('テーマ'), items: () => [
            { label: t('システムに合わせる'), checked: theme === 'system', run: () => void updateSettings({ theme: 'system' }) },
            { label: t('ライト'), checked: theme === 'light', run: () => void updateSettings({ theme: 'light' }) },
            { label: t('ダーク'), checked: theme === 'dark', run: () => void updateSettings({ theme: 'dark' }) },
          ],
        },
        cmd('view.swap'),
        cmd('view.resetLayout'),
      ];
    },
  },
  {
    id: 'insert', label: t('挿入'), mnemonic: 'I', items: () => [
      ...INSERT_COMMON.map(insertItem),
      { label: t('その他の要素'), items: () => PALETTE_ITEMS.filter((tag) => !INSERT_COMMON.includes(tag)).map(insertItem) },
      SEP,
      cmd('insert.recipes'),
      cmd('insert.saveRecipe', t('選択中をレシピとして保存…')),
      SEP,
      cmd('insert.idMso'),
      cmd('insert.imageMso'),
    ],
  },
  {
    id: 'tools', label: t('ツール'), mnemonic: 'T', items: () => [
      cmd('tools.apply', undefined, { hint: app.info.excelInstalled ? undefined : t('Excelが見つからないため、ファイルへの書き込みだけを行います (F5)') }),
      cmd('tools.diff'),
      cmd('tools.distCheck'),
      cmd('tools.replaceIds'),
      SEP,
      cmd('tools.runMacro', undefined, { hint: runMacroHint() }),
      cmd('vba.reveal'),
      cmd('vba.refresh', undefined, { hint: app.session && !hasFile() ? t('サンプルは Excel で開かれていないため、VBA と照合できません') : undefined }),
      cmd('vba.insert'),
      cmd('vba.holder'),
      SEP,
      cmd('tools.icon'),
      cmd('tools.library'),
      SEP,
      cmd('tools.settings'),
    ],
  },
  {
    id: 'help', label: t('ヘルプ'), mnemonic: 'H', items: () => [
      cmd('help.shortcuts'),
      SEP,
      cmd('help.update'),
      cmd('help.releases'),
      cmd('help.github'),
      SEP,
      cmd('help.about'),
    ],
  },
];

// ---- ツールバーとタイトル ----

function toolbarButton(id: string, icon: string, label: string): void {
  $(id).replaceChildren(svg(icon), h('span', { class: 'tb-label' }, label));
}
toolbarButton('btn-open', uiIcons.open, t('開く'));
toolbarButton('btn-save', uiIcons.save, t('保存'));
toolbarButton('btn-undo', uiIcons.undo, t('元に戻す'));
toolbarButton('btn-redo', uiIcons.redo, t('やり直し'));
toolbarButton('btn-command', uiIcons.command, t('コマンド'));
$('btn-apply').replaceChildren(svg(uiIcons.apply), h('span', { class: 'tb-label' }, t('Excelへ反映')), h('kbd', null, 'F5'));

/** ツールバーのボタンと、同じ働きのコマンド。 */
const TOOLBAR_COMMAND: Readonly<Record<string, string>> = {
  'btn-open': 'file.open',
  'btn-save': 'file.save',
  'btn-undo': 'edit.undo',
  'btn-redo': 'edit.redo',
  'btn-command': 'edit.palette',
  'btn-apply': 'tools.apply',
};
const toolbarKeys = new Map<string, string>();

/** aria-keyshortcuts の書式（Control+S）で、コマンドのショートカット（別のキーも含む）を返す。 */
function toolbarShortcuts(commandId: string): string {
  let v = toolbarKeys.get(commandId);
  if (v === undefined) {
    const c = commands().find((x) => x.id === commandId);
    v = [c?.shortcut, ...(c?.altKeys ?? [])].filter((k): k is string => !!k).map((k) => k.replace(/Ctrl/g, 'Control').replace(/Del$/, 'Delete')).join(' ');
    toolbarKeys.set(commandId, v);
  }
  return v;
}

const tip = (title: string, shortcut?: string) => (shortcut ? `${title} (${shortcut})` : title);

function updateChrome(): void {
  const s = app.session;
  const store = app.store;
  const dirty = app.dirty;
  const busy = busyState();

  const chip = $('file-chip');
  chip.hidden = !s;
  if (s) {
    // 同梱のサンプルはパスが空なので、「サンプル」と出す
    const name = s.path === '' ? t('サンプル') : splitPath(s.path).name;
    $('file-name').textContent = name;
    const where = s.path === '' ? t('サンプル（保存できません）') : s.path;
    chip.title = dirty ? t('{path}（未保存の変更があります）', { path: where }) : where;
    const dot = $('file-dirty');
    dot.hidden = !dirty;
    dot.setAttribute('aria-label', t('未保存の変更があります'));
    dot.setAttribute('role', 'img');
  }
  document.title = s ? `${dirty ? '● ' : ''}${s.path === '' ? t('サンプル') : splitPath(s.path).name} - Sash` : 'Sash';

  const set = (id: string, enabled: boolean, title: string) => {
    const b = $<HTMLButtonElement>(id);
    b.disabled = !enabled;
    b.title = title;
    b.setAttribute('aria-label', title);
    // ショートカットはコマンドの定義から取る（メニューと同じ値を支援技術にも伝える）
    const keys = TOOLBAR_COMMAND[id] ? toolbarShortcuts(TOOLBAR_COMMAND[id]!) : '';
    if (keys) b.setAttribute('aria-keyshortcuts', keys);
    else b.removeAttribute('aria-keyshortcuts');
  };
  set('btn-open', busy === null, tip(t('開く'), 'Ctrl+O'));
  set('btn-save', !!s && busy === null, busy === 'save' ? t('保存しています…') : tip(t('保存'), 'Ctrl+S'));
  set('btn-undo', store?.canUndo === true, tip(historyTitle(t('元に戻す'), store?.undoLabel), 'Ctrl+Z'));
  set('btn-redo', store?.canRedo === true, tip(historyTitle(t('やり直し'), store?.redoLabel), 'Ctrl+Y'));
  set('btn-command', true, tip(t('コマンドパレット'), 'Ctrl+K'));
  set('btn-apply', !!s && busy === null,
    busy === 'apply' ? t('Excelへ反映しています…') : app.info.excelInstalled ? tip(t('Excelへ反映'), 'F5') : t('Excelが見つからないため、ファイルへの書き込みだけを行います (F5)'));
  $('btn-save').classList.toggle('busy', busy === 'save');
  $('btn-apply').classList.toggle('busy', busy === 'apply');

  const sw = $<HTMLSelectElement>('part-switch');
  sw.hidden = !s || s.parts.size < 2;
  if (s && s.parts.size >= 2) {
    sw.replaceChildren(
      ...[...s.parts.keys()].map((v) => h('option', { value: v, selected: s.active.version === v }, v === 'office2010' ? t('customUI14.xml（2010以降）') : t('customUI.xml（2007）'))),
    );
  }
}

// ツールバーは ←→ で移る（WAI-ARIA の toolbar と同じ。Tab ではツールバー全体を 1 つとして飛ばせる）
function setupToolbarKeys(bar: HTMLElement): void {
  const buttons = () => Array.from(bar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const roving = () => {
    const list = buttons();
    const current = list.find((b) => b.tabIndex === 0) ?? list[0];
    for (const b of Array.from(bar.querySelectorAll<HTMLButtonElement>('button'))) b.tabIndex = b === current ? 0 : -1;
  };
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    for (const b of list) b.tabIndex = -1;
    list[j]!.tabIndex = 0;
    list[j]!.focus();
  });
  bar.addEventListener('focusin', (e) => {
    const b = e.target as HTMLButtonElement;
    for (const x of Array.from(bar.querySelectorAll<HTMLButtonElement>('button'))) x.tabIndex = x === b ? 0 : -1;
  });
  // 無効になったボタンに tabindex=0 が残ると Tab で入れなくなるので、状態が変わるたびに付け直す
  app.on('store', roving);
  app.on('session', roving);
  onBusyChange(roving);
  roving();
}

// ---- 組み立て ----

const layout = mountLayout($('app'));
initPanes({ layout });
const menubar = mountMenubar($('menubar'), MENUS, {
  fallbackFocus: () => (app.session ? $('canvas') : document.querySelector<HTMLElement>('#home button')),
});
mountPalette($('palette'));
mountTree($('tree'));
mountCanvas($('canvas'), { onImageDrop: (files, path, target) => {
  // 選択は、ドロップされた要素のまま（分割ボタンなら分割ボタン）。書き込み先だけが中のボタンになる
  app.store?.select(path, 'canvas');
  openIconDialog(target, files);
} });
const xmlHandle = mountXmlEditor($('xml-editor'), $('xml-status'), { undo, redo });
setEditorThemeHandler((dark) => xmlHandle.setTheme(dark));
// 保存・反映・閉じる前に、インスペクタで入力中の値を確定させる
setPendingEditFlusher(flushPendingEdits);
mountInspector($('inspector'), {
  pickIdMso: (cur, apply) => {
    const tag = app.store?.selectedElement?.localName ?? '';
    openCatalog('idMso', cur, apply, tag === 'tab' || tag === 'group' || tag === 'contextMenu' ? tag : '');
  },
  pickImageMso: (cur, apply) => openCatalog('imageMso', cur, apply),
  editImage: (existing) => openImageEditor(undefined, existing),
  pickFromLibrary: () => {
    const store = app.store;
    const target = store?.selection ? iconTargetPath(store.doc, store.selection) : null;
    if (target) void openOnce('library', () => openLibrary((d) => applyLibraryIcon(target, d), notify));
  },
});
mountBottom($('bottom-tabs'), $('bottom-body'), notify, (existing) => {
  // 一覧から開いたときは、コントロールには設定せずに画像だけを作り直す
  openIconDialog(null, undefined, existing);
});
setElementMenuHooks({
  revealInXml: (p) => revealInXml(p),
  // Excel 連携の項目（仕様書 §18.4・§18.5）。使えないときは理由が分かるよう、隠さずに無効で出す
  extraItems: (path, el) => {
    const items: { label: string; disabled?: boolean; reason?: string; run?: () => void }[] = [];
    if (el.hasAttribute('onAction')) {
      const reason = runMacroDisabledReason(el);
      items.push({ label: t('マクロを Excel で試す'), disabled: reason !== '', reason: reason || undefined, run: () => void runMacroFor(el) });
    }
    const store = app.store;
    const name = store ? callbacksAt(store.doc, path).map((c) => c.name).find(canRevealInVbe) : undefined;
    if (name) items.push({ label: t('VBE で {name} を表示', { name }), run: () => void revealInVbe(name) });
    return items;
  },
});
// 幅を比べるモードで、キャンバスの高さを一時的に広げる（保存しない）
setCanvasGrowHandler((px) => layout.growTemporarily('top', px));
const home = mountHome($('home'), (p) => void openFile(p));

// XML ペインの名前に F6 での移り方を添える（index.html の既定は日本語のままなので、今の言語で付け直す）
document.querySelector('.xml-pane')?.setAttribute('aria-label', t('XMLエディタ（F6 で次のペインへ）'));

/**
 * 下部パネルを畳んだ帯に、中身の要約を出す。畳むと問題の数が見えなくなり、エラーに気づけないため。
 * 数えるのは、下部パネルのタブと同じもの（問題は情報を除く）。
 */
function updateBottomSummary(): void {
  if (!app.store) {
    layout.setCollapsedSummary('bottom', null);
    return;
  }
  const problems = app.problems.filter((p) => p.severity !== 'info').length + (app.store.syncError ? 1 : 0);
  layout.setCollapsedSummary('bottom', t('問題 {p} ・ コールバック {c}', { p: problems, c: vba.statuses().length }));
}
app.on('session', updateBottomSummary);
app.on('problems', updateBottomSummary);
app.on('vba', updateBottomSummary);

/**
 * 左右のペイン（パレット・ツリーとインスペクタ）を一時的に畳む（キャンバスを広くして、広い幅のリボンを見るため。仕様書 §18.7）。
 * 大きさは保存しないので、次の起動では元に戻る。通知の「元に戻す」で、すぐに元の大きさに戻せる。
 */
function collapseSidePanes(): void {
  if (layout.isCollapsed('left') && layout.isCollapsed('right')) {
    toast({ kind: 'info', message: t('左右のペインはすでに畳まれています') });
    return;
  }
  const restore = layout.collapseTemporarily(['left', 'right']);
  toast({ kind: 'info', message: t('左右のペインを一時的に畳みました'), action: { label: t('元に戻す'), run: restore }, timeout: 10000 });
}
// キャンバスの「左右のペインを一時的に畳む」から届く
window.addEventListener('sash:collapseSidePanes', collapseSidePanes);

// XML の構文エラー中などで編集を断ったときは、何が起きたか分かるように警告を出す
setEditRefusedHandler((message) => toast({ kind: 'warning', message }));

app.on('session', updateChrome);
app.on('store', updateChrome);
onBusyChange(updateChrome);

$('btn-open').addEventListener('click', () => void openFile());
$('btn-save').addEventListener('click', () => void save());
$('btn-apply').addEventListener('click', () => void applyToExcel());
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-command').addEventListener('click', () => openCommandPalette(paletteCommands));
setupToolbarKeys($('toolbar'));
initUpdates({ confirmDiscard });
$<HTMLSelectElement>('part-switch').addEventListener('change', (e) => app.switchPart((e.target as HTMLSelectElement).value as 'office2007' | 'office2010'));

// ---- ショートカット ----

/** 押されたキーに当たるコマンド。 */
function commandForKey(e: KeyboardEvent): AppCommand | undefined {
  return commands().find((c) => [c.shortcut, ...(c.altKeys ?? [])].some((k) => !!k && matchShortcut(e, k)));
}

/**
 * 入力欄の中でも受けるコマンド（保存・反映・ペインの移動など）は、捕捉の段階（capture）で先に受ける。
 * XML エディタ（Monaco）は自分のキー割り当て（Ctrl+K で始まる組み合わせ、F6 など）を先に処理して
 * 既定の動作を止めるので、バブリングの段階で待っていると届かない・二重に動くことがあるため。
 */
window.addEventListener('keydown', (e) => {
  if (isModalOpen() || menubar.isOpen() || e.isComposing) return;
  const c = commandForKey(e);
  if (!c?.inText) return;
  e.preventDefault();
  // Monaco などに渡ると、同じキーで別の動作（Ctrl+K の続きを待つなど）が始まってしまうので止める
  e.stopPropagation();
  if (c.enabled?.() ?? true) c.run();
}, true);

window.addEventListener('keydown', (e) => {
  // ダイアログ・コマンドパレット・メニューが開いている間は、それぞれのキー操作に任せる
  if (isModalOpen() || menubar.isOpen() || e.defaultPrevented || e.isComposing) return;
  const c = commandForKey(e);
  if (!c || c.inText) return;
  if (inTextField(e.target)) return;
  // メニューバー・ツールバー・右クリックメニューにフォーカスがあるときの Delete などは、
  // 選択中の要素への操作として扱わない（右クリックメニューを開いたまま要素が消え、古いメニューが残ってしまう）
  if (e.target instanceof Element && e.target.closest('#menubar, #toolbar, .ctx-menu, .menu-popup')) return;
  e.preventDefault();
  if (c.enabled?.() ?? true) c.run();
});

// ---- ファイルのドロップ ----
// どこに落としても WebView がファイルを開いて画面ごと移ってしまわないよう、window で必ず既定の動作を止める。
// 自分で受けるところ（キャンバスへの画像、アイコンエディタ）は preventDefault 済みなので、それ以外を開く処理に回す

window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = (e.target as HTMLElement).closest('.modal') ? 'none' : 'copy';
});
window.addEventListener('drop', (e) => {
  const files = e.dataTransfer?.files;
  const handled = e.defaultPrevented;
  e.preventDefault();
  if (handled || !files?.length || (e.target as HTMLElement).closest('.modal') || isModalOpen()) return;
  if (!/\.(xlsm|xlam|xltm|xlsb)$/i.test(files[0]!.name)) {
    toast({ kind: 'warning', message: t('.xlsm / .xlam / .xltm / .xlsb のファイルをドロップしてください') });
    return;
  }
  if (isHosted) sendDroppedFiles(files);
  else void openFile();
});

onHostEvent((e) => {
  if (e.event === 'fileDropped') void openFile(e.path);
  if (e.event === 'closeRequested') {
    // 確認の途中で × がもう一度押されたら、同じ確認を二重に出さない
    if (isQuitting()) return;
    // 取りやめたら、ホストに知らせて次の × を受け付けてもらう（知らせないと、しばらく × が効かない）
    void quit().then((closing) => {
      if (!closing) void invoke('app.closeCancelled').catch(() => undefined);
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
  // Excel のアイコンは、取り込み済みのキャッシュがあれば Excel がなくても出す。初めての起動なら裏で取り込みを始める（仕様書 §17.7）
  void initMsoIcons(info.excelInstalled);
  applyTheme();
  updateChrome();
  // app.info が届いてから取り直す（Excel で開いているブックが起動時に出なかった不具合の対策）
  home.refresh();
  const reopen = sessionGet(REOPEN_KEY);
  if (reopen !== null) sessionSet(REOPEN_KEY, null);
  const initialFile = reopen ?? ready.initialFile;
  if (initialFile) await openFile(initialFile, { force: true });
  else if (!isHosted && new URLSearchParams(location.search).has('sample')) await openFile(undefined, { force: true });
  notifyUpdated(ready.updatedFrom, ready.version);
  // 更新した直後の起動では確認しない（入れ替えたばかりのため）
  if (!ready.updatedFrom) void checkOnStartup();
}
