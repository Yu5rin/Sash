// 同梱のサンプル（ホーム画面の「サンプルを開いて試す」）。
// Excel のファイルがなくても、リボンの編集を試せるようにする。ファイルに結びつかない（パスのない）セッションとして開き、
// 保存先がないので保存・反映はできない（そのことを知らせる処理は fileOps 側が isSampleSession で判断する）。

import { app } from './app';
import type { OpenedDocument } from './bridge';
import { notify } from './clipboard';
import { t } from './i18n';
import { NAMESPACES } from './schema';
import { busyState, confirmDiscard } from './shell/fileOps';
import { focus as focusCanvas } from './views/canvas';

/** サンプルのセッションのパス。空にしておき、ファイルを開いたセッションと区別する。 */
export const SAMPLE_PATH = '';

/**
 * サンプルの customUI14。よく使う形（大きいボタン・小さいボタン・メニュー・切り替えボタン・VBA で状態を返すボタン）を
 * 一通り入れ、Lint のエラーが出ないものにする（最初に見せるものが赤い印だらけだと、壊れているように見えるため）。
 * 日本語の文言は、英語の画面でもサンプルの中身としてそのまま見せる（中身は利用者のデータと同じ扱いで、訳さない）。
 */
export function sampleXml(): string {
  return `<customUI xmlns="${NAMESPACES.office2010}" onLoad="Ribbon_onLoad">
  <ribbon>
    <tabs>
      <!-- 自分で作るタブ。id は自分で付ける -->
      <tab id="tabSample" label="サンプル" keytip="Y">
        <group id="grpReport" label="レポート">
          <button id="btnRun" label="集計する" size="large" imageMso="AutoSum" screentip="集計する" supertip="選んだ範囲を集計して、新しいシートに書き出します。" onAction="Ribbon_btnRun_onAction" />
          <button id="btnCsv" label="CSV出力" imageMso="ExportTextFile" onAction="Ribbon_btnCsv_onAction" />
          <button id="btnClear" label="クリア" imageMso="Clear" onAction="Ribbon_btnClear_onAction" />
          <button id="btnPrint" label="印刷" imageMso="FilePrint" getEnabled="Ribbon_btnPrint_getEnabled" onAction="Ribbon_btnPrint_onAction" />
        </group>
        <group id="grpTools" label="ツール">
          <menu id="mnuTools" label="ツール" size="large" imageMso="ControlsGallery">
            <button id="btnSort" label="並べ替え" imageMso="SortDialog" onAction="Ribbon_btnSort_onAction" />
            <button id="btnFilter" label="フィルター" imageMso="Filter" onAction="Ribbon_btnFilter_onAction" />
            <menuSeparator id="sepTools" />
            <button id="btnAbout" label="このツールについて" onAction="Ribbon_btnAbout_onAction" />
          </menu>
          <toggleButton id="tglAuto" label="自動更新" size="large" imageMso="Refresh" getPressed="Ribbon_tglAuto_getPressed" onAction="Ribbon_tglAuto_onAction" />
          <button id="btnAdmin" label="管理者用" imageMso="ControlProperties" getVisible="Ribbon_btnAdmin_getVisible" onAction="Ribbon_btnAdmin_onAction" />
        </group>
      </tab>
      <!-- 組み込みのタブ（ホーム）にグループを足す例。idMso で組み込みのものを指す -->
      <tab idMso="TabHome">
        <group id="grpQuick" label="よく使う" insertAfterMso="GroupClipboard">
          <button id="btnPasteValues" label="値の貼り付け" imageMso="PasteValues" onAction="Ribbon_btnPasteValues_onAction" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;
}

/** サンプルを、ホストから受け取ったファイルと同じ形で返す（app.open にそのまま渡せる）。 */
export function sampleDocument(): OpenedDocument {
  return { path: SAMPLE_PATH, parts: [{ version: 'office2010', xml: sampleXml(), images: [] }] };
}

/** いま開いているのがサンプルか（保存先のファイルがないセッションか）。 */
export function isSampleSession(): boolean {
  return app.session !== null && app.session.path === SAMPLE_PATH;
}

/**
 * サンプルを開く。編集中のファイルに未保存の変更があれば、先に確かめる。
 * 開いたら、保存できないことを通知で伝える（あとで保存しようとして初めて知ると、作り込んだものの行き場がないため）。
 */
export async function openSample(): Promise<boolean> {
  if (busyState() !== null) return false;
  if (!(await confirmDiscard())) return false;
  app.open(sampleDocument());
  focusCanvas();
  notify({ kind: 'info', message: t('サンプルを開きました。自由に試せますが、保存はできません。自分のブックで作るときは、Excel で保存した .xlsm / .xlam を開いてください') });
  return true;
}
