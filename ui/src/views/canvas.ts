// キャンバス（仕様書 §5.2）。本物の Excel（Microsoft 365）に近い見た目でリボンを描き、ドラッグで部品を置く。
// 組み込みタブと組み込みグループはグレーのプレースホルダーで示し、自分で足した部分だけを編集対象にする。
// 表示はリボン・Backstage・コンテキストメニューの3つを切り替える（一度に全部出すと、どれを編集しているか分かりにくいため）。

import '../styles-views.css';
import { app } from '../app';
import { catalog, labels, onLabelsLoaded } from '../catalog/catalog';
import { allowedIndex, handleEditKey, moveSelected, runEdit } from '../clipboard';
import { canDropInto, canDropManyAt, drop, draggedTag, endDrag, startDrag, dragPayload } from '../dnd';
import { h, VISIBILITY_OPTIONS } from '../dom';
import {
  allElements, childElements, createElement, elementAt, ensureContextMenus, ensureTabs, isSameElementAt, pathOf, samePath, isAncestorPath, snapshotOf, type Path,
} from '../model';
import { msoIcon, onMsoIconsLoaded } from '../msoIcons';
import { followBackstageSelection, renderBackstage, resetBackstage } from './backstage';
import { closeMenu, openElementMenu, openMenu } from './contextMenu';
import { focusField } from './inspector';
import { defFor, inBackstage, titleOf } from '../schema';
import { lang, t as tr } from '../i18n';
import { notify } from '../shell/toast';
import { openRecipes } from '../dialogs/recipeDialog';
import { openOnce } from '../dialogs/modal';
import {
  availableForGroups, effectiveWidth, getCheckWidths, RIBBON_RESERVED_PX, RULER_MARKS, SCALE_CHOICES, setCheckWidths, setFitReport, simulateFit, WIDTH_CHOICES,
  type FitGroupInput, type FitGroupResult, type FitReportEntry, type GroupFitState,
} from './ribbonFit';
import { clearOverrides, getOverride, overrideCount, overrideKey, overridesSignature, preview, setOverride, setPreview, type FitMode, type PreviewSettings } from './ribbonPreview';
import { excelWidthDisabledReason, fitExcelToPreview } from './excelWidth';
import { attachScreentips, BUILTIN_TAB_KEYTIPS, duplicateKeytips, screentipContent, type ScreentipContent } from './ribbonTips';

/** 表示する組み込みタブ（Excel の既定の並び）。 */
const BUILTIN_TABS: readonly [string, string, string][] = [
  ['TabHome', 'ホーム', 'Home'],
  ['TabInsert', '挿入', 'Insert'],
  ['TabPageLayoutExcel', 'ページ レイアウト', 'Page Layout'],
  ['TabFormulas', '数式', 'Formulas'],
  ['TabData', 'データ', 'Data'],
  ['TabReview', '校閲', 'Review'],
  ['TabView', '表示', 'View'],
  ['TabDeveloper', '開発', 'Developer'],
  ['HelpTab', 'ヘルプ', 'Help'],
];

/**
 * よく使うタブの組み込みグループの日本語名（Excel の表示名）。Excel がない環境では表示名が取れず、
 * グループ名が Clipboard のような英語の ID になってしまうため、同梱の対応表で補う（C-7）。Excel から表示名が届けばそちらを使う。
 * 日本語版 Excel（Microsoft 365）の見え方からの対応で、実機のバージョンによる呼び名の違いまでは確かめていない。
 */
const BUILTIN_GROUP_JA: Readonly<Record<string, string>> = {
  GroupClipboard: 'クリップボード', GroupFont: 'フォント', GroupAlignmentExcel: '配置', GroupNumber: '数値', GroupStyles: 'スタイル',
  GroupCells: 'セル', GroupEditingExcel: '編集', GroupIdeas: 'アイデア', GroupClassifyLabelProtect: '秘密度',
  GroupInsertTablesExcel: 'テーブル', GroupInsertIllustrations: '図', GroupOfficeExtension: 'アドイン', GroupInsertChartsExcel: 'グラフ',
  GroupPowerMap: 'ツアー', GroupSparklinesInsert: 'スパークライン', GroupSlicerInsert: 'フィルター', GroupInsertLinks: 'リンク',
  GroupInsertComments: 'コメント', GroupInsertText: 'テキスト', GroupInsertSymbols: '記号と特殊文字',
  GroupThemesExcel: 'テーマ', GroupPageSetup: 'ページ設定', GroupPageLayoutScaleToFit: '拡大縮小印刷', GroupPageLayoutSheetOptions: 'シートのオプション', GroupArrange: '配置',
  GroupFunctionLibrary: '関数ライブラリ', GroupNamedCells: '定義された名前', GroupFormulaAuditing: 'ワークシート分析', GroupCalculation: '計算方法',
  GroupGetExternalData: '外部データの取り込み', GroupPowerQueryGetTransformData: 'データの取得と変換', GroupConnections: 'クエリと接続',
  GroupDataQueriesAndConnections: 'クエリと接続', GroupSortFilter: '並べ替えとフィルター', GroupDataTools: 'データ ツール', GroupForecast: '予測', GroupOutline: 'アウトライン',
  GroupProofing: '文章校正', GroupAccessibility: 'アクセシビリティ', GroupInsights: 'インサイト', GroupLanguage: '言語', GroupComments: 'コメント',
  GroupThreadedComments: 'コメント', GroupCommentsLegacy: 'コメント', GroupChangesExcel: '変更', GroupProtectExcel: '保護', GroupInk: 'インク',
  GroupNamedSheetView: 'シート ビュー', GroupWorkbookViews: 'ブックの表示', GroupViewShowHide: '表示', GroupZoom: 'ズーム', GroupWindow: 'ウィンドウ', GroupMacros: 'マクロ',
  GroupCode: 'コード', GroupAddins: 'アドイン', GroupControls: 'コントロール', GroupXml: 'XML',
  GroupHelpAndSupport: 'ヘルプ', GroupExcelCommunity: 'コミュニティ',
};

/** 組み込みグループの表示名。Excel から届いた名前、日本語の対応表、ID の順。 */
export function builtinGroupName(id: string): string {
  return labels.get(id) ?? (lang === 'ja' ? BUILTIN_GROUP_JA[id] : undefined) ?? id.replace(/^Group/, '');
}

/** 組み込みタブの表示名。「表示」は属性の分類名と同じ文言なので、辞書ではなくここで英語にする。 */
function tabName(ja: string, en: string): string {
  return lang === 'en' ? en : ja;
}

export type CanvasMode = 'ribbon' | 'backstage' | 'contextMenu';

let mode: CanvasMode = 'ribbon';

/**
 * 表示中のタブ。自作タブは id（なければパス）で覚える。
 * パスだけで覚えると、前にタブを挿入しただけで別のタブに切り替わってしまうため（不具合 32）。
 */
let activeTab: { kind: 'el'; id: string | null; path: Path } | { kind: 'builtin'; idMso: string } | null = null;

let onImageDrop: ((files: FileList, target: Path) => void) | null = null;
let hostEl: HTMLElement | null = null;
/** 直前の描画にあった要素。編集のあとで選択が新しい要素に移ったら、挿入したものとして目立たせる。 */
let known = new WeakSet<Element>();
let flashPath: Path | null = null;
let scrollToSelection = false;
/** その場でラベルを編集している間は描き直さない（入力中の文字が消えるため）。 */
let renaming = false;
/**
 * 入力中のその場リネームを、確定せずに捨てる関数（入力中だけ入る）。
 * 入力中に別の経路（XML エディタ・元に戻す・インスペクタなど）で文書が変わると、入力欄が持つパスが古くなり、
 * 確定したときに別の要素のラベルを書き換えかねないため、ストアの変更を受けたらこれで捨てる。
 */
let cancelRename: ((doc: Document) => void) | null = null;
/** 枠の大きさの変化を見張る。mountCanvas が二度呼ばれても前のものを外せるよう、モジュールで持つ。 */
let popupObserver: ResizeObserver | null = null;
let layoutObserver: MutationObserver | null = null;
/** 直前の描画で選んでいた要素。選択が変わったときだけ、ポップアップの中の選択肢を見える位置まで送る。 */
let lastPopupSelection: string | null = null;
/**
 * 外を押して閉じたメニューのポップアップ（メニュー要素のパスを . でつないだもの）。ポップアップは「メニューか
 * その中身が選ばれている間は開く」作りなので、選んだままほかの場所を押しても開いたままだった。外を押したら
 * 閉じたことを覚えておき、選択が変わるか、開き口をもう一度押したら忘れる。
 */
let dismissedPopup: string | null = null;

// ---- 幅のプレビュー（仕様書 §5.2「幅のプレビュー」） ----

/** 畳んだグループのうち、一時的に広げて編集しているもの（パスの文字列）。幅を変えたら元に戻す。 */
const tempExpanded = new Set<string>();
/** 見出しで開いているメニュー。 */
let headerMenu: 'view' | 'dynamic' | 'checks' | null = null;
/** 「動的な状態を試す」で目立たせる要素（インスペクタの「キャンバスで試す」から開いたとき）。 */
let dynamicFocus: string | null = null;
/** グループの幅を測っている間は、ポップアップやキーヒントを描かない（幅に関係せず、選択の検索の邪魔になるため）。 */
let measuring = false;
/** 比べる側（読み取り専用）の枠を描いている間。メニューのポップアップは開かない。 */
let readOnlyRender = false;
/** 測った幅の控え。鍵はグループの XML・言語・試し表示。描き直しのたびに全部を測り直さないため。 */
const widthCache = new Map<string, FitGroupInput['widths']>();

/**
 * 縮小率がこれより小さくなったら、「ペインを畳む」を勧める（0.5 だと 57% など実用にならない小ささでも出なかったため 0.8 にした）。
 * さらに LOW_ZOOM_NOTICE（70%）より小さいときは、状態の文言で文字が小さく表示されることを知らせる。
 */
const LOW_ZOOM_SUGGEST = 0.8;
const LOW_ZOOM_NOTICE = 0.7;

/**
 * 大きいボタンのラベルの折り返し。Excel は大きいボタンのラベルを 2 行までに収め、
 * 2 行目の末尾に ▼ を置く。日本語の折り返し位置（文字単位で折るか、どの幅で折るか）は
 * Microsoft 365 の画面写真からの見積もりで、実機の Excel では確かめていない。
 */
const LARGE_LABEL_WRAP = { maxWidthPx: 76, maxLines: 2 } as const;

/** 1 枠ぶんの描き方。 */
interface RibbonView {
  /** 実効の幅（CSS px）。null は「自由」。 */
  effective: number | null;
  /** 比べる側の枠。編集できない。 */
  readOnly: boolean;
}

/** 表示中のタブについての見積もり（見出しに出す）。 */
interface ViewFit {
  builtin: boolean;
  collapsed: string[];
  clipped: string[];
}

export function getCanvasMode(): CanvasMode {
  return mode;
}

/** 表示を切り替える。メニューバーなどが表示を合わせられるよう、sash:canvasmode を投げる。 */
export function setCanvasMode(next: CanvasMode): void {
  if (next !== 'ribbon' && app.store?.version === 'office2007') next = 'ribbon';
  const changed = next !== mode;
  mode = next;
  if (hostEl) renderCanvas(hostEl);
  if (changed) window.dispatchEvent(new CustomEvent('sash:canvasmode', { detail: { mode } }));
}

// ---- 幅のプレビューの切り替え（表示 メニュー・コマンドパレットから使う） ----

/** 設定を変えて描き直す。幅や拡大率が変わったら、一時的に広げたグループは畳み直す（位置の前提が変わるため）。 */
function applyPreview(patch: Partial<PreviewSettings>): void {
  const p = preview();
  if (('width' in patch && patch.width !== p.width) || (patch.scale !== undefined && patch.scale !== p.scale)) tempExpanded.clear();
  if (patch.width !== undefined && patch.width !== null && !WIDTH_CHOICES.includes(patch.width)) patch.customWidth = patch.width;
  setPreview(patch);
  if (hostEl) renderCanvas(hostEl);
}

/** 画面の幅（px）。null は「自由」。 */
export function setPreviewWidth(width: number | null): void {
  applyPreview({ width });
}

/** Windows の拡大率（%。100 / 125 / 150）。 */
export function setPreviewScale(scale: number): void {
  if (SCALE_CHOICES.includes(scale)) applyPreview({ scale });
}

/** 収める（fit）／等倍（actual）。 */
export function setFitMode(fit: FitMode): void {
  applyPreview({ fit });
}

/** キーヒントの表示を切り替える。切り替えた後の状態を返す。 */
export function toggleKeytips(): boolean {
  applyPreview({ keytips: !preview().keytips });
  return preview().keytips;
}

/** いまのプレビューの設定（読み取り専用）。 */
export function getPreviewState(): Readonly<PreviewSettings> {
  return preview();
}

/** キャンバスにフォーカスを移す（Ctrl+1 / F6）。 */
export function focus(): void {
  hostEl?.focus({ preventScroll: true });
  revealNode(hostEl && app.store?.selection ? nodeOf(hostEl, app.store.selection) : null);
}

