// ホスト（C#）とのメッセージ交換。src/Sash.App/MessageRouter.cs と対応させる。

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
}

export type VbaReadStatus = 'ok' | 'notOpen' | 'trustDenied' | 'locked' | 'noExcel';

export interface VbaModuleDto {
  name: string;
  type: number;
  code: string;
}

/** 要求の種類ごとの payload と応答の型。 */
export interface HostApi {
  'app.ready': { req: undefined; res: { initialFile: string | null } };
  'app.info': { req: undefined; res: AppInfo };
  'app.close': { req: undefined; res: null };
  'file.open': { req: { path?: string } | undefined; res: OpenedDocument | null };
  'file.save': { req: { path: string; parts: PartToSave[] }; res: { backup: string } };
  'file.recent': { req: undefined; res: RecentFile[] };
  'file.removeRecent': { req: { path: string }; res: null };
  'settings.get': { req: undefined; res: Settings };
  'settings.set': { req: Partial<Settings>; res: Settings };
  'excel.openWorkbooks': { req: undefined; res: OpenWorkbook[] };
  'excel.apply': { req: { path: string; parts: PartToSave[]; saveIfDirty: boolean }; res: ApplyResult };
  'excel.imageMso': { req: { names: string[]; size: number }; res: Record<string, string | null> };
  'excel.labels': { req: { ids: string[] }; res: Record<string, string> };
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
  else p.reject(new Error(data.error ?? '不明なエラー'));
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

const mock = {
  settings: { theme: 'system', xmlOnTop: false, iconSize: 32, ribbonErrorsHintShown: false, callbackPattern: 'Ribbon_{id}_{attr}', callbackShared: false, callbackSharedPattern: 'Ribbon_{attr}', callbackModule: 'modRibbon' } as Settings,
  invoke<K extends keyof HostApi>(type: K, payload: unknown): Promise<HostApi[K]['res']> {
    const r = (v: unknown) => Promise.resolve(v as HostApi[K]['res']);
    switch (type) {
      case 'app.ready':
        return r({ initialFile: null });
      case 'app.info':
        return r({ version: 'dev', excelInstalled: false });
      case 'file.open':
        return r({ path: 'C:\\sample\\集計ツール.xlam', parts: [{ version: 'office2010', xml: sampleXml, images: [] }] });
      case 'file.save':
        return r({ backup: '(ブラウザ実行中のため保存しません)' });
      case 'file.recent':
        return r([{ path: 'C:\\sample\\集計ツール.xlam', exists: true }]);
      case 'settings.get':
        return r(this.settings);
      case 'settings.set':
        Object.assign(this.settings, payload);
        return r(this.settings);
      case 'excel.openWorkbooks':
        return r([]);
      case 'excel.apply':
        return r({ status: 'written', message: 'ブラウザ実行中のため反映しません' });
      case 'excel.imageMso':
      case 'excel.labels':
        return r({});
      case 'vba.read':
        return r({ status: 'noExcel', modules: [] });
      default:
        return r(null);
    }
  },
};
