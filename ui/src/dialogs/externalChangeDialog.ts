// 「ほかで変更されています」の確認（仕様書 §23.4）。保存・反映の前と、窓に戻ったときに出す。

import { app, type Session } from '../app';
import { invoke } from '../bridge';
import { h } from '../dom';
import { t } from '../i18n';
import { splitPath } from '../shell/text';
import { toast } from '../shell/toast';
import { openDiffViews } from './diffDialog';
import { openModal } from './modal';

export type ExternalChoice =
  /** 自分の編集で上書きする（そのまま書き込みを続ける）。 */
  | 'overwrite'
  /** ほかの変更を読み込む（自分の編集は捨てる）。 */
  | 'reload'
  | 'cancel';

/** 開いたときの内容（左）と、いまのファイルの内容（右）を並べて見る。ほかで何が変わったかが分かる。 */
export async function openExternalDiff(s: Session): Promise<void> {
  try {
    const disk = await invoke('file.read', { path: s.path });
    if (!disk || app.session !== s) return;
    openDiffViews({
      title: t('ほかで変更された内容との差分'),
      key: 'externalDiff',
      legend: t('赤：開いたときにあって、いまのファイルでは消えている行　緑：ほかで追加・変更された行'),
      sameText: t('開いたときの内容と同じです'),
      imageLabels: { added: t('ほかで追加・差し替えられた画像：{list}'), removed: t('ほかで削除された画像：{list}') },
      views: disk.parts.map((p) => {
        const mine = s.parts.get(p.version);
        // 画像は、開いたときの Id と、いまのファイルの Id を比べる（Id が振り直されたときは、そのまま差として出る）
        const before = new Set([...(mine?.images.keys() ?? [])]);
        const after = new Set(p.images.map((i) => i.id));
        return {
          version: p.version,
          left: mine?.savedXml ?? '',
          right: p.xml,
          addedImages: [...after].filter((id) => !before.has(id)),
          removedImages: [...before].filter((id) => !after.has(id)),
        };
      }),
    });
  } catch (e) {
    toast({ kind: 'error', message: t('ファイルの内容を読めませんでした：{message}', { message: (e as Error).message }) });
  }
}

/**
 * 確認を出す。context が save / apply のときは、自分の編集で上書きして続けられる（［保存する］［反映する］の延長）。
 * focus（窓に戻ったとき）は、書き込みの途中ではないので、［上書き］は出さず、［読み込む］か［閉じる］だけにする。
 */
export function askExternalChange(s: Session, context: 'save' | 'apply' | 'focus'): Promise<ExternalChoice> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (c: ExternalChoice) => {
      answered = true;
      resolve(c);
      handle.close();
    };
    const name = splitPath(s.path).name;
    const dirty = app.dirty;
    const body = h('div', { class: 'external-dialog' },
      h('p', { class: 'modal-message' }, t('「{file}」のリボンは、開いたあとにほかで変更されています（Excel や別の人が保存した可能性があります）。', { file: name })),
      h('p', { class: 'muted' }, dirty
        ? t('［上書き］では、自分の編集でほかの変更を上書きして失います。［ほかの変更を読み込む］では、ここまでの編集を捨てます。')
        : t('ここまでの編集はありません。読み込み直すと、ほかの変更が反映されます。')));
    const diff = h('button', { type: 'button', class: 'footer-start', onclick: () => void openExternalDiff(s) }, t('差分を見る…'));
    const overwrite = h('button', { type: 'button', class: 'danger', onclick: () => answer('overwrite') }, context === 'apply' ? t('上書きして反映') : t('上書きして保存'));
    const reload = h('button', { type: 'button', class: dirty ? '' : 'primary', onclick: () => answer('reload') }, dirty ? t('ほかの変更を読み込む') : t('読み込み直す'));
    const cancel = h('button', { type: 'button', class: dirty ? 'primary' : '', 'data-role': 'cancel', onclick: () => answer('cancel') }, context === 'focus' ? t('あとで') : t('キャンセル'));
    const handle = openModal(t('ほかで変更されています'), body, {
      size: 'md',
      key: 'externalChange',
      closable: true,
      footer: [diff, ...(context === 'focus' ? [] : [overwrite]), reload, cancel],
      // 危ないほうを既定にしない。編集があるときは［キャンセル］、なければ［読み込み直す］に置く
      initialFocus: dirty ? cancel : reload,
      onClose: () => {
        if (!answered) resolve('cancel');
      },
    });
    // ボタンが 4 つ並ぶので、ふつうの確認より広げる
    handle.root.classList.add('ext-change');
  });
}