/** 要素を見える位置に出す。ポップアップの中の項目は、ポップアップの中だけを送る。 */
function revealNode(node: HTMLElement | null | undefined): void {
  if (!node) return;
  const popup = node.closest<HTMLElement>('.rb-menu-popup');
  if (popup) revealInPopup(popup, node);
  else node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function mountCanvas(host: HTMLElement, opts: { onImageDrop: (files: FileList, target: Path) => void }): void {
  onImageDrop = opts.onImageDrop;
  hostEl = host;
  // tabindex がないと Ctrl+1 で focus() しても移らない（不具合 23）
  host.tabIndex = 0;
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', tr('キャンバス'));
  const render = () => renderCanvas(host);
  // ポップアップの外（開き口も除く）を押したら閉じる。Excel のドロップダウンと同じく、ほかの場所を押せば消えるように
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // 閉じたメニューの開き口をもう一度押したら、選択が変わらなくても開き直す
    if (dismissedPopup !== null) {
      const node = target.closest<HTMLElement>('[data-sel][data-path]');
      if (node && host.contains(node) && node.dataset['path'] === dismissedPopup) {
        dismissedPopup = null;
        renderCanvas(host);
      }
      return;
    }
    const popups = Array.from(host.querySelectorAll<HTMLElement>('.rb-menu-popup'));
    if (popups.length === 0) return;
    if (popups.some((p) => p.contains(target) || (p.parentElement?.contains(target) ?? false))) return;
    // いちばん外側のメニューを閉じれば、中の入れ子のポップアップも一緒に消える
    const outer = popups.find((p) => !p.parentElement?.closest('.rb-menu-popup')) ?? popups[0]!;
    dismissedPopup = outer.dataset['container'] ?? null;
    if (dismissedPopup !== null) renderCanvas(host);
  }, true);
  // スクロールや大きさの変更でメニューの開き口が動いたら、ポップアップも付いていかせる。
  // スクロールするのはキャンバスの枠（.canvas-pane）なので、host ではなくその枠で捕まえる。
  // ポップアップ自身のスクロールは無視する（置き直すと高さを測り直す間に scrollTop が 0 に戻り、長いメニューを下まで送れないため）
  const pane = paneOf(host);
  pane.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.closest('.rb-menu-popup')) return;
    placePopups(host);
  }, true);
  window.addEventListener('resize', () => {
    updateZoom(host);
    placePopups(host);
  });
  // スプリッターのドラッグや隣の枠を畳んだときは window の resize が来ないので、枠の大きさの変化を見張る。
  // 左の枠を広げてもキャンバスの幅が変わらない（位置だけずれる）ことがあるので、大きさだけでなく、
  // レイアウトの変数（--left など）とクラス（collapsed-*）を書き換える #app の属性の変化も見張る
  popupObserver?.disconnect();
  layoutObserver?.disconnect();
  let queued = false;
  const queuePlace = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // テスト環境の破棄後に遅れて発火しても DOM を触らない
      if (typeof window === 'undefined') return;
      // 枠の幅が変わったら「収める」の縮小率も変わる
      updateZoom(host);
      placePopups(host);
    });
  };
  if (typeof ResizeObserver !== 'undefined') {
    popupObserver = new ResizeObserver(queuePlace);
    popupObserver.observe(pane);
    if (pane !== host) popupObserver.observe(host);
  }
  const layoutRoot = host.closest<HTMLElement>('#app');
  if (layoutRoot && typeof MutationObserver !== 'undefined') {
    layoutObserver = new MutationObserver(queuePlace);
    layoutObserver.observe(layoutRoot, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  app.on('session', () => {
    activeTab = null;
    resetBackstage();
    // 試し表示と一時的な展開は、別のファイルの同じ id に効いてしまわないよう消す
    clearOverrides();
    tempExpanded.clear();
    widthCache.clear();
    headerMenu = null;
    // 別のファイルでは、タブの欄の位置を前のファイルから引き継がない
    resetTabScroll = true;
    lastActiveTabKey = null;
    known = new WeakSet();
    if (mode !== 'ribbon') setCanvasMode('ribbon');
    render();
  });
  app.on('store', (c) => {
    const store = app.store;
    if (!c || !store) return;
    // 入力中に文書が変わって入力欄のパスが別の要素を指すようになったら（自分の確定は renaming を下ろしてから編集するので、
    // ここには来ない）入力を捨てて描き直す。捨てないと、確定したとき別の要素のラベルを書き換えてしまう
    if (renaming && c.kinds.has('doc')) cancelRename?.(store.doc);
    if (c.kinds.has('selection')) {
      dismissedPopup = null;
      followSelection(c.source === 'canvas');
      if (c.source !== 'canvas') scrollToSelection = true;
    }
    // 挿入（貼り付け・複製・ドロップを含む）の直後は、新しい要素を目立たせる（A3）
    if (c.kinds.has('doc') && c.source !== 'xml' && c.source !== 'history') {
      const sel = store.selectedElement;
      if (sel && !known.has(sel)) {
        flashPath = store.selection;
        scrollToSelection = true;
      }
    }
    render();
  });
  app.on('problems', render);
  onMsoIconsLoaded(render);
  // Excel の表示名が届いたら、表示名で描いた幅が変わるので測り直す
  onLabelsLoaded(() => {
    widthCache.clear();
    render();
  });
  // 確かめる幅を変えたら測り直す
  window.addEventListener('sash:fitsettings', render);
  // 表示 メニュー（shell/previewCommands.ts）からの切り替え。detail は { width?, scale?, mode?, keytips? }
  window.addEventListener('sash:preview', (e) => {
    const d = (e as CustomEvent<{ width?: number | null; scale?: number; mode?: FitMode; keytips?: boolean } | undefined>).detail ?? {};
    const patch: Partial<PreviewSettings> = {};
    if ('width' in d && (d.width === null || (typeof d.width === 'number' && d.width >= 320))) patch.width = d.width ?? null;
    if (typeof d.scale === 'number' && SCALE_CHOICES.includes(d.scale)) patch.scale = d.scale;
    if (d.mode === 'fit' || d.mode === 'actual') patch.fit = d.mode;
    if (typeof d.keytips === 'boolean') patch.keytips = d.keytips;
    applyPreview(patch);
  });
  // 文字の読み込みが終わると幅が変わるので、測った幅を捨てる
  document.fonts?.addEventListener?.('loadingdone', () => {
    widthCache.clear();
    render();
  });
  attachScreentips(host, (node) => tipFor(node));
  // 右クリックメニュー（contextMenu.ts）の「前に挿入／子を追加」の直後。contextMenu は canvas を import できない（循環するため）ので、イベントで受ける
  window.addEventListener('sash:startRename', (e) => {
    const path = (e as CustomEvent<{ path?: number[] }>).detail?.path;
    if (Array.isArray(path)) startRenameOf(path);
  });
  // インスペクタの「キャンバスで試す」：その要素を選び、リボンの表示で「動的な状態を試す」を開く
  window.addEventListener('sash:dynamicSim', (e) => {
    const path = (e as CustomEvent<{ path?: number[] }>).detail?.path;
    if (!app.store || !Array.isArray(path)) return;
    dynamicFocus = path.join('.');
    headerMenu = 'dynamic';
    if (mode !== 'ribbon') setModeQuiet('ribbon');
    if (!samePath(app.store.selection, path)) app.store.select(path, 'other');
    render();
    // 開いたメニューの中の、その要素の行へ送ってフォーカスする
    const row = host.querySelector<HTMLElement>(`.cv-dyn-row[data-dyn-path="${dynamicFocus}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    row?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
  });
  // 見出しのメニューは、外を押したら閉じる
  window.addEventListener('mousedown', (e) => {
    if (!headerMenu) return;
    const target = e.target as HTMLElement;
    if (target.closest?.('.cv-pop, [data-menu-button]')) return;
    // ここで描き直すと、押した要素（タブなど）が作り直されてクリックが届かなくなるので、メニューだけを外す
    headerMenu = null;
    dynamicFocus = null;
    for (const pop of Array.from(host.querySelectorAll('.cv-pop'))) pop.remove();
    for (const b of Array.from(host.querySelectorAll<HTMLElement>('[data-menu-button]'))) {
      b.classList.remove('active');
      b.setAttribute('aria-expanded', 'false');
    }
  }, true);

  host.addEventListener('dragover', (e) => onDragOver(e, host));
  host.addEventListener('dragleave', (e) => {
    if (!host.contains(e.relatedTarget as Node)) hideIndicator(host);
  });
  host.addEventListener('drop', (e) => onDrop(e, host));
  // ドラッグを Esc で取り消したときやキャンバスの外に落としたときも、表示と状態を残さない（不具合 33）
  window.addEventListener('dragend', () => {
    hideIndicator(host);
    endDrag();
  }, true);
  // Ctrl（⌘）+クリックで選び足す・外す、Shift+クリックで範囲を選ぶ（仕様書 §19）。
  // 要素ごとのクリックの処理（タブの切り替え・メニューを開くなど）より先に、捕捉の段階で受けて止める
  host.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    const node = (e.target as HTMLElement).closest<HTMLElement>('[data-sel][data-path]');
    const path = parsePath(node?.dataset['path']);
    const store = app.store;
    if (!node || !path || !store || !host.contains(node) || node.closest('.cv-header, .cv-pop')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) {
      // 親が違うときは、キャンバスに描かれている順（文書の順と同じ先行順）で範囲を決める
      store.selectRange(path, 'canvas', renderedPaths(host));
    } else {
      store.toggleSelect(path, 'canvas');
    }
  }, true);
  host.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === host || target.classList.contains('rb-body') || target.classList.contains('cv-stage') || target.classList.contains('cv-frame') || target.classList.contains('cv-zoom')) app.store?.select(null, 'canvas');
  });
  host.addEventListener('keydown', (e) => onKey(e, host));
  host.addEventListener('contextmenu', (e) => {
    const node = (e.target as HTMLElement).closest<HTMLElement>('[data-sel]');
    const path = parsePath(node?.dataset['path']);
    if (!path || !app.store) return;
    e.preventDefault();
    // 複数選択の中の要素で開いたときは、選択を保ったまま、まとめての操作のメニューを出す
    if (!(app.store.isMulti && app.store.isSelected(path))) app.store.select(path, 'canvas');
    openElementMenu(e.clientX, e.clientY, path, 'canvas', host);
  });
}

/** 選択がタブ（または Backstage・コンテキストメニュー）の中に移ったら、そこを表示する。 */
function followSelection(fromCanvas: boolean): void {
  const store = app.store;
  const sel = store?.selection;
  if (!store || !sel) return;
  if (followBackstageSelection(store.doc, sel)) {
    if (mode !== 'backstage') setModeQuiet('backstage');
    return;
  }
  let el = elementAt(store.doc, sel);
  for (let cur = el; cur; cur = cur.parentElement) {
    if (cur.localName === 'contextMenus') {
      if (mode !== 'contextMenu') setModeQuiet('contextMenu');
      return;
    }
  }
  while (el && el.localName !== 'tab') el = el.parentElement;
  if (!el) {
    if (!fromCanvas && mode !== 'ribbon' && sel.length > 0) setModeQuiet('ribbon');
    return;
  }
  if (mode !== 'ribbon') setModeQuiet('ribbon');
  const idMso = el.getAttribute('idMso');
  activeTab = idMso && isBuiltinTab(idMso) && !el.getAttribute('id') ? { kind: 'builtin', idMso } : { kind: 'el', id: el.getAttribute('id'), path: pathOf(el) };
}

/** 描き直しは呼び出し元に任せて、表示だけを切り替える。 */
function setModeQuiet(next: CanvasMode): void {
  mode = next;
  window.dispatchEvent(new CustomEvent('sash:canvasmode', { detail: { mode } }));
}

function isBuiltinTab(idMso: string): boolean {
  return BUILTIN_TABS.some(([id]) => id === idMso);
}

function builtinTabLabel(idMso: string): string {
  const builtin = BUILTIN_TABS.find(([id]) => id === idMso);
  return builtin ? tabName(builtin[1], builtin[2]) : labels.get(idMso) ?? idMso;
}

// ---- 描画 ----

interface TabEntry {
  key: string;
  label: string;
  builtin: boolean;
  /** 自作タブか、組み込みタブに手を加えた tab 要素。 */
  el: Element | null;
  idMso: string | null;
}

function findChild(el: Element | null | undefined, name: string): Element | undefined {
  return el ? childElements(el).find((c) => c.localName === name) : undefined;
}

function collectTabs(doc: Document): TabEntry[] {
  const ribbon = findChild(doc.documentElement, 'ribbon');
  const fromScratch = ribbon?.getAttribute('startFromScratch') === 'true' || ribbon?.getAttribute('startFromScratch') === '1';
  const tabsEl = findChild(ribbon, 'tabs');
  const tabEls = tabsEl ? childElements(tabsEl).filter((x) => x.localName === 'tab') : [];
  const entries: TabEntry[] = fromScratch
    ? []
    : BUILTIN_TABS.map(([idMso, ja, en]) => ({ key: `builtin:${idMso}`, label: tabName(ja, en), builtin: true, el: null, idMso }));

  for (const x of tabEls) {
    const idMso = x.getAttribute('idMso');
    if (idMso) {
      const existing = entries.find((e) => e.idMso === idMso);
      if (existing) {
        existing.el = x;
        continue;
      }
      entries.push({ key: `builtin:${idMso}`, label: builtinTabLabel(idMso), builtin: true, el: x, idMso });
      continue;
    }
    const entry: TabEntry = { key: pathOf(x).join('.'), label: labelOf(x), builtin: false, el: x, idMso: null };
    const after = x.getAttribute('insertAfterMso');
    const before = x.getAttribute('insertBeforeMso');
    // insertAfterMso / insertBeforeMso がなければ末尾に足す（null で探すと、先に足した自作のタブ（idMso が null）に当たり、並びが逆になるため）
    const target = after ?? before;
    const anchor = target ? entries.findIndex((e) => e.idMso === target) : -1;
    if (anchor >= 0) entries.splice(after ? anchor + 1 : anchor, 0, entry);
    else entries.push(entry);
  }
  return entries;
}

function labelOf(el: Element): string {
  const label = el.getAttribute('label');
  if (label !== null) return label;
  const getLabel = el.getAttribute('getLabel');
  // 「動的な状態を試す」でラベルの例を入れていれば、それを出す
  if (getLabel) return getOverride(overrideKey(el, pathOf(el)))?.label ?? `{${getLabel}}`;
  const idMso = el.getAttribute('idMso');
  if (idMso) return labels.get(idMso) ?? idMso;
  return el.getAttribute('id') ?? '';
}

function isSelected(el: Element): boolean {
  return samePath(app.store?.selection ?? null, pathOf(el));
}

/** 表示中のタブを決める。未選択なら最初の自作タブ、なければホーム。 */
function resolveActive(tabs: TabEntry[]): TabEntry | undefined {
  let active: TabEntry | undefined;
  const at = activeTab;
  if (at?.kind === 'el') {
    active = tabs.find((x) => x.el !== null && !x.builtin && (at.id !== null ? x.el.getAttribute('id') === at.id : samePath(pathOf(x.el), at.path)));
    // id を変えたときなどは、パスで探し直す
    active ??= tabs.find((x) => x.el !== null && samePath(pathOf(x.el), at.path));
  } else if (at?.kind === 'builtin') {
    active = tabs.find((x) => x.idMso === at.idMso);
  }
  return active ?? tabs.find((x) => !x.builtin) ?? tabs.find((x) => x.el !== null) ?? tabs[0];
}

/** 見出しやメニューの操作のあとに描き直す。 */
function rerender(): void {
  if (hostEl) renderCanvas(hostEl);
}

function renderHeader(fit: ViewFit | null): HTMLElement {
  const v2007 = app.store?.version === 'office2007';
  // short は見出しが狭いときに出す短い名前（CSS のコンテナークエリで切り替える）
  const seg = (m: CanvasMode, label: string, short?: string) =>
    h('button', {
      type: 'button',
      class: mode === m ? 'active' : '',
      'aria-pressed': String(mode === m),
      'aria-label': label,
      disabled: m !== 'ribbon' && v2007,
      title: m !== 'ribbon' && v2007 ? tr('customUI14（2010以降）の形式でのみ使えます') : short ? label : '',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        setCanvasMode(m);
      },
    }, short ? [h('span', { class: 'cv-long' }, label), h('span', { class: 'cv-short', 'aria-hidden': 'true' }, short)] : label);
  const modes = h('div', { class: 'segmented cv-modes', role: 'group', 'aria-label': tr('キャンバスの表示') }, seg('ribbon', tr('リボン')), seg('backstage', 'Backstage'), seg('contextMenu', tr('コンテキストメニュー'), tr('右クリック')));
  // 操作の説明は長いので、小さな「?」のツールチップに回す（1 行に収めるため）
  const hint = h('span', { class: 'cv-hint', tabIndex: 0, role: 'note', 'aria-label': tr('キー操作'), title: tr('矢印キーで移動・Enter で編集・右クリックでメニュー・Ctrl+クリックで選び足す・Shift+クリックで範囲を選ぶ') }, '?');
  // 複数選択の数（仕様書 §19）。見出しの 1 行に収まるよう、短い印にする。
  // 状態の文字（縮むほう）より前に置く。後ろに置くと、狭い画面では見出しの右端からはみ出して見えなくなるため
  const count = app.store?.isMulti ? multiBadge(app.store.selections.length) : null;
  // 見出しは 1 行に収める（2 段・3 段になると、既定の高さ 260px のキャンバスでリボンが見出しの下に隠れるため）。
  // 毎回は使わない切り替え（比べる・キーヒント・VBA で変わる表示・チェックする幅・Excel の幅）は「表示」メニューにまとめた
  if (mode !== 'ribbon') return h('div', { class: 'cv-header' }, modes, count, h('span', { class: 'cv-spacer' }), hint);
  return h('div', { class: 'cv-header' }, modes, renderWidthControls(), count, renderStatus(fit), renderViewMenu(), hint);
}

/** 「3 個選択中」の印。押すと、主な選択だけに戻す（Esc と同じ）。読み上げは announceSelection の領域が受け持つ。 */
function multiBadge(n: number): HTMLElement {
  const long = tr('{n} 個選択中', { n });
  return h('button', {
    type: 'button',
    class: 'cv-multi',
    'aria-label': long,
    title: tr('Esc で主な選択だけに戻します'),
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      app.store?.clearMulti('canvas');
    },
  }, h('span', { class: 'cv-long' }, long), h('span', { class: 'cv-short', 'aria-hidden': 'true' }, tr('{n} 個', { n })));
}

/**
 * 選んだ要素の読み上げ文。「ボタン 集計する、集計 グループ、4 個中 1 個目」。
 * 種類・名前・親（種類と名前）・兄弟の中での位置の順。名前がなければ種類だけにし、親がなければ（ルートなど）位置も省く。
 */
export function describeSelection(el: Element): string {
  const name = (e: Element) => labelOf(e) || e.getAttribute('id') || '';
  // 自分は「ボタン 集計する」、親は「集計 グループ」の順（Excel の読み上げと同じく、親は名前を先に言う）
  const self = name(el) ? tr('{kind} {name}', { kind: titleOf(el.localName), name: name(el) }) : titleOf(el.localName);
  const parts = [self];
  const parent = el.parentElement;
  if (parent) {
    const sibs = childElements(parent);
    parts.push(name(parent) ? tr('{name} {kind}', { kind: titleOf(parent.localName), name: name(parent) }) : titleOf(parent.localName));
    parts.push(tr('{n} 個中 {i} 個目', { n: sibs.length, i: sibs.indexOf(el) + 1 }));
  }
  return parts.join(lang === 'en' ? ', ' : '、');
}

/**
 * 選択の数を読み上げる領域。描き直しのたびに作り直すと、読み上げソフトが変化として拾わないことがあるので、
 * 1 つだけ作って残し、文字だけを書き換える（同じ文字なら書き換えず、描き直しのたびに読み上げないようにする）。
 */
let liveRegion: HTMLElement | null = null;
function announceSelection(): void {
  const store = app.store;
  let text = '';
  if (store?.isMulti) text = tr('{n} 個選択中', { n: store.selections.length });
  // 1 つだけ選んだときは「ボタン 集計する、集計 グループ、4 個中 1 個目」の形で読み上げる（C-5）。
  // ツリーなどキャンバスの外を操作しているときは、そちらが自分で読み上げるので二重にならないよう書かない
  else if (store?.selectedElement && hostEl && hostEl.contains(document.activeElement)) text = describeSelection(store.selectedElement);
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', dataset: { live: 'selection' } });
    document.body.append(liveRegion);
  }
  if (liveRegion.textContent !== text) liveRegion.textContent = text;
}

/**
 * 複数選択のうち、主な選択以外の要素に印を付ける（主な選択はこれまでどおり selected で、フォーカスの枠も付く）。
 * aria-selected は付けない。キャンバスの要素は選べる項目の役割（option・treeitem）を持たず、タブは role="tab" の
 * aria-selected を「表示中のタブ」に使っているため、付けると意味が食い違う。選んだ数は announceSelection で知らせ、
 * 選択の状態そのものはツリー（treeitem の aria-selected）で伝える。
 */
function markSecondary(host: HTMLElement): void {
  const store = app.store;
  if (!store?.isMulti) return;
  for (const p of store.selections) {
    if (samePath(p, store.selection)) continue;
    for (const n of Array.from(host.querySelectorAll<HTMLElement>(`[data-sel][data-path="${p.join('.')}"]`))) n.classList.add('multi-selected');
  }
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  return h('option', { value, selected }, label);
}

/** 画面の幅・拡大率・表示のしかた（全体を表示／実寸）。 */
function renderWidthControls(): HTMLElement {
  const p = preview();
  const choice = p.width === null ? 'free' : WIDTH_CHOICES.includes(p.width) ? String(p.width) : 'custom';
  const widthSel = h(
    'select',
    {
      class: 'cv-select',
      'aria-label': tr('画面の幅'),
      title: tr('画面の幅'),
      dataset: { fk: 'width' },
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        applyPreview({ width: v === 'free' ? null : v === 'custom' ? p.customWidth : Number(v) });
      },
    },
    option('free', tr('自由'), choice === 'free'),
    WIDTH_CHOICES.map((w) => option(String(w), `${w}`, choice === String(w))),
    option('custom', tr('カスタム…'), choice === 'custom'),
  );
  const custom =
    choice === 'custom'
      ? h('input', {
          type: 'number',
          class: 'cv-num',
          min: '640',
          max: '7680',
          step: '1',
          value: String(p.width),
          'aria-label': tr('画面の幅（px）'),
          dataset: { fk: 'customWidth' },
          onchange: (e: Event) => {
            const n = Math.round(Number((e.target as HTMLInputElement).value));
            if (!Number.isFinite(n) || n < 640 || n > 7680) {
              (e.target as HTMLInputElement).value = String(p.width);
              notify(tr('画面の幅は 640〜7680 の数で入れてください'), 'warning');
              return;
            }
            applyPreview({ width: n, customWidth: n });
          },
        })
      : null;
  const scaleSel = h(
    'select',
    {
      class: 'cv-select',
      'aria-label': tr('Windows の拡大率'),
      title: p.width === null ? tr('先に「画面の幅」を選んでください') : tr('Windows の設定の「拡大/縮小」'),
      disabled: p.width === null,
      dataset: { fk: 'scale' },
      onchange: (e: Event) => applyPreview({ scale: Number((e.target as HTMLSelectElement).value) }),
    },
    SCALE_CHOICES.map((s) => option(String(s), `${s}%`, p.scale === s)),
  );
  // short は見出しが狭いときに出す短い名前（CSS のコンテナークエリで切り替える。読み上げは aria-label の長い名前）
  const fitSeg = (m: 'fit' | 'actual', label: string, title: string, short?: string) =>
    h('button', {
      type: 'button',
      class: p.fit === m ? 'active' : '',
      'aria-pressed': String(p.fit === m),
      'aria-label': short ? label : undefined,
      disabled: p.width === null,
      title,
      dataset: { fk: `fit-${m}` },
      onclick: () => applyPreview({ fit: m }),
    }, short ? [h('span', { class: 'cv-long' }, label), h('span', { class: 'cv-short', 'aria-hidden': 'true' }, short)] : label);
  // 見出しが狭いときは「画面の幅」「拡大率」の文字を隠す（CSS のコンテナークエリ）。選択肢の aria-label と title は残す
  return h(
    'div',
    { class: 'cv-width' },
    h('label', { class: 'cv-field' }, h('span', { class: 'cv-field-label' }, tr('画面の幅')), widthSel),
    custom,
    h('label', { class: 'cv-field' }, h('span', { class: 'cv-field-label' }, tr('拡大率')), scaleSel),
    h('div', { class: 'segmented cv-fit', role: 'group', 'aria-label': tr('表示のしかた') },
      fitSeg('fit', tr('全体を表示'), tr('枠に収まるように縮小して表示します'), tr('全体')),
      fitSeg('actual', tr('実寸'), tr('実物と同じ大きさで表示し、横にスクロールします'))),
  );
}

/**
 * 見出しの状態の文字（Excel から見た幅・縮小率・畳まれる／収まらないグループの数）。
 * 入りきらなければ「…」で切り、全文はツールチップで出す（見出しを 1 行に保つため）。
 * 縮小率の部分は描き直さずに updateZoom が書き換える。
 */
function renderStatus(fit: ViewFit | null): HTMLElement[] {
  const parts: string[] = [];
  const details: string[] = [];
  let warn = false;
  if (fit?.builtin) {
    parts.push(tr('組み込みグループの幅は再現していません'));
    details.push(tr('組み込みグループの幅は再現していません。「表示」の［Excel をプレビューの幅にする］で、実物の Excel で確かめてください'));
  } else if (fit && (fit.clipped.length || fit.collapsed.length)) {
    if (fit.clipped.length) {
      warn = true;
      parts.push(tr('右の {n} グループが収まりません', { n: fit.clipped.length }));
      details.push(`${tr('収まらない')}: ${fit.clipped.join('、')}`);
    }
    if (fit.collapsed.length) {
      parts.push(tr('{n} グループが畳まれます', { n: fit.collapsed.length }));
      details.push(`${tr('畳まれる')}: ${fit.collapsed.join('、')}`);
    }
    details.push(tr('目安（実機の Excel と異なる場合があります）'));
  }
  const status = h(
    'span',
    { class: `cv-status${warn ? ' warning' : ''}`, 'aria-live': 'polite', dataset: { detail: details.join('\n') } },
    h('span', { class: 'cv-zoominfo' }),
    parts.length ? h('span', { class: 'cv-fitinfo' }, parts.join('・') + tr('（目安）')) : null,
  );
  // 縮小が 50% を下回ったときだけ出す小さなリンク。畳むのは外枠（shell）の仕事なので、知らせるだけにする
  const low = h('button', {
    type: 'button',
    class: 'cv-link cv-lowzoom',
    hidden: true,
    title: tr('80% より小さく縮めて表示しています。左右のペインを一時的に畳むと大きく表示できます（［実寸］で実物の大きさにもできます）'),
    onclick: () => window.dispatchEvent(new CustomEvent('sash:collapseSidePanes')),
  }, tr('ペインを畳む'));
  return [status, low];
}

/** 見出しのメニューを閉じ、「表示」ボタンにフォーカスを戻す。開いていなければ何もしない（false）。 */
function closeHeaderMenu(): boolean {
  if (!headerMenu) return false;
  headerMenu = null;
  dynamicFocus = null;
  rerender();
  hostEl?.querySelector<HTMLElement>('.cv-viewbtn')?.focus({ preventScroll: true });
  return true;
}

/** 見出しの「表示 ▾」と、そこから開くメニュー（表示・VBA で変わる表示を試す・チェックする画面の幅）。 */
function renderViewMenu(): HTMLElement {
  const dynCount = overrideCount();
  const open = headerMenu !== null;
  const button = h('button', {
    type: 'button',
    class: `small cv-viewbtn${open ? ' active' : ''}${dynCount || preview().compare || preview().keytips ? ' has-on' : ''}`,
    'aria-haspopup': 'true',
    'aria-expanded': String(open),
    title: tr('2つの幅を比べる・キーヒント・VBA で変わる表示を試す・チェックする画面の幅・Excel をプレビューの幅にする'),
    dataset: { menuButton: '1', fk: 'menu-view' },
    onclick: () => {
      headerMenu = open ? null : 'view';
      dynamicFocus = null;
      rerender();
    },
  }, tr('表示'), h('span', { class: 'rb-arrow', 'aria-hidden': 'true' }));
  const pop = headerMenu === 'view' ? renderViewMenuItems() : headerMenu === 'dynamic' ? renderDynamicMenu() : headerMenu === 'checks' ? renderChecksMenu() : null;
  return h('span', { class: 'cv-menu-wrap cv-viewmenu' }, button, pop);
}

function renderViewMenuItems(): HTMLElement {
  const p = preview();
  const dynCount = overrideCount();
  const check = (on: boolean, label: string, title: string, fk: string, patch: Partial<PreviewSettings>, disabled = false) =>
    h('label', { class: `cv-check cv-mi${disabled ? ' disabled' : ''}`, title },
      h('input', { type: 'checkbox', checked: on, disabled, dataset: { fk }, onchange: () => applyPreview(patch) }),
      label);
  const item = (label: string, fk: string, onclick: () => void, opts: { reason?: string; title?: string } = {}) =>
    h('button', {
      type: 'button',
      class: 'cv-mi',
      disabled: !!opts.reason,
      title: opts.reason || opts.title || '',
      dataset: { fk },
      onclick,
    }, h('span', null, label), opts.reason ? h('span', { class: 'cv-mi-reason' }, opts.reason) : null);
  const excelReason = excelWidthDisabledReason();
  return h(
    'div',
    { class: 'cv-pop cv-viewpop', role: 'menu', 'aria-label': tr('表示') },
    check(p.compare, tr('2つの幅を比べる'), tr('下に、別の幅で描いたリボンを並べます（編集はできません）'), 'compare', { compare: !p.compare }),
    check(p.keytips, tr('キーヒントを表示'), tr('Alt キーを押したときに出る文字を重ねて表示します'), 'keytips', { keytips: !p.keytips }),
    check(p.keytipsAll, tr('未設定も表示'), tr('keytip を書いていないコントロールにも「自動」（Excel が自動で割り当てます）を出します'), 'keytipsAll', { keytipsAll: !p.keytipsAll }, !p.keytips),
    h('div', { class: 'cv-mi-sep' }),
    item(dynCount ? tr('VBA で変わる表示を試す…（{n}）', { n: dynCount }) : tr('VBA で変わる表示を試す…'), 'menu-dynamic', () => {
      headerMenu = 'dynamic';
      rerender();
    }, { title: tr('getVisible・getEnabled・getLabel の結果を仮に決めて、見え方を試します（保存されません）') }),
    item(tr('チェックする画面の幅…'), 'menu-checks', () => {
      headerMenu = 'checks';
      rerender();
    }, { title: tr('問題の一覧で、グループが畳まれないかを確かめる画面の幅') }),
    h('div', { class: 'cv-mi-sep' }),
    item(tr('Excel をプレビューの幅にする'), 'excelWidth', () => {
      headerMenu = null;
      rerender();
      void fitExcelToPreview();
    }, { reason: excelReason, title: tr('Excel のウィンドウをこの幅にして、実物のリボンで確かめます') }),
  );
}

function inRibbon(el: Element): boolean {
  for (let cur: Element | null = el.parentElement; cur; cur = cur.parentElement) if (cur.localName === 'ribbon') return true;
  return false;
}

/** 「動的な状態を試す」：getVisible・getEnabled・getLabel の結果を仮に決める。保存しない。 */
function renderDynamicMenu(): HTMLElement {
  const store = app.store;
  const els = store ? allElements(store.doc).filter((el) => inRibbon(el) && (el.hasAttribute('getVisible') || el.hasAttribute('getEnabled') || el.hasAttribute('getLabel'))) : [];
  const rows = els.map((el) => {
    const path = pathOf(el);
    const key = overrideKey(el, path);
    const o = getOverride(key) ?? {};
    const check = (attr: 'getVisible' | 'getEnabled', prop: 'visible' | 'enabled', label: string) =>
      el.hasAttribute(attr)
        ? h('label', { class: 'cv-check', title: `${attr}="${el.getAttribute(attr) ?? ''}"` },
            h('input', {
              type: 'checkbox',
              checked: o[prop] ?? true,
              dataset: { fk: `dyn-${prop}-${key}` },
              onchange: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                setOverride(key, { [prop]: on ? undefined : false });
                rerender();
              },
            }),
            label)
        : null;
    return h(
      'div',
      { class: `cv-dyn-row${dynamicFocus === path.join('.') ? ' focus' : ''}`, dataset: { dynPath: path.join('.') } },
      h('span', { class: 'cv-dyn-name', title: key }, `<${el.localName}> ${labelOf(el) || key}`),
      check('getVisible', 'visible', tr('表示する')),
      check('getEnabled', 'enabled', tr('有効')),
      el.hasAttribute('getLabel')
        ? h('input', {
            type: 'text',
            class: 'cv-dyn-label',
            value: o.label ?? '',
            placeholder: tr('ラベルの例'),
            'aria-label': tr('{name} のラベルの例', { name: el.getAttribute('getLabel') ?? '' }),
            dataset: { fk: `dyn-label-${key}` },
            onchange: (e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              setOverride(key, { label: v === '' ? undefined : v });
              rerender();
            },
          })
        : null,
    );
  });
  return h(
    'div',
    { class: 'cv-pop cv-dyn', role: 'dialog', 'aria-label': tr('VBA で変わる表示を試す') },
    h('div', { class: 'cv-pop-title' }, tr('VBA で変わる表示を試す')),
    rows.length ? rows : h('div', { class: 'muted' }, tr('getVisible・getEnabled・getLabel を使うコントロールはありません')),
    h('div', { class: 'cv-pop-foot' },
      h('span', { class: 'muted' }, tr('保存されません。見え方を試すためのものです')),
      overrideCount() ? h('button', { type: 'button', class: 'small', onclick: () => { clearOverrides(); rerender(); } }, tr('すべて元に戻す')) : null),
  );
}

/** 問題の一覧で確かめる画面の幅。 */
function renderChecksMenu(): HTMLElement {
  const current = getCheckWidths();
  const choices = [...new Set([...WIDTH_CHOICES, 1440, 1600, ...current])].sort((a, b) => a - b);
  return h(
    'div',
    { class: 'cv-pop cv-checks', role: 'dialog', 'aria-label': tr('チェックする画面の幅') },
    h('div', { class: 'cv-pop-title' }, tr('チェックする画面の幅')),
    h('div', { class: 'muted' }, tr('この幅でグループが畳まれる・収まらないときに、問題の一覧に出します（拡大率は「拡大率」で選んだもの）')),
    choices.map((w) =>
      h('label', { class: 'cv-check' },
        h('input', {
          type: 'checkbox',
          checked: current.includes(w),
          dataset: { fk: `check-${w}` },
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            const next = on ? [...current, w] : current.filter((x) => x !== w);
            if (next.length === 0) {
              (e.target as HTMLInputElement).checked = true;
              notify(tr('少なくとも 1 つの幅を選んでください'), 'warning');
              return;
            }
            setCheckWidths(next);
          },
        }),
        `${w}`)),
  );
}

function renderCanvas(host: HTMLElement): void {
  if (renaming) return;
  const store = app.store;
  if (!store) {
    host.replaceChildren();
    announceSelection();
    return;
  }
  const doc = store.doc;
  const errorPaths = new Set(app.problems.filter((p) => p.severity === 'error').map((p) => p.path.join('.')));
  // 幅を測って見積もる。表示がリボンでなくても、問題の一覧のために毎回行う（変わらないグループは控えを使う）
  const measured = measureAndReport(host, doc);
  let stage: HTMLElement;
  let fit: ViewFit | null = null;
  if (mode === 'backstage') {
    stage = h('div', { class: 'cv-stage' }, renderBackstage(doc, errorPaths));
  } else if (mode === 'contextMenu') {
    stage = h('div', { class: 'cv-stage' }, renderContextMenus(doc, errorPaths));
  } else {
    const r = renderRibbonViews(host, doc, errorPaths, measured);
    stage = h('div', { class: 'cv-stage' }, r.node);
    fit = r.fit;
  }
  // 描き直すとポップアップも作り直されるので、開いていたメニューごとのスクロール位置を覚えておいて戻す
  const popupScroll = new Map<string, number>();
  for (const popup of Array.from(host.querySelectorAll<HTMLElement>('.rb-menu-popup'))) {
    popupScroll.set(popupKey(popup), popup.scrollTop);
  }
  // 見出しの切り替えを操作した直後に描き直しても、フォーカスがその欄に残るようにする
  const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('[data-fk]')?.dataset['fk'] : undefined;
  // タブの欄の横スクロールは、描き直しても戻す（戻さないと、タブが多いときに押すたびに先頭へ戻ってしまう）
  const tabScroll = resetTabScroll ? 0 : editableTabStrip(host)?.scrollLeft ?? 0;
  resetTabScroll = false;
  host.replaceChildren(renderHeader(fit), stage, h('div', { class: 'drop-indicator', hidden: true }));
  markSecondary(host);
  announceSelection();
  if (active) Array.from(host.querySelectorAll<HTMLElement>('[data-fk]')).find((n) => n.dataset['fk'] === active)?.focus({ preventScroll: true });

  updateZoom(host);
  syncCompareGrow(host);
  const strip = editableTabStrip(host);
  if (strip) {
    strip.scrollLeft = tabScroll;
    // 表示するタブが変わったときだけ、そのタブを欄の中で見える位置へ送る（毎回送ると、利用者が送った位置から引き戻すため）
    const key = strip.querySelector<HTMLElement>('.rb-tab.active')?.dataset['path'] ?? strip.querySelector<HTMLElement>('.rb-tab.active')?.title ?? null;
    if (key !== lastActiveTabKey) revealTab(strip);
    lastActiveTabKey = key;
  }
  placePopups(host);
  const selKey = store.selection ? store.selection.join('.') : null;
  for (const popup of Array.from(host.querySelectorAll<HTMLElement>('.rb-menu-popup'))) {
    const saved = popupScroll.get(popupKey(popup));
    if (saved !== undefined) popup.scrollTop = saved;
    // 新しく開いたときと選択が変わったときだけ、選ばれた項目を見える位置へ送る。
    // 毎回送ると、別の理由（問題一覧の更新など）で描き直すたびに、利用者が送った位置から引き戻してしまう
    if (saved === undefined || selKey !== lastPopupSelection) {
      const item = popup.querySelector<HTMLElement>('.rb-menu-item.selected');
      if (item) revealInPopup(popup, item);
    }
  }
  lastPopupSelection = selKey;
  known = new WeakSet(allElements(doc));
  const sel = store.selection;
  if (sel && (flashPath || scrollToSelection)) {
    const node = nodeOf(host, sel);
    if (node) {
      revealNode(node);
      if (flashPath && samePath(flashPath, sel)) {
        node.classList.add('flash');
        window.setTimeout(() => node.classList.remove('flash'), 900);
      }
    }
  }
  flashPath = null;
  scrollToSelection = false;
}

/** 直前の描画で表示していたタブ（タブの欄を送るかどうかを決める）。 */
let lastActiveTabKey: string | null = null;
/** 次の描画でタブの欄の位置を先頭に戻す（ファイルを開き直したとき）。 */
let resetTabScroll = false;

/** 編集する枠のタブの欄（「2つの幅を比べる」の比べる側ではないもの）。 */
function editableTabStrip(host: HTMLElement): HTMLElement | null {
  return Array.from(host.querySelectorAll<HTMLElement>('.rb-tabs-scroll')).find((x) => !x.closest('.cv-compare')) ?? null;
}

/**
 * 表示中のタブを、タブの欄の中だけで見える位置に送る（scrollIntoView はキャンバスの枠まで動かすため使わない）。
 * 矩形は縮小後、scrollLeft は縮小前の値なので、縮小率でそろえる（zoomOf を参照）。
 */
function revealTab(strip: HTMLElement): void {
  const tab = strip.querySelector<HTMLElement>('.rb-tab.active');
  if (!tab) return;
  const z = zoomOf(strip);
  const sr = strip.getBoundingClientRect();
  const tr = tab.getBoundingClientRect();
  if (tr.left < sr.left) strip.scrollLeft -= (sr.left - tr.left) / z + 8;
  else if (tr.right > sr.right) strip.scrollLeft += (tr.right - sr.right) / z + 8;
}

// ---- 幅の測定と見積もり ----

type GroupWidths = FitGroupInput['widths'];

function isTrue(v: string | null): boolean {
  return v === 'true' || v === '1';
}

/** 試し表示（動的な状態を試す）で隠したもの。 */
function hiddenInPreview(el: Element): boolean {
  return getOverride(overrideKey(el, pathOf(el)))?.visible === false;
}

/** 見積もりに入れないグループ（Excel では表示されないもの）。 */
function excludedFromFit(g: Element): boolean {
  return g.getAttribute('visible') === 'false' || hiddenInPreview(g);
}

function groupsOf(tab: Element): Element[] {
  return childElements(tab).filter((g) => g.localName === 'group');
}

function hasGroupIcon(g: Element): boolean {
  return g.hasAttribute('image') || g.hasAttribute('imageMso') || g.hasAttribute('getImage');
}

/**
 * 自作のタブのグループを、状態ごと（large・small・ラベルなし・畳んだ形）に描いて幅を測り、
 * 確かめる幅とプレビューの幅で畳まれる・はみ出すグループを getFitReport に渡す。
 * 測るための要素は、測ったらすぐ外す（data-path が二重になって選択の検索を乱さないように）。
 * 縮小表示（zoom）の外で測るので、幅はそのまま CSS px になる。
 */
function measureAndReport(host: HTMLElement, doc: Document): Map<Element, GroupWidths> {
  const out = new Map<Element, GroupWidths>();
  // 描かれていない（枠が非表示・テストの環境）ときは測れない。前の見積もりを残す
  if (!host.isConnected || host.getClientRects().length === 0) return out;
  const tabs = collectTabs(doc).filter((x) => x.el !== null && !x.builtin);
  const all = tabs.flatMap((x) => groupsOf(x.el!));
  const serializer = new XMLSerializer();
  // 表示名（Excel から届く idMso の名前）の数も鍵に混ぜる。届く前と後で同じ控えを使わないため（onLabelsLoaded でも捨てる）
  const sig = `${lang}|${labels.size}|${overridesSignature()}`;
  const keys = new Map<Element, string>();
  const need: Element[] = [];
  for (const g of all) {
    const key = `${serializer.serializeToString(g)}|${sig}`;
    keys.set(g, key);
    const cached = widthCache.get(key);
    if (cached) out.set(g, cached);
    else need.push(g);
  }
  if (need.length) {
    // 控えが増えすぎないよう、ときどき捨てる
    if (widthCache.size > 2000) widthCache.clear();
    const none = new Set<string>();
    const box = h('div', { class: 'rb-measure', 'aria-hidden': 'true' });
    const nodes: [Element, Partial<Record<GroupFitState, HTMLElement>>][] = [];
    measuring = true;
    try {
      for (const g of need) {
        const auto = isTrue(g.getAttribute('autoScale'));
        const n: Partial<Record<GroupFitState, HTMLElement>> = { large: renderGroup(g, none), collapsed: renderCollapsedGroup(g, none) };
        if (auto) {
          n.small = renderGroup(g, none, 'small');
          n.nolabel = renderGroup(g, none, 'nolabel');
        }
        for (const node of Object.values(n)) box.append(h('div', { class: 'rb-measure-row' }, node));
        nodes.push([g, n]);
      }
      host.append(box);
      for (const [g, n] of nodes) {
        const w = (s: GroupFitState) => (n[s] ? Math.ceil(n[s].getBoundingClientRect().width) : undefined);
        const large = w('large') ?? 0;
        const small = w('small') ?? large;
        const widths: GroupWidths = { large, small, nolabel: w('nolabel') ?? small, collapsed: w('collapsed') ?? large };
        widthCache.set(keys.get(g)!, widths);
        out.set(g, widths);
      }
    } finally {
      box.remove();
      measuring = false;
    }
  }

  const p = preview();
  const widths = [...new Set([...getCheckWidths(), ...(p.width !== null ? [p.width] : [])])].sort((a, b) => b - a);
  const entries = new Map<string, FitReportEntry>();
  for (const tab of tabs) {
    const gs = groupsOf(tab.el!).filter((g) => !excludedFromFit(g) && out.has(g));
    const inputs = gs.map((g) => ({ id: pathOf(g).join('.'), widths: out.get(g)!, autoScale: isTrue(g.getAttribute('autoScale')) }));
    for (const w of widths) {
      const res = simulateFit(inputs, availableForGroups(effectiveWidth(w, p.scale)));
      res.groups.forEach((r, i) => {
        if (r.state !== 'collapsed' && !r.clipped) return;
        const g = gs[i]!;
        const e = entries.get(r.id) ?? { path: pathOf(g), id: g.getAttribute('id'), label: labelOf(g), tab: tab.label, noIcon: !hasGroupIcon(g) };
        if (r.state === 'collapsed') e.collapsedAt = Math.max(e.collapsedAt ?? 0, w);
        if (r.clipped) e.clippedAt = Math.max(e.clippedAt ?? 0, w);
        entries.set(r.id, e);
      });
    }
  }
  setFitReport({ width: p.width, scale: p.scale, effective: p.width !== null ? effectiveWidth(p.width, p.scale) : null, checkedWidths: widths, overflowing: [...entries.values()] });
  return out;
}

// ---- 「2つの幅を比べる」のときにキャンバスの高さを広げる（C-4） ----

let growHandler: ((px: number) => () => void) | null = null;
let growRelease: (() => void) | null = null;
/** 広げたときの、比べる枠の下端までに要る高さと、そのあとのキャンバスの枠の高さ。大きく変わったときだけ広げ直すために覚える。 */
let grownNeeded = 0;
let grownClient = 0;

/**
 * 比べるモードのとき、足りない高さだけキャンバスの高さを一時的に広げる処理を登録する（main.ts が layout.growTemporarily('top', px) を渡す）。
 * px は「足りない分」（比べる枠の下端までに要る高さ − いまのキャンバスの高さ）。渡した関数は、元に戻す関数を返す。
 * 大きさは保存しない。canvas.ts が layout に依存しないよう、注入にしている。
 */
export function setCanvasGrowHandler(fn: ((px: number) => () => void) | null): void {
  growHandler = fn;
}

/**
 * 比べる枠があれば、足りない高さだけ広げ、なくなったら戻す。
 * 比べる枠の全高を足すと、もともと余裕があるときも広げすぎて、下の XML エディタが潰れる（1366×768 で高さ 0 になった）ため、
 * 広げる前のキャンバスの高さを測り、枠の下端までに足りない分だけを求める。
 * 枠の高さやキャンバスの高さが変わったときだけ測り直す（描き直しのたびに動かさないため）。
 */
function syncCompareGrow(host: HTMLElement): void {
  const compare = mode === 'ribbon' && preview().compare ? host.querySelector<HTMLElement>('.cv-compare') : null;
  if (!compare) {
    growRelease?.();
    growRelease = null;
    grownNeeded = 0;
    grownClient = 0;
    return;
  }
  const pane = paneOf(host);
  // 枠の下端までの高さ（スクロールを含む、キャンバスの枠の上端から）。下に少し余白を足す
  const needed = Math.ceil(compare.getBoundingClientRect().bottom - pane.getBoundingClientRect().top + pane.scrollTop) + 12;
  if (growRelease && Math.abs(needed - grownNeeded) < 8 && Math.abs(pane.clientHeight - grownClient) < 8) return;
  // いったん戻して、広げる前の高さを測る
  growRelease?.();
  growRelease = null;
  const missing = needed - pane.clientHeight;
  if (missing > 0 && growHandler) growRelease = growHandler(missing);
  grownNeeded = needed;
  grownClient = pane.clientHeight;
}

/** 編集する枠と、「2つの幅を比べる」ときの比べる側の枠。 */
function renderRibbonViews(host: HTMLElement, doc: Document, errorPaths: Set<string>, measured: Map<Element, GroupWidths>): { node: HTMLElement; fit: ViewFit } {
  const p = preview();
  const primary = renderView(host, doc, errorPaths, measured, { effective: p.width !== null ? effectiveWidth(p.width, p.scale) : null, readOnly: false });
  if (!p.compare) return primary;
  readOnlyRender = true;
  let other: { node: HTMLElement; fit: ViewFit };
  try {
    other = renderView(host, doc, errorPaths, measured, { effective: effectiveWidth(p.compareWidth, p.scale), readOnly: true });
  } finally {
    readOnlyRender = false;
  }
  makeReadOnly(other.node);
  const choices = [...new Set([...WIDTH_CHOICES, p.compareWidth])].sort((a, b) => a - b);
  const caption = h(
    'div',
    { class: 'cv-compare-caption' },
    h('label', { class: 'cv-field' }, h('span', null, tr('比べる幅')),
      h('select', {
        class: 'cv-select',
        dataset: { fk: 'compareWidth' },
        onchange: (e: Event) => {
          setPreview({ compareWidth: Number((e.target as HTMLSelectElement).value) });
          rerender();
        },
      }, choices.map((w) => option(String(w), String(w), w === p.compareWidth)))),
    h('span', { class: 'muted' }, tr('Excel から見た幅 {w}px・表示だけ（編集はできません）', { w: effectiveWidth(p.compareWidth, p.scale) })),
    other.fit.clipped.length ? h('span', { class: 'cv-msg warning' }, tr('この幅では右の {n} グループが収まりません', { n: other.fit.clipped.length })) : null,
    other.fit.collapsed.length ? h('span', { class: 'cv-msg info' }, tr('この幅では {n} グループが畳まれます', { n: other.fit.collapsed.length })) : null,
  );
  return { node: h('div', { class: 'cv-views' }, primary.node, h('div', { class: 'cv-compare' }, caption, other.node)), fit: primary.fit };
}

/** 比べる側の枠を、選べない・運べない・フォーカスが入らない形にする（同じ data-path が二つあると選択の検索を乱すため）。 */
function makeReadOnly(root: HTMLElement): void {
  root.setAttribute('inert', '');
  for (const n of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
    delete n.dataset['path'];
    delete n.dataset['sel'];
    delete n.dataset['container'];
    delete n.dataset['tip'];
    if (n.draggable) n.draggable = false;
  }
}

/** 1 枠：目盛り・幅を決めた枠（縮小表示）・リボン。「自由」なら枠を作らず、これまでどおり幅いっぱいに描く。 */
function renderView(host: HTMLElement, doc: Document, errorPaths: Set<string>, measured: Map<Element, GroupWidths>, view: RibbonView): { node: HTMLElement; fit: ViewFit } {
  const { ribbon, fit } = renderRibbon(host, doc, errorPaths, measured, view);
  const eff = view.effective;
  if (eff === null) return { node: h('div', { class: 'cv-view free' }, renderRuler(null), ribbon), fit };
  const frame = h(
    'div',
    { class: 'cv-frame', style: `width:${eff}px` },
    ribbon,
    h('div', { class: 'cv-reserved', style: `width:${RIBBON_RESERVED_PX - 10}px`, title: tr('リボンの右端の余白（表示オプションのボタンなど・目安）') }),
  );
  // 縮小は transform ではなく zoom で行う。transform だと、ポップアップ（fixed）の置き場所の基準が
  // 縮小した枠に変わってしまうため。zoom の中の座標の扱いは placePopups と revealInPopup を参照
  const zoom = h('div', { class: 'cv-zoom', dataset: { eff: String(eff) } }, renderRuler(eff), frame);
  return { node: h('div', { class: 'cv-view' }, zoom), fit };
}

/** よく使われる幅の目盛り。リボンの左端（ウィンドウの左端とみなす）から測る。 */
function renderRuler(eff: number | null): HTMLElement {
  const marks = RULER_MARKS.filter((m) => eff === null || m <= eff);
  return h(
    'div',
    { class: `cv-ruler${eff === null ? ' free' : ''}`, style: eff === null ? '' : `width:${eff}px`, 'aria-hidden': 'true' },
    marks.map((m) => h('span', { class: 'cv-mark', style: `left:${m}px`, title: m === 1536 ? tr('1920 を 125% で使ったときの幅') : '' }, m === 1536 ? '1536 (1920@125%)' : String(m))),
    eff !== null && !RULER_MARKS.includes(eff) ? h('span', { class: 'cv-mark end', style: `left:${eff}px` }, String(eff)) : null,
  );
}

/**
 * 「収める」なら枠の幅に合わせて縮小率を決める。描き直さずに済むよう、大きさが変わるたびにここだけを呼ぶ。
 * 縮小率が 50% を下回ったら、等倍にするかペインを畳むかを勧める。
 */
function updateZoom(host: HTMLElement): void {
  const p = preview();
  // 実寸で横にあふれるときも、見出し（切り替え・幅の選択）は左端に貼り付けて流れ去らないようにする（C-2）。
  // 見出しは position:sticky; left:0 で貼り付けるが、貼り付け先（#canvas）が枠の幅のままだと動く余地がないので、
  // 実寸のときだけ #canvas を中身の幅まで広げ、見出しの幅は枠の表示幅（--cv-pane-w）に固定する
  const actual = mode === 'ribbon' && p.width !== null && p.fit === 'actual';
  host.classList.toggle('cv-actual', actual);
  host.style.setProperty('--cv-pane-w', `${paneOf(host).clientWidth}px`);
  const cs = getComputedStyle(host);
  const avail = host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - 1;
  const zooms = Array.from(host.querySelectorAll<HTMLElement>('.cv-zoom'));
  // 2つの幅を比べるときは、幅の違いがそのまま見えるよう、広いほうに合わせた同じ縮小率で描く
  const widest = Math.max(0, ...zooms.map((z) => Number(z.dataset['eff']) || 0));
  const primary: number | null = zooms.length === 0 ? null : p.fit === 'fit' && avail > 0 && widest > 0 ? Math.min(1, avail / widest) : 1;
  for (const z of zooms) z.style.zoom = primary === null || primary === 1 ? '' : String(primary);
  const status = host.querySelector<HTMLElement>('.cv-status');
  const info = status?.querySelector<HTMLElement>('.cv-zoominfo');
  if (status && info) {
    // 70% より小さいときは、文字が読みにくくなっていることを状態の文言で知らせる（C-4）
    const key = primary !== null && primary < LOW_ZOOM_NOTICE ? '{pct}%（文字が小さく表示されます）で表示・Excel から見た幅 {w}px' : '{pct}% で表示・Excel から見た幅 {w}px';
    info.textContent = p.width === null || primary === null ? '' : tr(key, { w: effectiveWidth(p.width, p.scale), pct: Math.round(primary * 100) });
    const fitText = status.querySelector('.cv-fitinfo')?.textContent ?? '';
    if (info.textContent && fitText) info.textContent += '・';
    // 「…」で切れても全文が読めるよう、ツールチップに全部を出す
    status.title = [info.textContent + fitText, status.dataset['detail'] ?? ''].filter((x) => x).join('\n');
  }
  const low = host.querySelector<HTMLElement>('.cv-lowzoom');
  if (low) low.hidden = !(primary !== null && primary < LOW_ZOOM_SUGGEST);
  // 枠の幅や縮小率が変わるたびに、組み込みタブをまとめ直す（C-3）
  foldBuiltinTabs(host);
}

/** マウスを乗せたときのヒントの中身。 */
function tipFor(node: HTMLElement): ScreentipContent | null {
  const path = parsePath(node.dataset['path']);
  const el = path && app.store ? elementAt(app.store.doc, path) : null;
  return el ? screentipContent(el, labelOf(el)) : null;
}

/**
 * キーヒントのバッジ。書いたもの（重なっていれば赤）と getKeytip（「VBA」）だけを出す。
 * 書いていないものの灰色の「自動」は、「表示」の［未設定も表示］のときだけ出す（全部に付くと、書いたものが埋もれるため）。
 */
function keytipBadge(el: Element, dup: boolean): HTMLElement | null {
  if (!preview().keytips || measuring || readOnlyRender) return null;
  const keytip = el.getAttribute('keytip');
  if (keytip) return h('span', { class: `rb-keytip${dup ? ' dup' : ''}`, title: dup ? tr('キーヒントが重なっています') : '' }, keytip);
  if (el.hasAttribute('getKeytip')) return h('span', { class: 'rb-keytip auto', title: tr('VBA で決まります') }, 'VBA');
  if (!preview().keytipsAll) return null;
  return h('span', { class: 'rb-keytip auto', title: tr('Excel が自動で割り当てます') }, tr('自動'));
}

/** 表示中のタブで、キーヒントが重なっているコントロール。メニューの中身は開いたときの別の範囲なので数えない。 */
let keytipDups = new Set<Element>();

function computeKeytipDups(tab: Element | null): Set<Element> {
  if (!tab || !preview().keytips) return new Set();
  const list: Element[] = [];
  const walk = (parent: Element) => {
    for (const c of childElements(parent)) {
      if (c.hasAttribute('keytip')) list.push(c);
      if (c.localName === 'group' || c.localName === 'box' || c.localName === 'buttonGroup') walk(c);
    }
  };
  walk(tab);
  const keys = duplicateKeytips(list.map((el, i) => ({ key: String(i), keytip: el.getAttribute('keytip') ?? '' })));
  return new Set(list.filter((_el, i) => keys.has(String(i))));
}

function renderRibbon(host: HTMLElement, doc: Document, errorPaths: Set<string>, measured: Map<Element, GroupWidths>, view: RibbonView): { ribbon: HTMLElement; fit: ViewFit } {
  const store = app.store!;
  const tabs = collectTabs(doc).filter((x) => !(x.el && !x.builtin && hiddenInPreview(x.el)));
  const active = resolveActive(tabs);
  const hasCustom = tabs.some((x) => !x.builtin);
  const showKeytips = preview().keytips && !view.readOnly;
  keytipDups = computeKeytipDups(active?.el ?? null);

  // タブのキーヒント：組み込みのタブ（ファイルは F）と自分のタブの重なりを見る
  const tabTip = (x: TabEntry) => (x.el?.getAttribute('keytip') ?? (x.builtin && x.idMso ? BUILTIN_TAB_KEYTIPS[x.idMso] ?? '' : ''));
  const tabDups = showKeytips ? duplicateKeytips([{ key: 'file', keytip: 'F' }, ...tabs.map((x) => ({ key: x.key, keytip: tabTip(x) }))]) : new Set<string>();
  const tabBadge = (x: TabEntry | null) => {
    if (!showKeytips) return null;
    if (!x) return h('span', { class: `rb-keytip${tabDups.has('file') ? ' dup' : ''}` }, 'F');
    if (x.el && !x.builtin) return keytipBadge(x.el, tabDups.has(x.key));
    const tip = tabTip(x);
    return tip ? h('span', { class: `rb-keytip builtin${tabDups.has(x.key) ? ' dup' : ''}`, title: tr('組み込みのタブ（目安）') }, tip) : null;
  };

  const tabBar = h(
    'div',
    { class: 'rb-tabs', role: 'tablist' },
    // タブが多くて横にあふれても「＋」が隠れないよう、タブだけを横スクロールの欄に入れ、「＋」はその外の右端に置く
    h(
      'div',
      { class: 'rb-tabs-scroll' },
      h('span', {
        class: 'rb-tab file',
        role: 'tab',
        title: tr('Backstage（ファイル タブ）を表示'),
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          if (store.version !== 'office2007') setCanvasMode('backstage');
        },
      }, tr('ファイル'), tabBadge(null)),
      tabs.map((x) =>
        h(
          'span',
          {
            class: ['rb-tab', x.builtin && !x.el ? 'builtin' : '', x === active ? 'active' : '', x.el && isSelected(x.el) ? 'selected' : ''].join(' '),
            role: 'tab',
            'aria-selected': String(x === active),
            // data-fold は、幅が足りないときに「…」へまとめてよい組み込みタブの印（foldBuiltinTabs）。
            // 自作タブ・手を加えた組み込みタブ・ホーム・表示中のタブは、まとめない
            dataset: x.el
              ? { path: pathOf(x.el).join('.'), sel: '1' }
              : x.builtin && x.idMso && x.idMso !== 'TabHome' && x !== active ? { fold: '1', idmso: x.idMso } : {},
            draggable: x.el !== null && !x.builtin,
            title: x.el?.getAttribute('id') ?? x.idMso ?? '',
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              activeTab = x.el && !x.builtin ? { kind: 'el', id: x.el.getAttribute('id'), path: pathOf(x.el) } : { kind: 'builtin', idMso: x.idMso! };
              if (x.el) store.select(pathOf(x.el), 'canvas');
              else renderCanvas(host);
            },
            ondragstart: (e: DragEvent) => x.el && startDrag(e, { kind: 'move', path: pathOf(x.el) }),
            ondragend: () => {
              endDrag();
              hideIndicator(host);
            },
          },
          h('span', { class: 'rb-label' }, x.label || tr('(ラベルなし)')),
          tabBadge(x),
        ),
      ),
    ),
    // 幅が足りないときにまとめた組み込みタブの入り口（普段は隠す。出すかどうかは foldBuiltinTabs が測って決める）
    h('button', {
      type: 'button',
      class: 'rb-tab-more',
      hidden: true,
      'aria-haspopup': 'menu',
      'aria-label': tr('ほかの組み込みタブ'),
      title: tr('ほかの組み込みタブ'),
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        openFoldedTabsMenu(host, e.currentTarget as HTMLElement);
      },
    }, '…'),
    h('button', {
      type: 'button',
      class: `rb-tab-add${hasCustom ? '' : ' empty'}`,
      title: tr('新しいタブを追加'),
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        addTab();
      },
    }, hasCustom ? '+' : tr('＋ ここにタブを追加')),
  );

  const fit: ViewFit = { builtin: active?.builtin === true, collapsed: [], clipped: [] };
  const body = h('div', { class: 'rb-body' });
  if (active) {
    // 組み込みタブ：組み込みグループのプレースホルダーと、足したグループを並べる
    const groups = active.el ? groupsOf(active.el).filter((g) => !hiddenInPreview(g)) : [];
    // 幅を決めているときは、Excel のように右のグループから縮める・畳む（自作のタブだけ。組み込みのグループの幅は分からないため）
    const states = new Map<Element, FitGroupResult & { expanded: boolean }>();
    if (view.effective !== null && !active.builtin) {
      const gs = groups.filter((g) => !excludedFromFit(g));
      if (gs.every((g) => measured.has(g))) {
        const res = simulateFit(gs.map((g) => ({ id: pathOf(g).join('.'), widths: measured.get(g)!, autoScale: isTrue(g.getAttribute('autoScale')) })), availableForGroups(view.effective));
        let left = 0;
        const avail = availableForGroups(view.effective);
        res.groups.forEach((r, i) => {
          const g = gs[i]!;
          // 一時的に広げたグループは、書いたとおりの大きさで描き、その分だけ右がはみ出す
          const expanded = !view.readOnly && r.state === 'collapsed' && tempExpanded.has(r.id);
          const width = expanded ? measured.get(g)!.large : r.width;
          const clipped = left + width > avail;
          left += width;
          states.set(g, { ...r, width, clipped, expanded });
          if (r.state === 'collapsed') fit.collapsed.push(labelOf(g) || (g.getAttribute('id') ?? ''));
          if (clipped) fit.clipped.push(labelOf(g) || (g.getAttribute('id') ?? ''));
        });
      }
    }
    const renderOne = (g: Element) => {
      const st = states.get(g);
      if (!st) return renderGroup(g, errorPaths);
      if (st.state === 'collapsed' && !st.expanded) return renderCollapsedGroup(g, errorPaths, st.clipped);
      return renderGroup(g, errorPaths, st.expanded || st.state === 'collapsed' ? 'large' : st.state, { clipped: st.clipped, expanded: st.expanded });
    };
    if (active.builtin) {
      const builtinGroups = catalog.filter((c) => c.type === 'group' && c.tab === active.idMso).slice(0, 8);
      const placed = new Set<Element>();
      for (const bg of builtinGroups) {
        for (const g of groups) if (g.getAttribute('insertBeforeMso') === bg.id && !placed.has(g)) {
          body.append(renderOne(g));
          placed.add(g);
        }
        body.append(h('div', { class: 'rb-group builtin', title: tr('組み込みのグループ（編集できません）') }, h('div', { class: 'rb-controls' }), h('div', { class: 'rb-group-label' }, h('span', null, builtinGroupName(bg.id)))));
        for (const g of groups) if (g.getAttribute('insertAfterMso') === bg.id && !placed.has(g)) {
          body.append(renderOne(g));
          placed.add(g);
        }
      }
      for (const g of groups) if (!placed.has(g)) body.append(renderOne(g));
    } else {
      for (const g of groups) body.append(renderOne(g));
    }
    if (active.el) body.dataset['path'] = pathOf(active.el).join('.');
    if (groups.length === 0 && !active.builtin && active.el) {
      const tabPath = pathOf(active.el);
      body.append(
        h('div', { class: 'cv-empty' },
          h('span', null, tr('ここにグループを追加')),
          h('button', { type: 'button', class: 'small', onclick: (e: MouseEvent) => { e.stopPropagation(); addChild(tabPath, 'group'); } }, tr('グループを追加'))),
      );
    }
  }
  if (!hasCustom) {
    body.append(h('div', { class: 'cv-empty floating' },
      h('span', null, tr('まだ自分のタブがありません。タブを追加するか、組み込みタブにグループを足してください')),
      // 白紙から組むより、よく使う形から始めたほうが早いので、レシピへの入り口も置く
      h('button', { type: 'button', class: 'small', onclick: (e: MouseEvent) => { e.stopPropagation(); void openOnce('recipes', () => openRecipes(notify)); } }, tr('レシピから始める'))));
  }

  const qat = renderQat(doc, errorPaths);
  const ribbon = h('div', {
    class: `rb-window${showKeytips ? ' show-keytips' : ''}`,
    style: `--rb-large-label-max:${LARGE_LABEL_WRAP.maxWidthPx}px;--rb-large-label-lines:${LARGE_LABEL_WRAP.maxLines}`,
  }, qat, tabBar, body);
  return { ribbon, fit };
}

/**
 * 組み込みタブの列が枠より広いとき、選んでいない組み込みタブ（挿入〜ヘルプ）を右から「…」1 個にまとめる（C-3）。
 * 収まらないまま欄がスクロールすると、「ファイル」が「イル」のように途中で切れて見えるため。
 * 自作タブ・「ファイル」・「ホーム」・表示中のタブは必ず見せる。測り直すたびに一度すべて戻してから測る
 * （枠の幅は変わるので、前回の結果は引き継がない）。「2つの幅を比べる」の下の枠にも同じように行う。
 */
function foldBuiltinTabs(host: HTMLElement): void {
  for (const bar of Array.from(host.querySelectorAll<HTMLElement>('.rb-tabs'))) {
    const strip = bar.querySelector<HTMLElement>('.rb-tabs-scroll');
    const more = bar.querySelector<HTMLElement>('.rb-tab-more');
    if (!strip || !more) continue;
    const candidates = Array.from(strip.querySelectorAll<HTMLElement>('.rb-tab[data-fold]'));
    for (const c of candidates) c.classList.remove('folded');
    more.hidden = true;
    const overflow = () => strip.scrollWidth > strip.clientWidth + 1;
    if (candidates.length === 0 || !overflow()) continue;
    // 「…」自身も幅を取るので、先に出してから測る
    more.hidden = false;
    for (const c of candidates.reverse()) {
      if (!overflow()) break;
      c.classList.add('folded');
    }
  }
}

/** 「…」で開く、まとめた組み込みタブの一覧。選ぶとそのタブを表示する。 */
function openFoldedTabsMenu(host: HTMLElement, opener: HTMLElement): void {
  const bar = opener.closest<HTMLElement>('.rb-tabs');
  const folded = Array.from(bar?.querySelectorAll<HTMLElement>('.rb-tab.folded[data-idmso]') ?? []);
  const r = opener.getBoundingClientRect();
  openMenu(r.left, r.bottom, folded.map((n) => ({
    label: n.querySelector('.rb-label')?.textContent ?? n.textContent ?? '',
    run: () => {
      activeTab = { kind: 'builtin', idMso: n.dataset['idmso']! };
      renderCanvas(host);
    },
  })), { restoreFocus: opener });
}

/**
 * 足した要素のラベルを、その場で全選択して書き換えられる状態にする（C-1）。
 * 足したあとは「クリック → F2 → 入力」が要ったため、足した直後にそのまま名前を打てるようにする。
 * Enter で確定、Esc で既定名のまま（どちらも終わるとキャンバスにフォーカスが戻る）。
 * ［＋］・挿入メニュー・右クリックの「前に挿入／子を追加」から呼ぶ。ラベルを持たない要素や VBA で返すラベルでは何もしない（false）。
 */
export function startRenameOf(path: Path | null | undefined): boolean {
  if (!hostEl || !path || !app.store) return false;
  return startRename(hostEl, path);
}

/** 新しいタブを作って選択し、名前をその場で打てる状態にする。 */
function addTab(): void {
  let added: Path | undefined;
  const ok = runEdit('canvas', (doc) => {
    const tabs = ensureTabs(doc);
    const el = createElement(doc, 'tab', tabs);
    tabs.insertBefore(el, tabs.children[allowedIndex(tabs, 'tab', tabs.children.length) ?? tabs.children.length] ?? null);
    added = pathOf(el);
    return added;
  }, tr('タブを追加'));
  if (ok) startRenameOf(added);
}

function addChild(parentPath: Path, tag: string): void {
  let added: Path | undefined;
  const ok = runEdit('canvas', (doc) => {
    const parent = elementAt(doc, parentPath);
    if (!parent) return undefined;
    const at = allowedIndex(parent, tag, parent.children.length);
    if (at === null) return undefined;
    const el = createElement(doc, tag, parent);
    parent.insertBefore(el, parent.children[at] ?? null);
    added = pathOf(el);
    return added;
  }, tr('<{tag}> を追加', { tag }));
  if (ok) startRenameOf(added);
}

/** コンテキストメニュー（右クリックメニュー）に足す項目を、メニューの形で並べる。 */
function renderContextMenus(doc: Document, errorPaths: Set<string>): HTMLElement {
  if (app.store?.version === 'office2007') return h('div', { class: 'cv-empty' }, tr('コンテキストメニューは customUI14（2010以降）の形式でのみ編集できます'));
  const cms = findChild(doc.documentElement, 'contextMenus');
  const menus = cms ? childElements(cms).filter((c) => c.localName === 'contextMenu') : [];
  const sel = app.store?.selection ?? null;
  const item = (c: Element, depth: number): HTMLElement[] => {
    const cp = pathOf(c);
    const row = h(
      'div',
      {
        class: `rb-menu-item${samePath(sel, cp) ? ' selected' : ''}${errorPaths.has(cp.join('.')) ? ' has-error' : ''}${c.getAttribute('visible') === 'false' ? ' hidden-ctl' : ''}`,
        style: `padding-left:${8 + depth * 14}px`,
        dataset: { path: cp.join('.'), sel: '1' },
        draggable: true,
        title: c.getAttribute('id') ?? c.getAttribute('idMso') ?? c.localName,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          app.store?.select(cp, 'canvas');
        },
        ondragstart: (e: DragEvent) => {
          e.stopPropagation();
          startDrag(e, { kind: 'move', path: cp });
        },
        ondragend: () => endDrag(),
      },
      c.localName === 'menuSeparator' ? h('span', { class: 'rb-menu-sep' }, c.getAttribute('title') ?? '') : [c.hasAttribute('image') || c.hasAttribute('imageMso') ? iconFor(c, 'small') : h('span', { class: 'rb-icon-gap' }), h('span', { class: 'rb-label' }, labelOf(c) || c.localName), c.localName === 'menu' || c.localName === 'splitButton' || c.localName === 'dynamicMenu' ? h('span', { class: 'rb-submenu' }, '›') : null],
    );
    const kids = c.localName === 'menu' || c.localName === 'splitButton' ? childElements(c).flatMap((k) => item(k, depth + 1)) : [];
    return [row, ...kids];
  };
  const cards = menus.map((m) => {
    const mp = pathOf(m);
    const idMso = m.getAttribute('idMso') ?? '';
    return h(
      'div',
      {
        class: `ctx-card${samePath(sel, mp) ? ' selected' : ''}${errorPaths.has(mp.join('.')) ? ' has-error' : ''}`,
        dataset: { path: mp.join('.'), sel: '1' },
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          app.store?.select(mp, 'canvas');
        },
      },
      h('div', { class: 'ctx-title', title: idMso }, labels.get(idMso) ?? idMso),
      h('div', { class: 'ctx-builtin' }, tr('（組み込みの項目）')),
      h('div', { class: 'ctx-items', dataset: { container: mp.join('.') } }, m.children.length ? childElements(m).flatMap((c) => item(c, 0)) : h('div', { class: 'rb-menu-item muted' }, tr('ここに項目をドラッグ'))),
    );
  });
  const addButton = h('button', { type: 'button', class: 'small', onclick: (e: MouseEvent) => { e.stopPropagation(); addContextMenu(); } }, tr('コンテキストメニューを追加'));
  if (menus.length === 0) {
    return h('section', { class: 'ctx-section empty', dataset: { ctxNew: '1' } },
      h('h3', null, tr('コンテキストメニュー（右クリック）')),
      h('p', { class: 'muted' }, tr('パレットの「コンテキストメニュー」をここにドラッグすると、右クリックメニューに項目を足せます')),
      addButton);
  }
  return h('section', { class: 'ctx-section', dataset: { container: cms ? pathOf(cms).join('.') : '' } }, h('h3', null, tr('コンテキストメニュー（右クリック）'), addButton), h('div', { class: 'ctx-cards' }, cards));
}

function addContextMenu(): void {
  runEdit('canvas', (doc) => {
    const cms = ensureContextMenus(doc);
    const el = createElement(doc, 'contextMenu', cms);
    cms.append(el);
    return pathOf(el);
  }, tr('コンテキストメニューを追加'));
}

function renderQat(doc: Document, errorPaths: Set<string>): HTMLElement | null {
  const qat = findChild(findChild(doc.documentElement, 'ribbon'), 'qat');
  if (!qat) return null;
  const items = childElements(qat).flatMap((c) => childElements(c));
  return h('div', { class: 'rb-qat', dataset: { path: pathOf(qat).join('.'), sel: '1' }, onclick: (e: MouseEvent) => { e.stopPropagation(); app.store?.select(pathOf(qat), 'canvas'); } }, h('span', { class: 'rb-qat-label' }, tr('クイック アクセス')), items.map((c) => renderControl(c, 'small', errorPaths)));
}

/**
 * グループを描く。state は幅の見積もりで決まった大きさ（small は大きいボタンを小さくして 3 段に積む、
 * nolabel はさらに小さいボタンのラベルを消す。autoScale="true" のグループだけがこうなる）。
 */
function renderGroup(g: Element, errorPaths: Set<string>, state: Exclude<GroupFitState, 'collapsed'> = 'large', opts: { clipped?: boolean; expanded?: boolean } = {}): HTMLElement {
  const path = pathOf(g);
  const builtinRef = g.hasAttribute('idMso');
  const launcher = childElements(g).find((c) => c.localName === 'dialogBoxLauncher');
  const controls = h('div', { class: `rb-controls${isTrue(g.getAttribute('centerVertically')) ? ' center-v' : ''}`, dataset: { container: path.join('.') } });
  const items = childElements(g).filter((c) => c.localName !== 'dialogBoxLauncher');
  layoutControls(items, controls, errorPaths, state !== 'large');
  if (items.length === 0 && !builtinRef) controls.append(h('span', { class: 'rb-empty-slot group' }, tr('ここにコントロールをドラッグ')));

  return h(
    'div',
    {
      class: ['rb-group', builtinRef ? 'builtin-ref' : '', isSelected(g) ? 'selected' : '', errorPaths.has(path.join('.')) ? 'has-error' : '', g.getAttribute('visible') === 'false' ? 'hidden-ctl' : '', state === 'nolabel' ? 'nolabel' : '', opts.clipped ? 'rb-clipped' : '', opts.expanded ? 'temp-expanded' : ''].join(' '),
      dataset: { path: path.join('.'), sel: '1' },
      draggable: true,
      title: opts.clipped ? tr('この幅では収まりません（目安）') : g.getAttribute('id') ?? g.getAttribute('idMso') ?? 'group',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        app.store?.select(path, 'canvas');
      },
      ondblclick: opts.expanded
        ? (e: MouseEvent) => {
            // 一時的に広げたグループは、ダブルクリックで畳み直す
            if ((e.target as HTMLElement).closest('.rb-ctl')) return;
            e.stopPropagation();
            tempExpanded.delete(path.join('.'));
            rerender();
          }
        : undefined,
      ondragstart: (e: DragEvent) => {
        e.stopPropagation();
        startDrag(e, { kind: 'move', path });
      },
      ondragend: () => endDrag(),
    },
    controls,
    h(
      'div',
      { class: 'rb-group-label' },
      h('span', { class: 'rb-label' }, labelOf(g)),
      opts.expanded
        ? h('button', {
            type: 'button',
            class: 'rb-chip',
            title: tr('この幅では畳まれるグループを、編集のために一時的に広げています'),
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              tempExpanded.delete(path.join('.'));
              rerender();
            },
          }, tr('畳む'))
        : null,
      launcher
        ? h('span', {
            class: `rb-launcher${isSelected(launcher) ? ' selected' : ''}`,
            title: tr('ダイアログ起動ツール'),
            dataset: { path: pathOf(launcher).join('.'), sel: '1' },
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              app.store?.select(pathOf(launcher), 'canvas');
            },
          })
        : null,
    ),
  );
}

/**
 * 畳んだグループ：グループのアイコン（なければ汎用のアイコン）とラベルと ▼ の、大きいボタン一つ（Excel と同じ形）。
 * 選ぶと、Excel で押したときと同じように中身をポップアップで開き、そこで編集できる。
 * ダブルクリックか「展開して編集」で、その場に一時的に広げる。
 */
function renderCollapsedGroup(g: Element, errorPaths: Set<string>, clipped = false): HTMLElement {
  const path = pathOf(g);
  const key = path.join('.');
  const sel = app.store?.selection ?? null;
  const open = !measuring && !readOnlyRender && sel !== null && (samePath(sel, path) || isAncestorPath(path, sel));
  const icon = hasGroupIcon(g) ? iconFor(g, 'large') : h('span', { class: 'rb-icon placeholder generic', style: 'width:32px;height:32px', title: tr('畳まれたときのアイコンが未設定です') });
  const expand = () => {
    tempExpanded.add(key);
    rerender();
  };
  let popup: HTMLElement | null = null;
  if (open) {
    const controls = h('div', { class: `rb-controls${isTrue(g.getAttribute('centerVertically')) ? ' center-v' : ''}`, dataset: { container: key } });
    const items = childElements(g).filter((c) => c.localName !== 'dialogBoxLauncher');
    layoutControls(items, controls, errorPaths, false);
    if (items.length === 0) controls.append(h('span', { class: 'rb-empty-slot group' }, tr('ここにコントロールをドラッグ')));
    popup = h(
      'div',
      { class: 'rb-menu-popup rb-group-popup', dataset: { popup: key } },
      controls,
      h('div', { class: 'rb-group-label' }, h('span', { class: 'rb-label' }, labelOf(g)),
        h('button', { type: 'button', class: 'rb-chip', onclick: (e: MouseEvent) => { e.stopPropagation(); expand(); } }, tr('展開して編集'))),
    );
  }
  return h(
    'div',
    {
      class: ['rb-group', 'collapsed', isSelected(g) ? 'selected' : '', errorPaths.has(key) ? 'has-error' : '', g.getAttribute('visible') === 'false' ? 'hidden-ctl' : '', clipped ? 'rb-clipped' : ''].join(' '),
      dataset: { path: key, sel: '1', tip: '1' },
      draggable: true,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        app.store?.select(path, 'canvas');
      },
      ondblclick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.rb-group-popup')) return;
        e.stopPropagation();
        expand();
      },
      ondragstart: (e: DragEvent) => {
        e.stopPropagation();
        startDrag(e, { kind: 'move', path });
      },
      ondragend: () => endDrag(),
    },
    h('div', { class: 'rb-controls' },
      h('div', { class: 'rb-ctl large rb-collapsed-btn' }, icon, h('span', { class: 'rb-label' }, labelOf(g) || tr('(ラベルなし)')), h('span', { class: 'rb-arrow', 'aria-hidden': 'true' }), keytipBadge(g, false))),
    h('div', { class: 'rb-group-label collapsed-label' }, ''),
    popup,
  );
}

type Size = 'large' | 'small';

function isLarge(el: Element): boolean {
  return el.getAttribute('size') === 'large';
}

/** large は1列を占め、それ以外は3段ずつ縦に積む（本物のリボンと同じ並べ方）。 */
function layoutControls(items: Element[], host: HTMLElement, errorPaths: Set<string>, forceSmall = false): void {
  let stack: HTMLElement | null = null;
  for (const c of items) {
    // 「動的な状態を試す」で隠したものは、Excel と同じく場所も取らない
    if (hiddenInPreview(c)) continue;
    if (c.localName === 'separator') {
      stack = null;
      host.append(renderControl(c, 'small', errorPaths));
      continue;
    }
    if (isLarge(c) && !forceSmall) {
      stack = null;
      host.append(renderControl(c, 'large', errorPaths));
      continue;
    }
    if (!stack || stack.children.length >= 3) {
      stack = h('div', { class: 'rb-stack' });
      host.append(stack);
    }
    stack.append(renderControl(c, 'small', errorPaths));
  }
}

function iconFor(el: Element, size: Size): HTMLElement {
  const store = app.store!;
  const px = size === 'large' ? 32 : 16;
  const image = el.getAttribute('image');
  const imageMso = el.getAttribute('imageMso') ?? (el.localName === 'control' ? el.getAttribute('idMso') : null);
  let src: string | null | undefined = null;
  if (image) src = store.images.get(image)?.dataUrl ?? null;
  else if (imageMso) src = msoIcon(imageMso);
  if (src) return h('img', { class: 'rb-icon', src, width: px, height: px, alt: '', draggable: false });
  const cls = el.hasAttribute('getImage') ? 'rb-icon placeholder dynamic' : image || imageMso ? 'rb-icon placeholder' : 'rb-icon placeholder none';
  return h('span', { class: cls, style: `width:${px}px;height:${px}px`, title: imageMso ?? image ?? el.getAttribute('getImage') ?? '' }, imageMso ? imageMso.slice(0, 1) : '');
}

function renderControl(el: Element, size: Size, errorPaths: Set<string>): HTMLElement {
  const node = renderControlBody(el, size, errorPaths);
  const badge = el.localName === 'separator' ? null : keytipBadge(el, keytipDups.has(el));
  if (badge) node.append(badge);
  return node;
}

function renderControlBody(el: Element, size: Size, errorPaths: Set<string>): HTMLElement {
  const path = pathOf(el);
  const tag = el.localName;
  const label = labelOf(el);
  const showLabel = el.getAttribute('showLabel') !== 'false' && !(size === 'small' && el.parentElement?.localName === 'buttonGroup' && !el.hasAttribute('showLabel'));
  const hidden = el.getAttribute('visible') === 'false';
  const disabled = el.getAttribute('enabled') === 'false' || getOverride(overrideKey(el, path))?.enabled === false;
  const cls = ['rb-ctl', `rb-${tag}`, size, isSelected(el) ? 'selected' : '', hidden ? 'hidden-ctl' : '', disabled ? 'disabled' : '', errorPaths.has(path.join('.')) ? 'has-error' : '', el.hasAttribute('idMso') ? 'builtin-ref' : ''].join(' ');
  const common = {
    class: cls,
    // id はマウスを乗せたときのヒント（ribbonTips.ts）の下に出す。title だとヒントと二重に出るため付けない
    dataset: { path: path.join('.'), sel: '1', tip: '1' },
    draggable: true,
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      app.store?.select(path, 'canvas');
    },
    ondragstart: (e: DragEvent) => {
      e.stopPropagation();
      startDrag(e, { kind: 'move', path });
    },
    ondragend: () => endDrag(),
  };
  const arrow = () => h('span', { class: 'rb-arrow', 'aria-hidden': 'true' });
  const labelEl = (text: string) => h('span', { class: 'rb-label' }, text);

  switch (tag) {
    case 'separator':
      return h('div', { ...common, class: `${cls} rb-sep` });
    case 'checkBox':
      return h('div', common, h('span', { class: 'rb-check' }), labelEl(label));
    case 'labelControl':
      return h('div', common, labelEl(label));
    case 'editBox':
    case 'comboBox':
    case 'dropDown':
      return h(
        'div',
        common,
        el.hasAttribute('image') || el.hasAttribute('imageMso') ? iconFor(el, 'small') : null,
        showLabel && label ? labelEl(label) : null,
        h('span', { class: 'rb-field' }, tag === 'editBox' ? null : h('span', { class: 'rb-field-drop' }, arrow())),
        menuPopup(el),
      );
    case 'box': {
      const inner = h('div', { class: `rb-box-inner ${el.getAttribute('boxStyle') === 'vertical' ? 'vertical' : 'horizontal'}`, dataset: { container: path.join('.') } });
      for (const c of childElements(el)) if (!hiddenInPreview(c)) inner.append(renderControl(c, 'small', errorPaths));
      if (el.children.length === 0) inner.append(h('span', { class: 'rb-empty-slot' }, 'box'));
      return h('div', common, inner);
    }
    case 'buttonGroup': {
      const inner = h('div', { class: 'rb-bg-inner', dataset: { container: path.join('.') } });
      for (const c of childElements(el)) if (!hiddenInPreview(c)) inner.append(renderControl(c, 'small', errorPaths));
      if (el.children.length === 0) inner.append(h('span', { class: 'rb-empty-slot' }, 'buttonGroup'));
      return h('div', common, inner);
    }
    case 'splitButton': {
      // 分割ボタンは「押す部分」と「メニューを開く部分」を線で分ける（本物と同じ見た目）
      const main = childElements(el).find((c) => c.localName === 'button' || c.localName === 'toggleButton');
      const mainLabel = main ? labelOf(main) : label;
      const icon = el.getAttribute('showImage') === 'false' ? null : main ? iconFor(main, size) : iconFor(el, size);
      return size === 'large'
        ? h('div', common, h('span', { class: 'rb-split-main' }, icon), h('span', { class: 'rb-split-drop' }, showLabel ? labelEl(mainLabel) : null, arrow()), menuPopup(el))
        : h('div', common, h('span', { class: 'rb-split-main' }, icon, showLabel ? labelEl(mainLabel) : null), h('span', { class: 'rb-split-drop' }, arrow()), menuPopup(el));
    }
    default: {
      const hasArrow = tag === 'menu' || tag === 'dynamicMenu' || tag === 'gallery';
      return h(
        'div',
        common,
        el.getAttribute('showImage') === 'false' ? null : iconFor(el, size),
        showLabel && label ? labelEl(label) : null,
        hasArrow ? arrow() : null,
        hasArrow ? menuPopup(el) : null,
      );
    }
  }
}

/** ポップアップごとの鍵（描き直したときにスクロール位置を戻すため）。 */
function popupKey(popup: HTMLElement): string {
  return popup.dataset['container'] ?? popup.dataset['popup'] ?? '';
}

/**
 * 要素にかかっている CSS の zoom（幅のプレビューの「収める」）。
 * Chromium では、getBoundingClientRect は縮小後の画面上の値、offsetWidth・scrollHeight・clientHeight・scrollTop は
 * 縮小前の値を返し、zoom の中の position:fixed の top・left は縮小率を掛けて置かれる（Chromium 128 以降の標準の zoom）。
 * 画面上の値で計算して、書き込むときに縮小率で割る。
 */
function zoomOf(el: HTMLElement): number {
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  return typeof z === 'number' && z > 0 ? z : 1;
}

/** キャンバスのスクロールする枠。見える範囲の基準にもする。 */
function paneOf(host: HTMLElement): HTMLElement {
  return host.closest<HTMLElement>('.canvas-pane') ?? host;
}

/**
 * メニューのポップアップを、開き口のすぐ下に画面基準（fixed）で置く。
 * リボン本体は横スクロールのために overflow-x:auto にしており、CSS の決まりで縦も auto 扱いになる。
 * そのまま absolute で置くと本体の中に閉じ込められて選択肢が隠れるため、本体の枠の外に出す。
 * ただし置ける範囲はキャンバスの枠の中に限る。XML エディタで <menu> の中にカーソルがあると
 * 選択が同期してポップアップが開くので、枠の外まで伸ばすと、いま打っている XML を覆ってしまうため。
 * 入りきらない分はポップアップの中でスクロールさせる。
 */
function placePopups(host: HTMLElement): void {
  const margin = 4;
  const popups = Array.from(host.querySelectorAll<HTMLElement>('.rb-menu-popup'));
  if (popups.length === 0) return;
  const pr = paneOf(host).getBoundingClientRect();
  // 見出しは枠の上に貼り付く（sticky）ので、ポップアップは見出しの下から置く（見出しに重ねると、幅の切り替えが押せなくなるため）
  const header = host.querySelector<HTMLElement>('.cv-header');
  const viewTop = Math.max(0, pr.top, header ? header.getBoundingClientRect().bottom : 0);
  const viewBottom = Math.min(window.innerHeight, pr.bottom);
  const viewLeft = Math.max(0, pr.left);
  const viewRight = Math.min(window.innerWidth, pr.right);
  for (const popup of popups) {
    const anchor = popup.parentElement;
    if (!anchor) continue;
    const r = anchor.getBoundingClientRect();
    popup.style.position = 'fixed';
    // 開き口が枠の外へスクロールしたら、ポップアップだけが宙に浮いて残らないよう隠す
    const anchorVisible = r.bottom > viewTop && r.top < viewBottom && r.right > viewLeft && r.left < viewRight;
    // 高さは maxHeight を外して測らない。外すと中身が一瞬縮んで scrollTop が 0 に戻るため、
    // 中身の高さ（scrollHeight）と枠線の分から本来の高さを出す
    const scrollTop = popup.scrollTop;
    // 以下は画面上の大きさ（縮小後）で計算する
    const z = zoomOf(popup);
    const ph = (popup.scrollHeight + (popup.offsetHeight - popup.clientHeight)) * z;
    const w = popup.offsetWidth * z;
    const below = viewBottom - r.bottom - margin;
    const above = r.top - viewTop - margin;
    // 下に入りきらず、上のほうが広ければ上に開く（Excel と同じ振る舞い）。どちらも枠の中で
    let top: number;
    let room: number;
    if (ph <= below || below >= above) {
      top = r.bottom;
      room = below;
    } else {
      room = above;
      top = r.top - Math.min(ph, above);
    }
    popup.style.maxHeight = ph > room ? `${Math.max(0, Math.floor(room / z))}px` : '';
    popup.style.visibility = anchorVisible && room >= 24 ? '' : 'hidden';
    const left = Math.max(viewLeft + margin, Math.min(r.left, viewRight - w - margin));
    popup.style.top = `${top / z}px`;
    popup.style.left = `${left / z}px`;
    // 高さを詰めると scrollTop が切り詰められることがあるので、測る前の位置に戻す
    popup.scrollTop = scrollTop;
  }
}

/**
 * ポップアップの中だけをスクロールして、項目を見える位置に出す。
 * scrollIntoView はキャンバスの枠まで一緒にスクロールさせ、リボンがずれてしまうため使わない。
 */
function revealInPopup(popup: HTMLElement, item: HTMLElement): void {
  // 矩形は縮小後、scrollTop・clientHeight は縮小前の値なので、縮小率でそろえる（zoomOf を参照）
  const z = zoomOf(popup);
  const pr = popup.getBoundingClientRect();
  const ir = item.getBoundingClientRect();
  const top = pr.top + popup.clientTop * z;
  const bottom = top + popup.clientHeight * z;
  if (ir.top < top) popup.scrollTop -= (top - ir.top) / z;
  else if (ir.bottom > bottom) popup.scrollTop += Math.min(ir.bottom - bottom, ir.top - top) / z;
}

/** メニュー類が選択されているときだけ、中身を一覧で開いて選べるようにする。 */
function menuPopup(el: Element): HTMLElement | null {
  if (measuring || readOnlyRender) return null;
  const sel = app.store?.selection;
  const path = pathOf(el);
  if (!sel || !(samePath(sel, path) || isAncestorPath(path, sel))) return null;
  if (dismissedPopup !== null && dismissedPopup === path.join('.')) return null;
  const items: HTMLElement[] = [];
  const walk = (parent: Element, depth: number) => {
    for (const c of childElements(parent)) {
      const cp = pathOf(c);
      items.push(
        h(
          'div',
          {
            class: `rb-menu-item${samePath(sel, cp) ? ' selected' : ''}`,
            style: `padding-left:${8 + depth * 12}px`,
            dataset: { path: cp.join('.'), sel: '1' },
            draggable: true,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              app.store?.select(cp, 'canvas');
            },
            ondragstart: (e: DragEvent) => {
              e.stopPropagation();
              startDrag(e, { kind: 'move', path: cp });
            },
            ondragend: () => endDrag(),
          },
          c.localName === 'menuSeparator' ? h('span', { class: 'rb-menu-sep' }, c.getAttribute('title') ?? '') : h('span', { class: 'rb-label' }, labelOf(c) || c.localName),
        ),
      );
      if (c.localName === 'menu' || c.localName === 'splitButton') walk(c, depth + 1);
    }
  };
  walk(el, 0);
  if (items.length === 0) items.push(h('div', { class: 'rb-menu-item muted' }, el.localName === 'dynamicMenu' ? tr('中身は getContent で作られます') : tr('（空）')));
  return h('div', { class: 'rb-menu-popup', dataset: { container: path.join('.') } }, items);
}

// ---- キーボード操作（A1） ----

function parsePath(s: string | undefined): Path | null {
  if (s === undefined) return null;
  return s === '' ? [] : s.split('.').map(Number);
}

/** 要素を表す（選択できる）ノード。 */
function nodeOf(host: HTMLElement, path: Path): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-sel][data-path="${path.join('.')}"]`);
}

function selectableNodes(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-sel][data-path]'));
}

/** キャンバスに描かれている要素のパス（描かれている順）。見出しのメニューの中は除く。 */
function renderedPaths(host: HTMLElement): Path[] {
  return selectableNodes(host).filter((n) => !n.closest('.cv-header, .cv-pop')).map((n) => parsePath(n.dataset['path'])!);
}

/** 同じ親を持つノードの中から、方向に一番近いものを選ぶ。 */
function nearest(from: HTMLElement, candidates: HTMLElement[], dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === from) continue;
    const b = c.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const ok = dir === 'left' ? dx < -2 : dir === 'right' ? dx > 2 : dir === 'up' ? dy < -2 : dy > 2;
    if (!ok) continue;
    // 進む方向の距離を優先し、横（縦）のずれは重く数える
    const main = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
    const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = main + cross * 3;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function siblingsOf(host: HTMLElement, path: Path): HTMLElement[] {
  const parent = path.slice(0, -1).join('.');
  return selectableNodes(host).filter((n) => {
    const p = parsePath(n.dataset['path']);
    return p !== null && p.length === path.length && p.slice(0, -1).join('.') === parent;
  });
}

function childrenOf(host: HTMLElement, path: Path): HTMLElement[] {
  return selectableNodes(host).filter((n) => {
    const p = parsePath(n.dataset['path']);
    return p !== null && p.length === path.length + 1 && isAncestorPath(path, p);
  });
}

function selectNode(n: HTMLElement | null | undefined): boolean {
  const p = parsePath(n?.dataset['path']);
  if (!p || !app.store) return false;
  app.store.select(p, 'canvas');
  revealNode(nodeOf(hostEl!, p));
  return true;
}

function onKey(e: KeyboardEvent, host: HTMLElement): void {
  if (e.isComposing || renaming) return;
  const target = e.target as HTMLElement;
  // 見出しの「表示」メニュー（とその先のメニュー）が開いていれば、Esc は閉じるだけにする。
  // 同じ Esc で複数選択まで解けると、選び直しになるため。メニューの中の入力欄やチェックボックスからでも閉じられるよう、先に見る
  if (e.key === 'Escape' && headerMenu) {
    e.preventDefault();
    e.stopPropagation();
    closeHeaderMenu();
    return;
  }
  if (target.closest('input, select, textarea, button')) {
    // ヘッダーの切り替えボタンなど、キャンバスの中のボタンでは既定の動作に任せる
    if (target.tagName !== 'BUTTON' || e.key === 'Enter' || e.key === ' ') return;
  }
  // Ctrl+A はキャンバスに描かれている要素だけを選ぶ（畳んだグループの中や、表示していないタブの中は選ばない）
  if (handleEditKey(e, 'canvas', () => renderedPaths(host))) return;
  const store = app.store;
  if (!store) return;
  const sel = store.selection;
  const cur = sel ? nodeOf(host, sel) : null;
  const key = e.key;

  if (!cur || !sel) {
    // 何も選んでいなければ、矢印キーで最初の要素を選ぶ
    if (key.startsWith('Arrow') || key === 'Home' || key === 'End') {
      e.preventDefault();
      const all = selectableNodes(host);
      selectNode(key === 'End' ? all.at(-1) : all[0]);
    }
    return;
  }

  if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    e.preventDefault();
    moveSelected(key === 'ArrowUp' ? -1 : 1, 'canvas');
    return;
  }

  const dirs: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const dir = dirs[key];
  if (dir) {
    e.preventDefault();
    const sibs = siblingsOf(host, sel);
    const next = nearest(cur, sibs, dir);
    if (next) {
      selectNode(next);
      return;
    }
    if (dir === 'down') {
      // 下に兄弟がなければ、中身（グループならコントロール、メニューなら項目）に入る
      const kids = childrenOf(host, sel);
      if (selectNode(nearest(cur, kids, 'down') ?? kids[0])) return;
    }
    if (dir === 'up' && sel.length > 0) {
      // 上に兄弟がなければ、親（コントロールならグループ、グループならタブ）に上がる
      if (selectNode(nodeOf(host, sel.slice(0, -1)))) return;
    }
    if ((dir === 'left' || dir === 'right') && sel.length > 1) {
      // 端まで来たら、隣のグループに移る
      const parent = nodeOf(host, sel.slice(0, -1));
      if (parent) {
        const pn = nearest(parent, siblingsOf(host, sel.slice(0, -1)), dir);
        const pp = parsePath(pn?.dataset['path']);
        if (pn && pp) {
          const kids = childrenOf(host, pp);
          selectNode((dir === 'right' ? kids[0] : kids.at(-1)) ?? pn);
        }
      }
    }
    return;
  }
  if (key === 'Home' || key === 'End') {
    e.preventDefault();
    const sibs = siblingsOf(host, sel);
    selectNode(key === 'Home' ? sibs[0] : sibs.at(-1));
  } else if (key === 'Escape') {
    closeMenu();
    // 複数選択中なら、まず主な選択だけに戻す（親へ上がるのは、その次の Esc）
    if (store.clearMulti('canvas')) {
      e.preventDefault();
      return;
    }
    if (sel.length > 0 && nodeOf(host, sel.slice(0, -1))) {
      e.preventDefault();
      store.select(sel.slice(0, -1), 'canvas');
    }
  } else if (key === 'Enter') {
    e.preventDefault();
    focusField('label');
  } else if (key === 'F2') {
    e.preventDefault();
    if (!startRename(host, sel)) focusField('label');
  } else if (key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    const r = cur.getBoundingClientRect();
    openElementMenu(r.left + Math.min(16, r.width / 2), r.bottom, sel, 'canvas', host);
  }
}

/** F2：ラベルをその場で書き換える。ラベルを持てない要素や、VBA で返すラベルなら false。 */
function startRename(host: HTMLElement, path: Path): boolean {
  const store = app.store;
  const el = store ? elementAt(store.doc, path) : null;
  const node = nodeOf(host, path);
  if (!store || !el || !node || el.hasAttribute('getLabel') || !defFor(el)?.attrs.includes('label')) return false;
  const labelNode = node.querySelector<HTMLElement>(':scope > .rb-label, :scope > .rb-group-label > .rb-label, :scope > .rb-split-main > .rb-label, :scope > .rb-split-drop > .rb-label, :scope > span:not([class])') ?? (inBackstage(el) ? node : null);
  if (!labelNode) return false;
  // 畳んだ枠の中（非表示）では入力欄にフォーカスが移らず、blur も来ないので、始めない
  if (!isShown(node)) return false;
  const original = el.getAttribute('label') ?? '';
  const saved = Array.from(labelNode.childNodes);
  const wasDraggable = node.draggable;
  const snap = snapshotOf(el);
  const input = h('input', { type: 'text', class: 'cv-rename', value: original, spellcheck: false, 'aria-label': tr('ラベル') });
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    renaming = false;
    cancelRename = null;
    const v = input.value;
    if (commit && v !== original) {
      runEdit('canvas', (doc) => {
        const target = elementAt(doc, path);
        if (!target) return undefined;
        if (v === '') target.removeAttribute('label');
        else target.setAttribute('label', v);
        return undefined;
      }, tr('ラベルを「{name}」に変更', { name: v }));
    }
    renderCanvas(host);
    host.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    // 日本語入力の変換確定の Enter で確定しない（不具合 39）
    if (e.isComposing || e.keyCode === 229) return;
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  /** 入力欄を外して元の表示に戻す（確定も描き直しもしない）。 */
  const undo = () => {
    done = true;
    renaming = false;
    cancelRename = null;
    labelNode.replaceChildren(...saved);
    node.draggable = wasDraggable;
  };
  renaming = true;
  cancelRename = (doc) => {
    if (!isSameElementAt(doc, path, snap)) undo();
  };
  labelNode.replaceChildren(input);
  node.draggable = false;
  input.focus();
  // フォーカスが取れなかった（見えない枠の中など）なら、blur が来ないまま入力中が続くので、始めなかったことにする
  if (document.activeElement !== input) {
    undo();
    return false;
  }
  input.select();
  return true;
}

/** 画面に出ているか（display: none や visibility: hidden の枠の中ではない）。 */
function isShown(node: HTMLElement): boolean {
  // jsdom など checkVisibility のない環境は、見えるものとして扱う（getClientRects は jsdom で常に空になる）
  return typeof node.checkVisibility === 'function' ? node.checkVisibility(VISIBILITY_OPTIONS) : true;
}

// ---- ドラッグ＆ドロップ ----

interface DropSpot {
  parentPath: Path | null | 'contextMenus' | 'backstage';
  index: number;
  rect: { left: number; top: number; width: number; height: number };
  /** 置き先として強調するノード。 */
  container: HTMLElement | null;
}

/** 運んでいる要素（移動のとき）。 */
function movingElement(doc: Document): Element | null {
  const p = dragPayload();
  return p?.kind === 'move' ? elementAt(doc, p.path) : null;
}

/** 並び順の決まりに合わない位置なら null にする（A16：置けない場所では表示を出さない）。 */
function checkOrder(doc: Document, spot: DropSpot | null): DropSpot | null {
  if (!spot || spot.parentPath === null || typeof spot.parentPath === 'string') return spot;
  const parent = elementAt(doc, spot.parentPath);
  const tag = draggedTag(doc);
  if (!parent || !tag) return null;
  // まとめて運んでいるときは、全部をその位置に置けるかを確かめる（1つでも置けなければ表示を出さない）
  const payload = dragPayload();
  if (payload?.kind === 'move' && payload.paths && payload.paths.length > 1) return canDropManyAt(doc, spot.parentPath, spot.index) ? spot : null;
  const moving = movingElement(doc);
  const allowed = allowedIndex(parent, tag, spot.index, moving && moving.parentElement === parent ? moving : null);
  return allowed === null ? null : spot;
}

/** ポインタの位置から、置ける場所を探す。置けなければ null。 */
function findDropSpot(e: DragEvent, host: HTMLElement): DropSpot | null {
  const store = app.store;
  const payload = dragPayload();
  if (!store || !payload) return null;
  const doc = store.doc;
  const target = e.target as HTMLElement;

  // タブを運んでいるときは、タブバーの上だけを受け付ける
  const tabBar = target.closest<HTMLElement>('.rb-tabs');
  if (tabBar) {
    const tabsEl = findChild(findChild(doc.documentElement, 'ribbon'), 'tabs');
    if (tabsEl ? !canDropInto(doc, tabsEl) : !(payload.kind === 'new' && payload.tag === 'tab')) return null;
    const tabNodes = Array.from(tabBar.querySelectorAll<HTMLElement>('.rb-tab[data-path]'));
    const tabsPath = tabsEl ? pathOf(tabsEl) : null;
    const own = tabNodes.filter((n) => {
      const p = parsePath(n.dataset['path']);
      return p !== null && tabsPath !== null && p.length === tabsPath.length + 1;
    });
    for (const n of own) {
      const r = n.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        return { parentPath: tabsPath, index: parsePath(n.dataset['path'])!.at(-1)!, rect: { left: r.left - 2, top: r.top, width: 2, height: r.height }, container: tabBar };
      }
    }
    const last = own.at(-1) ?? tabNodes.at(-1);
    const r = (last ?? tabBar).getBoundingClientRect();
    return { parentPath: tabsPath, index: tabsEl?.children.length ?? 0, rect: { left: r.right + 1, top: r.top, width: 2, height: r.height }, container: tabBar };
  }

  // Backstage がまだないときは、空の欄へのドロップで作る
  const bsNew = target.closest<HTMLElement>('[data-bs-new]');
  if (bsNew) {
    if (draggedTag(doc) !== 'backstage') return null;
    const r = bsNew.getBoundingClientRect();
    return { parentPath: 'backstage', index: 0, rect: { left: r.left + 4, top: r.top + 4, width: r.width - 8, height: 2 }, container: bsNew };
  }

  // コンテキストメニューの一覧がまだないときは、空の欄へのドロップで作る
  const ctxNew = target.closest<HTMLElement>('[data-ctx-new]');
  if (ctxNew) {
    if (draggedTag(doc) !== 'contextMenu') return null;
    const r = ctxNew.getBoundingClientRect();
    return { parentPath: 'contextMenus', index: 0, rect: { left: r.left + 4, top: r.bottom - 6, width: r.width - 8, height: 2 }, container: ctxNew };
  }

  // 内側のコンテナから順に、置けるところを探す
  let node: HTMLElement | null = target.closest<HTMLElement>('[data-container], [data-path]');
  while (node && host.contains(node)) {
    const containerPath = parsePath(node.dataset['container']);
    const container = containerPath ? elementAt(doc, containerPath) : null;
    if (container && canDropInto(doc, container)) {
      const spot = checkOrder(doc, spotInContainer(e, node, containerPath!, container));
      if (spot) return spot;
    }

    const path = parsePath(node.dataset['path']);
    const el = path ? elementAt(doc, path) : null;
    if (el && !node.dataset['container']) {
      // グループ本体やタブ本体（data-path）は、その要素自身がコンテナになりうる
      if (canDropInto(doc, el) && (node.classList.contains('rb-body') || node.classList.contains('rb-group'))) {
        const inner = node.classList.contains('rb-group') ? node.querySelector<HTMLElement>('.rb-controls') ?? node : node;
        const spot = checkOrder(doc, spotInContainer(e, inner, path!, el));
        if (spot) return spot;
      }
      const parent = el.parentElement;
      if (parent && canDropInto(doc, parent)) {
        const r = node.getBoundingClientRect();
        const idx = Array.prototype.indexOf.call(parent.children, el) as number;
        // メニューの項目は縦に並ぶので、上下で前後を決める
        const vertical = node.classList.contains('rb-menu-item') || node.classList.contains('bs-item') || node.classList.contains('bs-group') || node.classList.contains('bs-category');
        const before = vertical ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
        const spot = checkOrder(doc, {
          parentPath: pathOf(parent),
          index: before ? idx : idx + 1,
          rect: vertical
            ? { left: r.left, top: (before ? r.top : r.bottom) - 1, width: r.width, height: 2 }
            : { left: (before ? r.left : r.right) - 1, top: r.top, width: 2, height: r.height },
          container: node.parentElement?.closest<HTMLElement>('[data-container], .rb-group, .rb-body') ?? null,
        });
        if (spot) return spot;
      }
    }
    node = node.parentElement?.closest<HTMLElement>('[data-container], [data-path]') ?? null;
  }
  return null;
}

