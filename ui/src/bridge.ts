// ホスト（C#）とのメッセージ交換。src/Sash.App/MessageRouter.cs と対応させる。

import { lang, t } from './i18n';

export type CustomUIVersion = 'office2007' | 'office2010';

export interface AppInfo {
  version: string;
  excelInstalled: boolean;
  /** WebView2 ランタイム（Chromium）の版。ブラウザで動かしているとき（ホストなし）は無い */
  webView2Version?: string | null;
}

export interface ImageDto {
  id: string;
  contentType: string;
  base64: string;
}

export interface CustomUIPartDto {
  version: CustomUIVersion;
  xml: string;
  images: ImageDto[];
}

export interface OpenedDocument {
  path: string;
  parts: CustomUIPartDto[];
}

export interface PartToSave {
  version: CustomUIVersion;
  xml: string;
  addImages: { id: string; base64: string }[];
  removeImages: string[];
}

export interface RecentFile {
  path: string;
  exists: boolean;
}

export interface OpenWorkbook {
  fullPath: string;
  isAddIn: boolean;
  isDirty: boolean;
}

export type ApplyStatus =
  /** Excel で開いていたブックに反映し、開き直した。 */
  | 'applied'
  /** Excel で開いていなかったので、ファイルに書き込んだだけ。 */
  | 'written'
  /** 未保存の変更がある。保存してよいか利用者に確認が必要。 */
  | 'needsSave'
  /** 開き直したが、保護ビューかマクロの無効化で止まっている。 */
  | 'blocked';

export interface ApplyResult {
  status: ApplyStatus;
  message: string;
  backup?: string;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  xmlOnTop: boolean;
  iconSize: 32 | 64;
  ribbonErrorsHintShown: boolean;
  callbackPattern: string;
  callbackShared: boolean;
  callbackSharedPattern: string;
  callbackModule: string;
  language: 'ja' | 'en';
  /** アイコンライブラリの場所（表示用。変更は library.chooseFolder で行う）。 */
  iconLibraryPath: string;
  updateCheckOnStartup: boolean;
  /** 更新の確認先。空なら GitHub のリリース。 */
  updateSource: string;
  /** 未保存の編集を自動で退避する（§23.2）。 */
  autoRecovery: boolean;
  /** 開いたあとにほかでリボンが書き換えられたかを調べる（§23.4）。 */
  detectExternalChanges: boolean;
}

export interface UpdateCheckResult {
  status: 'upToDate' | 'available' | 'error' | 'disabled';
  current: string;
  latest: string | null;
  notes: string | null;
  canInstall: boolean;
  reason: string | null;
  pageUrl: string | null;
  source: string;
  managedByAdmin: boolean;
}

export interface UpdateStatus {
  current: string;
  checkOnStartup: boolean;
  source: string;
  managedByAdmin: boolean;
  logPath: string;
}

export interface LibraryIconDto {
  id: string;
  name: string;
  tags: string[];
  createdAt: string;
  hasSource: boolean;
  favorite: boolean;
  /** PNG の base64。 */
  png: string;
}

export interface LibraryIconDetail {
  id: string;
  name: string;
  tags: string[];
  png: string;
  source: string | null;
  sourceName: string | null;
  sourceContentType: string | null;
  options: Record<string, unknown> | null;
}

/** バックアップ 1 つ分（backup.list）。 */
export interface BackupEntry {
  /** バックアップのファイルのフルパス。 */
  path: string;
  /** 作った日時（ISO 8601）。 */
  createdAt: string;
  /** バイト数。 */
  size: number;
}

export type VbaReadStatus = 'ok' | 'notOpen' | 'trustDenied' | 'locked' | 'noExcel';

export interface VbaModuleDto {
  name: string;
  type: number;
  code: string;
}

/** imageMso の取り込みの状態（仕様書 §17.7）。 */
export type IconPrefetchState =
  /** まだ取り込んでいない（中止した・一部だけ取り込んだも含む）。 */
  | 'none'
  | 'running'
  | 'done'
  | 'failed'
  /** Excel がなく、キャッシュもない。 */
  | 'unavailable';

