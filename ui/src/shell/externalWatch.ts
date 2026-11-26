// 窓に戻ったときに、開いているファイルがほかで書き換えられていないかを調べる（仕様書 §23.4）。
// 自分に未保存の編集がなければ、黙って読み直して知らせる。編集があれば、読み直しはせず、帯（通知）で知らせる。
// 呼び出しは間引く（共有フォルダのブックを窓に戻るたびに読まない）。

import { app, type Session } from '../app';
import { askExternalChange } from '../dialogs/externalChangeDialog';
import { isModalOpen } from '../dialogs/modal';
import { checkExternalChange, isWatchable } from '../externalChange';
import { t } from '../i18n';
import { busyState, flushEdits, openFile, reloadFromDisk } from './fileOps';
import { createPollGate } from './pollGate';
import { splitPath } from './text';
import { toast } from './toast';

/** 窓に戻るたびに読まないよう、間引く間隔（ミリ秒）。 */
export const EXTERNAL_WATCH_MIN_INTERVAL_MS = 30000;

/** 通知した状態（ファイルの照合値）。同じ状態で何度も知らせない。 */
const notified = new WeakMap<Session, string>();

async function run(): Promise<void> {
  const s = app.session;
  // ダイアログを開いている間や、保存・反映の最中は調べない（次に窓へ戻ったときに調べる）
  if (!isWatchable(s) || isModalOpen() || busyState() !== null) return;
  // 入力中の欄を確定してから、編集の有無を見る（確定前の入力を「編集なし」と取り違えて、読み直しで捨てないように）
  flushEdits();
  const { state, current } = await checkExternalChange(s);
  if (state !== 'changed' || app.session !== s || isModalOpen()) return;
  const name = splitPath(s.path).name;
  // 照合している間にも編集が入りうるので、読み直す直前にもう一度見る
  flushEdits();
  if (!app.dirty) {
    // 自分の編集がないので、失うものがない。黙って読み直す
    if (await openFile(s.path, { force: true })) toast({ kind: 'info', message: t('「{file}」がほかで変更されたため、読み直しました', { file: name }) });
    return;
  }
  const key = JSON.stringify(current);
  if (notified.get(s) === key) return;
  notified.set(s, key);
  toast({
    kind: 'warning',
    timeout: 0,
    message: t('「{file}」のリボンが、開いたあとにほかで変更されています。保存すると、ほかの変更を上書きします', { file: name }),
    action: { label: t('確認する'), run: () => void review(s) },
  });
}

/** 通知の［確認する］。ほかの変更を読み込む（自分の編集は捨てる）か、あとにする。 */
async function review(s: Session): Promise<void> {
  if (app.session !== s) return;
  if ((await askExternalChange(s, 'focus')) === 'reload') await reloadFromDisk(s);
}

/** 窓に戻ったときに呼ぶ関数を作る。force を付けると間引きを飛ばす。 */
export function createExternalWatcher(minIntervalMs = EXTERNAL_WATCH_MIN_INTERVAL_MS): (force?: boolean) => Promise<void> {
  return createPollGate(run, { minIntervalMs, busy: () => busyState() !== null });
}