function spotInContainer(e: DragEvent, node: HTMLElement, containerPath: Path, container: Element): DropSpot {
  const kids = Array.from(node.querySelectorAll<HTMLElement>('[data-path]')).filter((k) => {
    const p = parsePath(k.dataset['path']);
    return p !== null && p.length === containerPath.length + 1 && containerPath.every((v, i) => v === p[i]);
  });
  const highlight = node.closest<HTMLElement>('.rb-group, .ctx-card, .bs-column, .bs-group, .rb-body') ?? node;
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    const inList = isVerticalList(k.parentElement);
    const before = inList
      ? e.clientY < r.top + r.height / 2
      : e.clientX < r.left || (e.clientX <= r.right && e.clientY < r.top + r.height / 2 && r.height < 40) || (e.clientX <= r.left + r.width / 2 && r.height >= 40);
    if (before) {
      const idx = parsePath(k.dataset['path'])!.at(-1)!;
      const stacked = inList || (r.height < 40 && k.parentElement?.classList.contains('rb-stack') && k.previousElementSibling !== null);
      return {
        parentPath: containerPath,
        index: idx,
        rect: stacked ? { left: r.left, top: r.top - 1, width: r.width, height: 2 } : { left: r.left - 2, top: r.top, width: 2, height: r.height },
        container: highlight,
      };
    }
  }
  const last = kids.at(-1);
  const r = (last ?? node).getBoundingClientRect();
  return {
    parentPath: containerPath,
    index: container.children.length,
    rect: last
      ? isVerticalList(last.parentElement)
        ? { left: r.left, top: r.bottom, width: r.width, height: 2 }
        : { left: r.right + 1, top: r.top, width: 2, height: r.height }
      : { left: r.left + 4, top: r.top + 4, width: 2, height: Math.max(r.height - 8, 16) },
    container: highlight,
  };
}