/** icons.prefetchStatus の応答。src/Sash.App/MessageRouter.cs の PrefetchStatusDto と対応させる。 */
export interface IconPrefetchStatus {
  state: IconPrefetchState;
  /** 今回の取り込みで処理した数（名前 × 大きさ）。 */
  done: number;
  /** 今回の取り込みで処理する数。 */
  total: number;
  /** 処理中の大きさ（px）。 */
  size: number;
  /** 画像にできなかった数。 */
  failed?: number;
  /** キャッシュにある画像の数（32px）。 */
  cached: number;
  /** 取り込み済みのキャッシュを作った Excel の版。 */
  excelVersion?: string | null;
  /** 取り込みを終えた日時（ISO 8601）。 */
  cachedAt?: string | null;
  /** 失敗の理由・中止したことなど。 */
  message?: string | null;
  excelInstalled?: boolean;
  /** いま入っている Excel の版。 */
  currentExcelVersion?: string | null;
  /** キャッシュを作った Excel と、いまの Excel の版が違う（取り込み直しを勧める）。 */
  outdated?: boolean;
  /**
   * 直前の取り込みが中止で終わった。取り込み直しを中止すると前の記録が残っていて state は done になるので、
   * 「取り込みました」と出さないために別に知らせる。
   */
  cancelled?: boolean;
}

/** 退避したパーツ 1 つ分（未保存の編集。§23.2）。画像は保存済みからの差分。 */
export interface RecoveryPartDto {
  version: CustomUIVersion;
  xml: string;
  addImages: { id: string; dataUrl: string }[];
  removeImages: string[];
}

export interface RecoveryEntryDto {
  path: string;
  savedAt: string;
  editCount: number;
  parts: RecoveryPartDto[];
  /** 元のファイルが、退避のあとで変わっている（recovery.read だけが付ける）。 */
  fileNewer?: boolean;
}

export interface RecoverySummaryDto {
  path: string;
  savedAt: string;
  editCount: number;
  fileExists: boolean;
  fileModifiedAt: string | null;
  /** 元のファイルが、退避のあとで変わっている。 */
  fileNewer: boolean;
}

