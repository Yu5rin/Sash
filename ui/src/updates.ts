// 更新の確認と入れ替え（Graft・Pane と同じ考え方）。確認と照合と入れ替えはホストが行い、ここは案内だけを担う。
// 起動時の確認で新しい版が見つかってもダイアログは出さず、タイトルバーに控えめに知らせる。

import { invoke, type UpdateCheckResult, type UpdateStatus } from './bridge';
import { ask, openModal, openOnce } from './dialogs/modal';
import { $, h } from './dom';
import { t } from './i18n';
import { discardCurrentRecovery, rescheduleRecovery } from './recovery';
import { checkbox, settingRow } from './shell/form';
import { toast as showToast, type ToastKind } from './shell/toast';

type Toast = (message: string, kind?: ToastKind) => void;

let confirmDiscard: () => Promise<boolean> = async () => true;
let toast: Toast = (message, kind) => showToast({ kind, message });
/** 確認中・入れ替え中か。二重に走らせない。 */
let checking = false;

export function initUpdates(opts: { confirmDiscard: () => Promise<boolean>; toast?: Toast }): void {
  confirmDiscard = opts.confirmDiscard;
  if (opts.toast) toast = opts.toast;
  $('update-banner').addEventListener('click', () => void checkForUpdates(true));
}

function showBanner(result: UpdateCheckResult | null): void {
  const banner = $<HTMLButtonElement>('update-banner');
  banner.hidden = !result || result.status !== 'available';
  if (result?.latest) {
    banner.textContent = t('新しい版 {version} があります', { version: result.latest });
    banner.title = t('クリックして更新の内容を確認');
  }
}

/** 起動時の確認。見つかってもダイアログは出さず、タイトルバーに知らせるだけにする。 */
export async function checkOnStartup(): Promise<void> {
  try {
    const status = await invoke('update.status');
    if (!status.checkOnStartup) return;
    const result = await invoke('update.check');
    showBanner(result);
  } catch {
    // 起動時の確認の失敗は知らせない（ログには残る）
  }
}

/** 手動の確認。見つかれば、更新するかを確かめる。 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    await openOnce('update', () => runCheck(manual));
  } finally {
    checking = false;
  }
}

async function runCheck(manual: boolean): Promise<void> {
  let result: UpdateCheckResult;
  const progress = manual ? showToast({ kind: 'info', message: t('更新を確認しています…'), timeout: 0 }) : null;
  try {
    result = await invoke('update.check');
  } catch (e) {
    progress?.update({ kind: 'error', message: t('更新を確認できませんでした：{message}', { message: (e as Error).message }) });
    return;
  }
  progress?.close();
  showBanner(result);
  if (result.status === 'upToDate') {
    if (manual) toast(t('最新の版です（{version}）', { version: result.current }), 'success');
    return;
  }
  if (result.status !== 'available') {
    if (manual) toast(result.reason ?? t('更新を確認できませんでした'), result.status === 'disabled' ? 'info' : 'error');
    return;
  }

  const lines = [t('いまの版：{current}　新しい版：{latest}', { current: result.current, latest: result.latest ?? '' })];
  if (result.notes) lines.push(result.notes);
  if (!result.canInstall && result.reason) lines.push(result.reason);
  else lines.push(t('ダウンロードして照合（SHA256）してから入れ替え、Sash を再起動します。設定やアイコンライブラリはそのまま残ります。'));
  const buttons = result.canInstall
    ? [{ value: 'later', label: t('あとで') }, { value: 'page', label: t('配布元を開く') }, { value: 'install', label: t('今すぐ更新'), primary: true }]
    : [{ value: 'later', label: t('あとで') }, { value: 'page', label: t('配布元を開く'), primary: true }];
  const r = await ask(t('新しい版があります'), lines.join('\n\n'), buttons as { value: string; label: string; primary?: boolean }[]);
  if (r === 'page' && result.pageUrl) {
    await invoke('update.openPage', { url: result.pageUrl }).catch((e: Error) => toast(e.message, 'error'));
  } else if (r === 'install') {
    await install();
  }
}

async function install(): Promise<void> {
  if (!(await confirmDiscard())) return;
  // 保存した・「保存しない」を選んだので、残す編集はない。退避も消す（再起動のあとに、捨てた編集の復旧を聞かないように）
  await discardCurrentRecovery();
  // 入れ替えの途中で閉じられると、ダウンロードだけが裏で続いて分かりにくいので、閉じられないようにする
  const progress = openModal(t('更新しています'), h('div', { class: 'update-progress' },
    h('p', { class: 'modal-message' }, t('ダウンロードと照合をしています。終わると Sash が再起動します…')),
    h('progress', { 'aria-label': t('更新しています') })), { size: 'sm', closable: false, key: 'update-install' });
  try {
    await invoke('update.install');
  } catch (e) {
    progress.close();
    // 更新をやめて編集を続けることになったので、退避をまた取る
    rescheduleRecovery();
    toast(t('更新できませんでした：{message}', { message: (e as Error).message }), 'error');
  }
}

/** 設定画面の「更新」欄。 */
export async function renderUpdateSettings(onChange: (patch: { updateCheckOnStartup?: boolean; updateSource?: string }) => Promise<void>, current: { updateCheckOnStartup: boolean; updateSource: string }): Promise<HTMLElement> {
  let status: UpdateStatus | null = null;
  try {
    status = await invoke('update.status');
  } catch {
    status = null;
  }
  const managed = status?.managedByAdmin ?? false;
  const source = h('input', { type: 'text', value: current.updateSource, placeholder: t('空欄で GitHub のリリース'), spellcheck: false, disabled: managed });
  const error = h('span', { class: 'field-error', role: 'alert' });
  source.addEventListener('change', () => {
    error.textContent = '';
    void onChange({ updateSource: source.value.trim() }).catch((e: Error) => (error.textContent = e.message));
  });
  return h(
    'div',
    { class: 'settings-group' },
    managed ? h('p', { class: 'notice' }, t('確認先は管理者の設定（Sash.update.json）で決められています：{source}', { source: status?.source ?? '' })) : null,
    settingRow(t('いまの版'), h('span', { class: 'setting-row' }, status?.current ?? '')),
    settingRow(t('起動時に確認'), checkbox(t('起動したときに新しい版があるかを確認する'), status?.checkOnStartup ?? current.updateCheckOnStartup, (v) => void onChange({ updateCheckOnStartup: v }), { disabled: managed }),
      t('見つかったときは、タイトルバーに小さく知らせるだけで、勝手には入れ替えません。')),
    settingRow(t('確認先'), h('div', { class: 'setting-control' }, source, error),
      t('会社のネットワークからインターネットに出られない場合は、社内の共有フォルダ（例：\\\\server\\tools\\Sash）や、社内の Web サーバーの latest.json の URL を指定できます。')),
    h('div', { class: 'setting-row' },
      h('button', { type: 'button', onclick: () => void checkForUpdates(true) }, t('今すぐ確認')),
      status?.logPath ? h('button', { type: 'button', onclick: () => void invoke('update.openPage', { url: status!.logPath.replace(/[\\/][^\\/]+$/, '') }).catch((e: Error) => toast(e.message, 'error')) }, t('ログのフォルダを開く')) : null),
  );
}

/** 更新したあとの最初の起動で知らせる。 */
export function notifyUpdated(from: string | null | undefined, to: string | undefined): void {
  if (from) toast(t('Sash を {from} から {to} に更新しました', { from, to: to ?? '' }), 'success');
}
