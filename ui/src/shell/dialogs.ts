// シェルのダイアログ：バックアップから復元、キーボードショートカット一覧、バージョン情報。

import { app } from '../app';
import { invoke, type BackupEntry } from '../bridge';
import { ask, openModal, openOnce } from '../dialogs/modal';
import type { Command } from '../dialogs/commandPalette';
import { h, svg } from '../dom';
import { lang, t } from '../i18n';
import { restoreBackup } from './fileOps';
import { shellIcons } from './icons';
import { formatSize, splitPath } from './text';
import { toast } from './toast';

export const REPO_URL = 'https://github.com/Yu5rin/Sash';
export const RELEASES_URL = 'https://github.com/Yu5rin/Sash/releases';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'en' ? 'en-US' : 'ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 開いているファイルのバックアップを新しい順に並べ、選んだもので戻す。 */
export function openBackupDialog(): Promise<void> {
  return openOnce('backup', async () => {
    const s = app.session;
    if (!s) return;
    let list: BackupEntry[];
    try {
      list = await invoke('backup.list', { path: s.path });
    } catch (e) {
      toast({ kind: 'error', message: t('バックアップの一覧を取得できませんでした：{message}', { message: (e as Error).message }) });
      return;
    }
    // ホストは新しい順に返すが、念のためここでも並べ直す（表示の順番を UI の責任にしておく）
    list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const file = splitPath(s.path).name;
    const body = list.length === 0
      ? h('div', { class: 'empty-state' }, h('strong', null, t('「{file}」のバックアップはまだありません', { file })), h('span', null, t('保存と反映のたびに、書き込む前のファイルをバックアップします。')))
      : h('div', null,
          h('p', { class: 'modal-message' }, t('「{file}」を、選んだバックアップの時点の内容に戻します。', { file })),
          h('table', { class: 'data-table' },
            h('thead', null, h('tr', null, h('th', null, t('日時')), h('th', null, t('サイズ')), h('th', null, ''))),
            h('tbody', null, list.map((b, i) =>
              h('tr', { title: b.path },
                h('td', null, formatDate(b.createdAt), i === 0 ? h('span', { class: 'badge-soft', style: 'margin-left:8px' }, t('最新')) : null),
                h('td', { class: 'num' }, formatSize(b.size)),
                h('td', { class: 'actions' }, h('button', { type: 'button', class: 'small', onclick: () => void restore(b) }, svg(shellIcons.restore), t('復元'))))))));
    const m = openModal(t('バックアップから復元'), body, { size: 'lg', key: 'backup', footer: [h('button', { type: 'button', onclick: () => m.close() }, t('閉じる'))] });
    m.root.classList.remove('wide');
    m.root.style.height = 'auto';

    const restore = async (b: BackupEntry) => {
      const warn = app.dirty ? t('保存していない変更は失われます。') : '';
      const r = await ask(t('バックアップから復元'), t('「{file}」を {date} の内容に戻します。今のファイルも戻す前にバックアップします。{warn}', { file, date: formatDate(b.createdAt), warn }), [
        { value: 'cancel', label: t('キャンセル') },
        { value: 'go', label: t('復元する'), primary: true },
      ]);
      if (r !== 'go') return;
      m.close();
      await restoreBackup(b.path);
    };
  });
}

/** ショートカットのうち、コマンドにならないもの（キャンバス・ツリーでの操作、ペインの移動、メニューの操作）。 */
function extraShortcuts(): { group: string; title: string; keys: string }[] {
  return [
    // キャンバスとツリーが自分で受けるキー（メニューのコマンドにはないので、ここで載せる）
    { group: t('編集'), title: t('上へ移動'), keys: 'Alt+↑' },
    { group: t('編集'), title: t('下へ移動'), keys: 'Alt+↓' },
    { group: t('編集'), title: t('ラベルを編集'), keys: 'F2' },
    { group: t('編集'), title: t('インスペクタでラベルを編集'), keys: 'Enter' },
    { group: t('編集'), title: t('右クリックメニューを開く'), keys: 'Shift+F10' },
    { group: t('表示'), title: t('次のペインへ移る'), keys: 'F6' },
    { group: t('表示'), title: t('前のペインへ移る'), keys: 'Shift+F6' },
    { group: t('メニュー'), title: t('メニューバーへ移る'), keys: 'Alt / F10' },
    { group: t('メニュー'), title: t('メニューを直接開く'), keys: 'Alt+F / E / V / I / T / H' },
    { group: t('メニュー'), title: t('メニュー・ダイアログを閉じる'), keys: 'Esc' },
    { group: t('メニュー'), title: t('ダイアログの主ボタンを押す'), keys: 'Enter' },
  ];
}

/** キーボードショートカットの一覧。コマンドの定義から作るので、メニューと食い違わない。 */
export function openShortcutsDialog(commands: readonly Command[]): void {
  const rows = [
    ...commands.filter((c) => c.shortcut).map((c) => ({ group: c.group, title: c.title, keys: c.shortcut! })),
    ...extraShortcuts(),
  ];
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    // 同じキーを 2 回出さない（同じ操作の別名など）
    if (!groups.get(r.group)!.some((x) => x.keys === r.keys)) groups.get(r.group)!.push(r);
  }
  const content = h('div', { class: 'shortcut-groups' }, [...groups].map(([g, list]) =>
    h('section', null, h('h3', null, g), h('dl', { class: 'shortcut-list' }, list.flatMap((r) => [h('dt', null, r.title), h('dd', null, h('kbd', null, r.keys))])))));
  const m = openModal(t('キーボードショートカット'), content, { size: 'lg', key: 'shortcuts', footer: [h('button', { type: 'button', class: 'primary', onclick: () => m.close() }, t('閉じる'))] });
}

/** バージョン情報。 */
export function openAboutDialog(): void {
  const link = (url: string, label: string, cls = 'link') => h('button', { type: 'button', class: cls, onclick: () => void invoke('update.openPage', { url }).catch((e: Error) => toast({ kind: 'error', message: e.message })) }, label);
  const content = h('div', { class: 'about' },
    h('div', { class: 'about-head' }, h('span', { class: 'brand-mark' }), h('div', null, h('h3', null, 'Sash'), h('div', { class: 'muted' }, t('Excel のリボン（customUI）を、見たまま作って直せるエディタ')))),
    h('dl', null,
      h('dt', null, t('バージョン')), h('dd', null, app.info.version || '-'),
      h('dt', null, 'Excel'), h('dd', null, app.info.excelInstalled ? t('見つかりました') : t('見つかりません（ファイルの編集のみ）')),
      h('dt', null, t('ライセンス')), h('dd', null, 'MIT License'),
      h('dt', null, t('配布元')), h('dd', null, link(REPO_URL, 'github.com/Yu5rin/Sash'))),
    h('p', { class: 'muted small' }, t('idMso / imageMso の一覧は、Microsoft の office-fluent-ui-command-identifiers（MIT License）を元にしています。')),
    h('p', { class: 'muted small' }, t('アイコン集は、Microsoft の Fluent UI System Icons（MIT License）を元にしています。')));
  const m = openModal(t('バージョン情報'), content, { size: 'sm', key: 'about', footer: [link(RELEASES_URL, t('リリースノート'), 'left'), h('button', { type: 'button', class: 'primary', onclick: () => m.close() }, t('閉じる'))] });
}