/** 要求の種類ごとの payload と応答の型。 */
export interface HostApi {
  'app.ready': { req: undefined; res: { initialFile: string | null; updatedFrom?: string | null; version?: string } };
  'app.info': { req: undefined; res: AppInfo };
  'app.close': { req: undefined; res: null };
  'app.titleBarTheme': { req: { dark: boolean }; res: null };
  /** ウィンドウの × で頼まれた終了を、利用者が取りやめた（未保存の確認でキャンセルなど）。ホストは次の × を受け付け直す。 */
  'app.closeCancelled': { req: undefined; res: null };
  /** 想定外の例外をホストのログ（app.log）に残す。製品版は開発者ツールが使えないため。 */
  'app.log': { req: { level: 'error' | 'warning' | 'info'; message: string; stack?: string }; res: null };
  'file.open': { req: { path?: string } | undefined; res: OpenedDocument | null };
  'file.save': { req: { path: string; parts: PartToSave[] }; res: { backup: string } };
  'file.exportText': { req: { defaultName: string; filter: string; content: string }; res: string | null };
  'file.recent': { req: undefined; res: RecentFile[] };
  'file.removeRecent': { req: { path: string }; res: null };
  'settings.get': { req: undefined; res: Settings };
  'settings.set': { req: Partial<Settings>; res: Settings };
  'excel.openWorkbooks': { req: undefined; res: OpenWorkbook[] };
  'excel.apply': { req: { path: string; parts: PartToSave[]; saveIfDirty: boolean; activateTab?: string }; res: ApplyResult };
  'excel.imageMso': { req: { names: string[]; size: number }; res: Record<string, string | null> };
  'excel.labels': { req: { ids: string[] }; res: Record<string, string> };
  'update.check': { req: undefined; res: UpdateCheckResult };
  'update.install': { req: undefined; res: null };
  'update.status': { req: undefined; res: UpdateStatus };
  'update.openPage': { req: { url: string }; res: null };
  'library.list': { req: undefined; res: { root: string; icons: LibraryIconDto[] } };
  'library.get': { req: { id: string }; res: LibraryIconDetail | null };
  'library.save': { req: { name: string; tags: string[]; png: string; source?: string; sourceName?: string; sourceContentType?: string; options?: unknown }; res: { id: string } };
  'library.update': { req: { id: string; name?: string; tags?: string[] }; res: unknown };
  'library.delete': { req: { id: string }; res: null };
  'library.chooseFolder': { req: undefined; res: string | null };
  'library.toggleFavorite': { req: { id: string }; res: boolean };
  'icons.fromExecutable': { req: undefined; res: { fileName: string; icons: { name: string; base64: string }[] } | null };
  'icons.prefetchStatus': { req: undefined; res: IconPrefetchStatus };
  /** 取り込みを始める（実行中ならそのまま）。force なら取り込み済みの名前も Excel から取り直す。 */
  'icons.prefetchStart': { req: { names: string[]; sizes?: number[]; force?: boolean }; res: IconPrefetchStatus };
  'icons.prefetchCancel': { req: undefined; res: IconPrefetchStatus };
  'recipes.list': { req: undefined; res: unknown[] };
  'recipes.save': { req: Record<string, unknown>; res: null };
  'recipes.delete': { req: { id: string }; res: null };
  /** 未保存の編集を退避する（§23.2）。退避は保険なので、失敗しても UI は編集を止めない。 */
  'recovery.write': { req: { path: string; editCount: number; parts: RecoveryPartDto[] }; res: null };
  'recovery.read': { req: { path: string }; res: RecoveryEntryDto | null };
  'recovery.delete': { req: { path: string }; res: null };
  /** 退避の一覧（新しい順）。古いものと壊れたものは、ホストがここで掃除する。 */
  'recovery.list': { req: undefined; res: RecoverySummaryDto[] };
  'backup.list': { req: { path: string }; res: BackupEntry[] };
  /** バックアップの中身でファイルを置き換える。backup は戻す直前の今のファイルのバックアップ。終わったら UI は開き直す。 */
  'backup.restore': { req: { path: string; backupPath: string }; res: { backup: string | null } };
  'vba.read': { req: { path: string }; res: { status: VbaReadStatus; modules: VbaModuleDto[] } };
  'vba.insert': { req: { path: string; module: string; code: string; documentModule: boolean }; res: boolean };
  'vba.replaceLine': { req: { path: string; module: string; line: number; expected: string; replacement: string }; res: boolean };
  /** VBE を表示し、module の procedure の宣言行を選ぶ（仕様書 §18.5）。 */
  'vba.reveal': { req: { path: string; module: string; procedure: string }; res: boolean };
  /**
   * Excel のウィンドウの幅を合わせる（仕様書 §18.1）。width は拡大率をかける前の画面の幅（物理 px。例：1920）、
   * scale は Windows の拡大率（1.5 = 150%。10 以上なら % とみなすので 150 でもよい）。Application.Width には width / scale × 0.75（ポイント）を入れる。
   * path を付けると、そのブックを開いている Excel を対象にする（省略時は UI が開いているファイル）。
   * モニターの作業領域より広いときは、理由を添えて失敗する。
   */
  'excel.setWindowWidth': { req: { width: number; scale: number; path?: string }; res: WindowWidthResult };
  /**
   * 開いているブックのマクロを Application.Run で実行する（試しに押す。仕様書 §18.4）。引数のない Sub はそのまま、
   * IRibbonControl を 1 つ受け取る Sub は control に Nothing を渡して実行し、ほかの形は理由を添えて失敗する。
   * argument は VBA を読めないときの呼び方（XML のコールバックの形から UI が決める）。ブックは書き換えない。
   * 実行中（MsgBox などで止まっている間も）は、Excel を使うほかの要求（反映・VBA・幅・imageMso の取得）をホストがすぐに断る。
   */
  'excel.runMacro': { req: { path: string; macro: string; controlId?: string; argument?: 'none' | 'control' }; res: boolean };
}

/** excel.setWindowWidth の応答。幅は論理 px。 */
export interface WindowWidthResult {
  /** Application.Width に入れた値（ポイント）。 */
  points: number;
  /** 合わせた幅（width / scale）。 */
  logicalWidth: number;
  /** Excel のある画面の作業領域の幅。 */
  workAreaWidth: number;
  /** 前に出したブックの名前（アドインのときは null）。 */
  workbook: string | null;
  /** 合わせた後に GetWindowRect で測ったウィンドウの幅（物理 px）。測れなかったときはない。 */
  actualWidth?: number;
  /** 狙った幅（物理 px。論理 px × モニターの dpi / 96）。 */
  expectedWidth?: number;
}

