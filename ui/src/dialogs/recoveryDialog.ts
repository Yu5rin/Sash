// 未保存の編集の復旧を確かめるダイアログ（仕様書 §23.2）。ファイルを開いたとき、退避が残っていれば出す。
// 閉じる（Esc・×）では決めない。「いつか捨ててしまう」「勝手に残る」のどちらも避けるため、3 つの選択肢から選んでもらう。
// 差分は、ファイルの中身（左）と退避した編集（右）を並べて見られる。

import { app } from '../app';
import type { RecoveryEntryDto } from '../bridge';
import { h } from '../dom';
import { lang, t } from '../i18n';
import { splitPath } from '../shell/text';
import { openDiffViews } from './diffDialog';
import { openModal } from './modal';

export type RecoveryChoice = 'restore' | 'discard';

/** 日時の表示（例：2026/11/26 14:32）。読めなければ元の文字列。 */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'en' ? 'en-US' : 'ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 退避と、いま開いているファイルの内容を比べる（左がファイル、右が退避した編集）。 */
export function openRecoveryDiff(entry: RecoveryEntryDto): void {
  const s = app.session;
  if (!s) return;
  openDiffViews({
    title: t('復旧する内容との差分'),
    key: 'recoveryDiff',
    legend: t('赤：ファイルにあって、退避した編集では消えている行　緑：退避した編集で追加・変更した行'),
    sameText: t('ファイルの内容と同じです'),
    imageLabels: { added: t('復旧で追加・差し替える画像：{list}'), removed: t('復旧で削除する画像：{list}') },
    views: entry.parts.map((p) => {
      const store = s.parts.get(p.version);
      return {
        version: p.version,
        left: store?.savedXml ?? '',
        right: p.xml,
        addedImages: p.addImages.map((i) => i.id),
        removedImages: p.removeImages,
      };
    }),
  });
}

/** 復旧するか捨てるかを聞く。 */
export function askRecovery(entry: RecoveryEntryDto): Promise<RecoveryChoice> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (c: RecoveryChoice) => {
      answered = true;
      resolve(c);
      handle.close();
    };
    const name = splitPath(entry.path).name;
    const body = h('div', { class: 'recovery-dialog' },
      h('p', { class: 'modal-message' }, t('「{file}」には、前回の終了までに保存されなかった編集があります（{when}・{n} 回の編集）。復旧すると、保存前の状態で開きます。', { file: name, when: formatWhen(entry.savedAt), n: entry.editCount })),
      entry.fileNewer
        ? h('p', { class: 'recovery-warn', role: 'note' }, t('このブックは、退避したあとに別の場所で保存されています（Excel など）。復旧すると、そのあとの変更の上に退避した編集を重ねます。差分を見てから選んでください。'))
        : null,
      h('p', { class: 'muted' }, t('復旧した内容は未保存の状態で開きます。元に戻す（Ctrl+Z）で、開いた直後の状態に戻せます。')));
    const restore = h('button', { type: 'button', class: 'primary', onclick: () => answer('restore') }, t('復旧する'));
    const diff = h('button', { type: 'button', class: 'footer-start', onclick: () => openRecoveryDiff(entry) }, t('差分を見る…'));
    const discard = h('button', { type: 'button', class: 'danger', onclick: () => answer('discard') }, t('捨てる'));
    const handle = openModal(t('保存されなかった編集があります'), body, {
      size: 'sm',
      key: 'recovery',
      // 決めずに閉じられると、退避を残したまま新しい編集で上書きしてしまう。3 つのどれかを選んでもらう
      closable: false,
      footer: [diff, discard, restore],
      initialFocus: restore,
      onClose: () => {
        if (!answered) resolve('discard');
      },
    });
  });
}