/** 縦に並ぶ一覧（メニュー、Backstage）か。前後を上下で決める。 */
function isVerticalList(el: Element | null): boolean {
  if (!el) return false;
  const c = el.classList;
  return c.contains('ctx-items') || c.contains('rb-menu-popup') || c.contains('bs-list') || c.contains('bs-column') || (c.contains('bs-nav') && !c.contains('horizontal'));
}

let highlighted: HTMLElement | null = null;

function showIndicator(host: HTMLElement, spot: DropSpot): void {
  const ind = host.querySelector<HTMLElement>('.drop-indicator');
  if (!ind) return;
  const base = host.getBoundingClientRect();
  ind.hidden = false;
  ind.style.left = `${spot.rect.left - base.left + host.scrollLeft}px`;
  ind.style.top = `${spot.rect.top - base.top + host.scrollTop}px`;
  ind.style.width = `${spot.rect.width}px`;
  ind.style.height = `${spot.rect.height}px`;
  if (highlighted !== spot.container) {
    highlighted?.classList.remove('drop-target');
    highlighted = spot.container;
    highlighted?.classList.add('drop-target');
  }
}

function hideIndicator(host: HTMLElement): void {
  const ind = host.querySelector<HTMLElement>('.drop-indicator');
  if (ind) ind.hidden = true;
  highlighted?.classList.remove('drop-target');
  highlighted = null;
}

