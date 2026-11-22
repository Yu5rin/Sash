// ホスト（C#）とのメッセージ交換。src/Sash.App/HostMessages.cs の型と対応させる。

export type CustomUIVersion = 'office2007' | 'office2010';

export interface AppInfo {
  version: string;
  excelInstalled: boolean;
}

export interface CustomUIPartDto {
  version: CustomUIVersion;
  partUri: string;
  xml: string;
  images: { id: string; partUri: string }[];
}

export interface OpenedDocument {
  path: string;
  hasBothVersions: boolean;
  parts: CustomUIPartDto[];
}

/** 要求の種類ごとの payload と応答の型。 */
export interface HostApi {
  'app.ready': { req: undefined; res: { initialFile: string | null } };
  'app.info': { req: undefined; res: AppInfo };
  'file.open': { req: { path?: string } | undefined; res: OpenedDocument | null };
  'file.save': { req: { path: string; version: CustomUIVersion; xml: string }; res: { backup: string } };
}

interface HostResponse {
  id: number;
  ok: boolean;
  payload: unknown;
  error: string | null;
}

interface WebView {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<HostResponse>) => void): void;
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

webview?.addEventListener('message', (e) => {
  const res = e.data;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  if (res.ok) p.resolve(res.payload);
  else p.reject(new Error(res.error ?? '不明なエラー'));
});

export function invoke<K extends keyof HostApi>(type: K, payload?: HostApi[K]['req']): Promise<HostApi[K]['res']> {
  if (!webview) return mockInvoke(type);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    webview.postMessage({ id, type, payload: payload ?? null });
  });
}

// ブラウザ単体で UI を確認するためのダミー応答
const sampleXml = `<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui">
  <ribbon>
    <tabs>
      <tab id="tabTools" label="集計ツール">
        <group id="grpSum" label="集計">
          <button id="btnSummary" label="集計する" size="large" imageMso="AutoSum" onAction="Ribbon_btnSummary_onAction" />
          <button id="btnCsv" label="CSV出力" imageMso="ExportTextFile" onAction="Ribbon_btnCsv_onAction" />
          <button id="btnClear" label="クリア" imageMso="Clear" onAction="Ribbon_btnClear_onAction" />
        </group>
        <group id="grpMode" label="モード">
          <toggleButton id="tglAuto" label="自動" size="large" imageMso="AutoFilter" onAction="Ribbon_tglAuto_onAction" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>`;

function mockInvoke<K extends keyof HostApi>(type: K): Promise<HostApi[K]['res']> {
  const responses: { [P in keyof HostApi]: HostApi[P]['res'] } = {
    'app.ready': { initialFile: null },
    'app.info': { version: 'dev', excelInstalled: false },
    'file.open': {
      path: 'C:\\sample\\集計ツール.xlam',
      hasBothVersions: false,
      parts: [{ version: 'office2010', partUri: '/customUI/customUI14.xml', xml: sampleXml, images: [] }],
    },
    'file.save': { backup: '(ブラウザ実行中のため保存しません)' },
  };
  return Promise.resolve(responses[type]);
}