/** ホストから届く通知。 */
export type HostEvent =
  | { event: 'closeRequested' }
  | { event: 'fileDropped'; path: string }
  /** imageMso の取り込みの進み具合。まとまり（50 件）ごとと、状態が変わったときに届く。 */
  | { event: 'iconPrefetch'; state: IconPrefetchState; done: number; total: number; size?: number; failed?: number; cached?: number; message?: string | null; cancelled?: boolean };

interface HostResponse {
  id: number;
  ok: boolean;
  payload: unknown;
  error: string | null;
}

interface WebView {
  postMessage(message: unknown): void;
  postMessageWithAdditionalObjects?(message: unknown, objects: ArrayLike<File>): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<HostResponse | HostEvent>) => void): void;
}

declare global {
  interface Window {
    chrome?: { webview?: WebView };
  }
}

const webview = window.chrome?.webview;

/** WebView2 の中で動いているか。ブラウザで npm run dev したときは false。 */
export const isHosted = webview !== undefined;

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const eventListeners = new Set<(e: HostEvent) => void>();

webview?.addEventListener('message', (e) => {
  const data = e.data;
  if ('event' in data) {
    for (const l of eventListeners) l(data);
    return;
  }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.ok) p.resolve(data.payload);
  else p.reject(new Error(data.error ?? t('不明なエラー')));
});

export function onHostEvent(listener: (e: HostEvent) => void): void {
  eventListeners.add(listener);
}

export function invoke<K extends keyof HostApi>(type: K, payload?: HostApi[K]['req']): Promise<HostApi[K]['res']> {
  if (!webview) return mock.invoke(type, payload);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    webview.postMessage({ id, type, payload: payload ?? null });
  });
}

/** ドロップされたファイルのフルパスをホストに知らせる（ブラウザの File からはパスが取れないため）。 */
export function sendDroppedFiles(files: FileList): void {
  webview?.postMessageWithAdditionalObjects?.({ id: 0, type: 'file.drop', payload: null }, files);
}

// ---- ブラウザ単体で UI を確認するためのダミー ----