function imageTarget(e: DragEvent): Path | null {
  const node = (e.target as HTMLElement).closest<HTMLElement>('.rb-ctl[data-path], .rb-group[data-path]');
  const path = parsePath(node?.dataset['path']);
  const el = path && app.store ? elementAt(app.store.doc, path) : null;
  return el && defFor(el)?.attrs.includes('image') ? path : null;
}

function onDragOver(e: DragEvent, host: HTMLElement): void {
  if (e.dataTransfer?.types.includes('Files')) {
    // 画像ファイルをボタンに直接ドロップすると、アイコンエディタを開く（仕様書 §6.3）
    if (imageTarget(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
    return;
  }
  const spot = findDropSpot(e, host);
  if (!spot) {
    // 置けない場所では「禁止」のカーソルにする
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    hideIndicator(host);
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = dragPayload()?.kind === 'new' ? 'copy' : 'move';
  showIndicator(host, spot);
}

function onDrop(e: DragEvent, host: HTMLElement): void {
  hideIndicator(host);
  if (e.dataTransfer?.files.length) {
    const target = imageTarget(e);
    if (target) {
      e.preventDefault();
      onImageDrop?.(e.dataTransfer.files, target);
    }
    return;
  }
  const spot = findDropSpot(e, host);
  if (!spot) {
    endDrag();
    return;
  }
  e.preventDefault();
  drop(spot.parentPath, spot.index, 'canvas');
}

/**
 * 反映後に前面に出すタブの id。キャンバスで表示中の自作タブ、なければ最初の自作タブ。
 * 組み込みタブ（idMso）は ActivateTabMso が要るので、ここでは扱わない。
 */
export function tabIdToActivate(): string | null {
  const store = app.store;
  if (!store) return null;
  if (activeTab?.kind === 'el') {
    if (activeTab.id) return activeTab.id;
    const id = elementAt(store.doc, activeTab.path)?.getAttribute('id');
    if (id) return id;
  }
  const tabs = store.doc.documentElement.querySelector(':scope > ribbon > tabs');
  return tabs ? childElements(tabs).find((x) => x.localName === 'tab' && x.hasAttribute('id'))?.getAttribute('id') ?? null : null;
}
