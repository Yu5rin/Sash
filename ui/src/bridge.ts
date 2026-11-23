// ホスト（C#）とのメッセージ交換。src/Sash.App/MessageRouter.cs と対応させる。

import { lang, t } from './i18n';

export type CustomUIVersion = 'office2007' | 'office2010';

export interface AppInfo {
  version: string;
  excelInstalled: boolean;
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

/** 要求の種類ごとの payload と応答の型。 */
export interface HostApi {
  'app.ready': { req: undefined; res: { initialFile: string | null; updatedFrom?: string | null; version?: string } };
  'app.info': { req: undefined; res: AppInfo };
  'app.close': { req: undefined; res: null };
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
  'recipes.list': { req: undefined; res: unknown[] };
  'recipes.save': { req: Record<string, unknown>; res: null };
  'recipes.delete': { req: { id: string }; res: null };
  'backup.list': { req: { path: string }; res: BackupEntry[] };
  /** バックアップの中身でファイルを置き換える。backup は戻す直前の今のファイルのバックアップ。終わったら UI は開き直す。 */
  'backup.restore': { req: { path: string; backupPath: string }; res: { backup: string | null } };
  'vba.read': { req: { path: string }; res: { status: VbaReadStatus; modules: VbaModuleDto[] } };
  'vba.insert': { req: { path: string; module: string; code: string; documentModule: boolean }; res: boolean };
  'vba.replaceLine': { req: { path: string; module: string; line: number; expected: string; replacement: string }; res: boolean };
}

/** ホストから届く通知。 */
export type HostEvent =
  | { event: 'closeRequested' }
  | { event: 'fileDropped'; path: string };

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

const mock = {
  settings: { theme: 'system', xmlOnTop: false, iconSize: 32, ribbonErrorsHintShown: false, callbackPattern: 'Ribbon_{id}_{attr}', callbackShared: false, callbackSharedPattern: 'Ribbon_{attr}', callbackModule: 'modRibbon', language: lang, iconLibraryPath: t('(ブラウザ実行中)'), updateCheckOnStartup: false, updateSource: '' } as Settings,
  invoke<K extends keyof HostApi>(type: K, payload: unknown): Promise<HostApi[K]['res']> {
    const r = (v: unknown) => Promise.resolve(v as HostApi[K]['res']);
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
      case 'excel.imageMso':
      case 'excel.labels':
        return r({});
      case 'recipes.list':
        return r([]);
      case 'update.status':
        return r({ current: 'dev', checkOnStartup: false, source: 'https://github.com/Yu5rin/Sash', managedByAdmin: false, logPath: '' });
      case 'update.check':
        return r({ status: 'upToDate', current: 'dev', latest: null, notes: null, canInstall: false, reason: null, pageUrl: 'https://github.com/Yu5rin/Sash/releases/latest', source: 'https://github.com/Yu5rin/Sash', managedByAdmin: false });
      case 'library.list':
        return r({ root: t('(ブラウザ実行中)'), icons: [] });
      case 'vba.read':
        return r({ status: 'noExcel', modules: [] });
      case 'backup.restore':
        return r({ backup: null });
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