const sampleXml = `<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui" onLoad="Ribbon_onLoad">
  <ribbon>
    <tabs>
      <tab idMso="TabHome">
        <group id="grpQuick" label="よく使う" insertAfterMso="GroupClipboard">
          <button id="btnQuick" label="貼り付け（値）" imageMso="PasteValues" onAction="Ribbon_btnQuick_onAction" />
        </group>
      </tab>
      <tab id="tabTools" label="集計ツール" keytip="Y">
        <group id="grpSum" label="集計">
          <button id="btnSummary" label="集計する" size="large" imageMso="AutoSum" onAction="Ribbon_btnSummary_onAction" />
          <button id="btnCsv" label="CSV出力" imageMso="ExportTextFile" onAction="Ribbon_btnCsv_onAction" />
          <button id="btnClear" label="クリア" imageMso="Clear" onAction="Ribbon_btnClear_onAction" />
          <button id="btnSetting" label="設定" imageMso="ControlProperties" onAction="Ribbon_btnSetting_onAction" />
        </group>
        <group id="grpMode" label="モード">
          <toggleButton id="tglAuto" label="自動" size="large" imageMso="AutoFilter" getPressed="Ribbon_tglAuto_getPressed" onAction="Ribbon_tglAuto_onAction" />
          <!-- 出力先の選択 -->
          <dropDown id="ddnTarget" label="出力先" onAction="Ribbon_ddnTarget_onAction">
            <item id="itmSheet" label="シート" />
            <item id="itmFile" label="ファイル" />
          </dropDown>
          <checkBox id="chkHeader" label="見出しを含める" onAction="Ribbon_chkHeader_onAction" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

// ?excel を付けると Excel があるものとして、?slow を付けると保存・反映を遅くして動きを確かめられる
const mockParams = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const mockExcel = mockParams.has('excel');
const mockDelay = (ms: number) => new Promise((done) => setTimeout(done, mockParams.has('slow') ? ms : 0));

// ---- imageMso の取り込みのダミー（?excel で Excel あり、?icons で取り込み済みとして始める） ----

const mockPrefetch: IconPrefetchStatus & { timer?: number } = {
  state: mockParams.has('icons') ? 'done' : mockExcel ? 'none' : 'unavailable',
  done: 0,
  total: 0,
  size: 32,
  failed: 0,
  cached: mockParams.has('icons') ? 2081 : 0,
  excelVersion: mockParams.has('icons') ? '16.0.19029' : null,
  cachedAt: mockParams.has('icons') ? new Date().toISOString() : null,
  message: null,
  excelInstalled: mockExcel,
  currentExcelVersion: mockExcel ? '16.0.19029' : null,
  outdated: false,
};

function mockPrefetchSnapshot(): IconPrefetchStatus {
  const { timer: _timer, ...rest } = mockPrefetch;
  return { ...rest };
}

function emitMockPrefetch(): void {
  const s = mockPrefetch;
  const e: HostEvent = { event: 'iconPrefetch', state: s.state, done: s.done, total: s.total, size: s.size, failed: s.failed, cached: s.cached, message: s.message, cancelled: s.cancelled ?? false };
  for (const l of eventListeners) l(e);
}

function startMockPrefetch(names: string[], sizes: number[]): void {
  if (mockPrefetch.state === 'running') return;
  // 取り込み直しの中止を確かめられるよう、前の記録（excelVersion など）は残したまま始める
  Object.assign(mockPrefetch, { state: 'running', done: 0, total: names.length * sizes.length, size: sizes[0] ?? 32, message: null, cancelled: false });
  const step = Math.max(50, Math.ceil(mockPrefetch.total / 40));
  mockPrefetch.timer = window.setInterval(() => {
    mockPrefetch.done = Math.min(mockPrefetch.total, mockPrefetch.done + step);
    mockPrefetch.size = mockPrefetch.done * 2 > mockPrefetch.total ? (sizes[1] ?? 32) : (sizes[0] ?? 32);
    if (mockPrefetch.done >= mockPrefetch.total) {
      window.clearInterval(mockPrefetch.timer);
      Object.assign(mockPrefetch, { state: 'done', cached: names.length, excelVersion: '16.0.19029', cachedAt: new Date().toISOString() });
    }
    emitMockPrefetch();
  }, mockParams.has('slow') ? 400 : 100);
  emitMockPrefetch();
}

/** ブラウザ実行中の imageMso の代わり（名前の頭文字を色つきの四角に描く）。描けない環境（テスト）では空。 */
function mockImageMso(names: string[], size: number): Record<string, string | null> {
  if (mockPrefetch.state !== 'done' && mockPrefetch.cached === 0) return {};
  const out: Record<string, string | null> = {};
  for (const name of names) {
    let ctx: CanvasRenderingContext2D | null = null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return {};
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    ctx.fillStyle = `hsl(${hash % 360} 55% 45%)`;
    ctx.fillRect(size * 0.1, size * 0.1, size * 0.8, size * 0.8);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(size * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.slice(0, 1), size / 2, size / 2);
    out[name] = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  }
  return out;
}

/** モックの「マクロを実行中」（本物のホストの ExcelService.IsMacroRunning と同じ振る舞いを確かめるため）。 */
let mockMacroRunning = false;
const mockMacroBusy = () => `${t('Excel でマクロを実行中です（Excel 側でメッセージやエラーを閉じると戻ります）。')} ${t('終わってから、もう一度やり直してください。')}`;
/** 実行中に断る要求（ホストの MessageRouter.ThrowIfMacroRunning を呼ぶもの）。 */
const MOCK_REFUSED_WHILE_MACRO: ReadonlySet<string> = new Set(['excel.apply', 'vba.read', 'vba.insert', 'vba.replaceLine', 'vba.reveal', 'excel.setWindowWidth', 'icons.prefetchStart']);

/** ?excel のときの VBA のダミー（マクロを割り当てる画面の確認用）。 */
const mockVbaModules: VbaModuleDto[] = [
  { name: 'modMain', type: 1, code: ['Public Sub 集計()', 'End Sub', '', 'Public Sub データ出力()', 'End Sub', '', 'Private Sub 内部処理()', 'End Sub', '', 'Public Sub 期間を指定(ByVal 開始 As Date)', 'End Sub', '', 'Public Function 件数() As Long', 'End Function', ''].join('\r\n') },
  { name: 'modUtil', type: 1, code: ['Public Sub 集計()', 'End Sub', '', 'Public Sub 書式を整える()', 'End Sub', ''].join('\r\n') },
  { name: 'Sheet1', type: 100, code: ['Public Sub シートを更新()', 'End Sub', ''].join('\r\n') },
];

/** ブラウザ実行中の退避の置き場（?recovery を付けると、サンプルのブックの退避が残っているものとして始める）。 */
const mockRecoveries = new Map<string, RecoveryEntryDto>();
if (mockParams.has('recovery')) {
  mockRecoveries.set('C:\\sample\\集計ツール.xlam', {
    path: 'C:\\sample\\集計ツール.xlam',
    savedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    editCount: 12,
    parts: [{ version: 'office2010', xml: sampleXml.replace('label="集計ツール"', 'label="集計ツール（編集中）"').replace('<button id="btnClear"', '<button id="btnPaste" label="貼り付け" imageMso="Paste" onAction="Ribbon_btnPaste_onAction" />\n          <button id="btnClear"'), addImages: [], removeImages: [] }],
  });
}

const mock = {
  settings: { theme: 'system', xmlOnTop: false, iconSize: 32, ribbonErrorsHintShown: false, callbackPattern: 'Ribbon_{id}_{attr}', callbackShared: false, callbackSharedPattern: 'Ribbon_{attr}', callbackModule: 'modRibbon', language: lang, iconLibraryPath: t('(ブラウザ実行中)'), updateCheckOnStartup: false, updateSource: '', autoRecovery: true, detectExternalChanges: true } as Settings,
  invoke<K extends keyof HostApi>(type: K, payload: unknown): Promise<HostApi[K]['res']> {
    const r = (v: unknown) => Promise.resolve(v as HostApi[K]['res']);
    if (mockMacroRunning && MOCK_REFUSED_WHILE_MACRO.has(type)) return Promise.reject(new Error(mockMacroBusy()));
    switch (type) {
      case 'app.ready':
        return r({ initialFile: null });
      case 'app.info':
        return r({ version: 'dev', excelInstalled: mockExcel });
      case 'file.open':
        return r({ path: 'C:\\sample\\集計ツール.xlam', parts: [{ version: 'office2010', xml: sampleXml, images: [] }] });
      case 'file.save':
        return mockDelay(1500).then(() => r({ backup: t('(ブラウザ実行中のため保存しません)') }));
      case 'file.exportText': {
        // ブラウザ実行中はダウンロードで代用する
        const p = payload as { defaultName: string; content: string };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([p.content], { type: 'application/json' }));
        a.download = p.defaultName;
        a.click();
        return r(p.defaultName);
      }
      case 'file.recent':
        return r([{ path: 'C:\\sample\\集計ツール.xlam', exists: true }, { path: 'C:\\Users\\you\\Desktop\\古いツール.xlsm', exists: false }]);
      case 'settings.get':
        return r(this.settings);
      case 'settings.set':
        Object.assign(this.settings, payload);
        return r(this.settings);
      case 'excel.openWorkbooks':
        return r(mockExcel ? [{ fullPath: 'C:\\sample\\集計ツール.xlam', isAddIn: true, isDirty: false }, { fullPath: 'C:\\Users\\you\\Documents\\月次レポート.xlsm', isAddIn: false, isDirty: true }] : []);
      case 'excel.apply':
        return mockDelay(1500).then(() => r({ status: 'written', message: t('ブラウザ実行中のため反映しません') }));
      case 'excel.imageMso': {
        const p = payload as { names: string[]; size: number };
        return r(mockImageMso(p.names, p.size));
      }
      case 'excel.labels':
        return r({});
      case 'icons.prefetchStatus':
        return r(mockPrefetchSnapshot());
      case 'icons.prefetchStart': {
        if (!mockExcel) return Promise.reject(new Error(t('Excel が見つからないため、アイコンを取り込めません。')));
        const p = payload as { names: string[]; sizes?: number[] };
        startMockPrefetch(p.names, p.sizes?.length ? p.sizes : [32]);
        return r(mockPrefetchSnapshot());
      }
      case 'icons.prefetchCancel':
        if (mockPrefetch.state === 'running') {
          window.clearInterval(mockPrefetch.timer);
          // 取り込み直しの中止なら、本物のホストと同じく前の記録が残って done になる
          Object.assign(mockPrefetch, {
            state: mockPrefetch.cachedAt ? 'done' : 'none',
            cached: Math.max(mockPrefetch.cached, mockPrefetch.done),
            message: t('取り込みを中止しました。取り込めた分は使えます。'),
            cancelled: true,
          });
          emitMockPrefetch();
        }
        return r(mockPrefetchSnapshot());
      case 'recipes.list':
        return r([]);
      case 'update.status':
        return r({ current: 'dev', checkOnStartup: false, source: 'https://github.com/Yu5rin/Sash', managedByAdmin: false, logPath: '' });
      case 'update.check':
        return r({ status: 'upToDate', current: 'dev', latest: null, notes: null, canInstall: false, reason: null, pageUrl: 'https://github.com/Yu5rin/Sash/releases/latest', source: 'https://github.com/Yu5rin/Sash', managedByAdmin: false });
      case 'library.list':
        return r({ root: t('(ブラウザ実行中)'), icons: [] });
      case 'vba.read':
        // ?excel を付けると、Excel で開いているブックの VBA（引数なしの Sub・Private・引数あり・Function・シートのもの）があるものとして動かせる
        return r(mockExcel ? { status: 'ok', modules: mockVbaModules } : { status: 'noExcel', modules: [] });
      case 'vba.insert':
        return r(true);
      case 'backup.restore':
        return r({ backup: null });
      case 'recovery.write': {
        const p = payload as { path: string; editCount: number; parts: RecoveryPartDto[] };
        mockRecoveries.set(p.path, { path: p.path, savedAt: new Date().toISOString(), editCount: p.editCount, parts: p.parts });
        return r(null);
      }
      case 'recovery.read':
        return r(mockRecoveries.get((payload as { path: string }).path) ?? null);
      case 'recovery.delete':
        mockRecoveries.delete((payload as { path: string }).path);
        return r(null);
      case 'recovery.list':
        return r([...mockRecoveries.values()].map((e): RecoverySummaryDto => ({ path: e.path, savedAt: e.savedAt, editCount: e.editCount, fileExists: true, fileModifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), fileNewer: false })));
      case 'excel.setWindowWidth': {
        // 本物のホストと同じ換算と断り方を確かめられるよう、作業領域は 1920px（100%）とみなす
        const p = payload as { width: number; scale: number };
        const logical = p.width / (p.scale >= 10 ? p.scale / 100 : p.scale);
        if (!mockExcel) return Promise.reject(new Error(t('Excel が見つからないため、ウィンドウの幅を合わせられません。')));
        if (logical > 1920.5) return Promise.reject(new Error(t('幅 {width}px は、Excel のある画面の作業領域（{work}px）より広いため、Excel のウィンドウを合わせられません。', { width: p.width, work: 1920 })));
        return r({ points: Math.round(logical * 0.75 * 100) / 100, logicalWidth: logical, workAreaWidth: 1920, workbook: '集計ツール.xlam', actualWidth: Math.round(logical), expectedWidth: Math.round(logical) });
      }
      case 'excel.runMacro': {
        if (!mockExcel) return Promise.reject(new Error(t('Excel が見つからないため、マクロを実行できません。')));
        if (mockMacroRunning) return Promise.reject(new Error(mockMacroBusy()));
        // 本物のホストと同じく、実行中（MsgBox を閉じるまで）は Excel を使うほかの要求をすぐに断る
        mockMacroRunning = true;
        return mockDelay(2500).then(() => {
          mockMacroRunning = false;
          return r(true);
        });
      }
      case 'vba.reveal':
        return mockExcel ? r(true) : Promise.reject(new Error(t('Excel が見つからないため、VBA を読み書きできません。')));
      case 'backup.list': {
        // ブラウザ実行中の見た目の確認用。ホストは新しい順に返す
        const day = 24 * 60 * 60 * 1000;
        const now = Date.now();
        return r([
          { path: 'C:\\Users\\you\\AppData\\Roaming\\Sash\\backups\\集計ツール_20261123.xlam', createdAt: new Date(now - 60 * 60 * 1000).toISOString(), size: 49102 },
          { path: 'C:\\Users\\you\\AppData\\Roaming\\Sash\\backups\\集計ツール_20261120.xlam', createdAt: new Date(now - 3 * day).toISOString(), size: 48213 },
        ]);
      }
      default:
        return r(null);
    }
  },
};
