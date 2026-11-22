// ホーム画面。ファイルを開いていないときに、最近使ったファイルと Excel で開いているブックを並べる。

import { app } from '../app';
import { invoke } from '../bridge';
import { h, svg } from '../dom';
import { uiIcons } from '../icons';
import { t } from '../i18n';

export function mountHome(host: HTMLElement, open: (path?: string) => void): void {
  const render = async () => {
    if (app.session) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const [recent, workbooks] = await Promise.all([
      invoke('file.recent').catch(() => []),
      app.info.excelInstalled ? invoke('excel.openWorkbooks').catch(() => []) : Promise.resolve([]),
    ]);
    host.replaceChildren(
      h(
        'div',
        { class: 'home-inner' },
        h('h1', null, 'Sash'),
        h('p', { class: 'muted' }, t('xlsm / xlam のリボンを、見たまま作って直せるエディタ')),
        h('div', { class: 'home-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => open() }, svg(uiIcons.open), t('ファイルを開く（Ctrl+O）')), h('span', { class: 'muted' }, t('またはファイルをこの画面にドロップ'))),
        workbooks.length
          ? h(
              'section',
              null,
              h('h2', null, t('Excelで開いているブック')),
              h('ul', { class: 'file-list' }, workbooks.map((w) => h('li', null, h('button', { type: 'button', class: 'link', onclick: () => open(w.fullPath) }, fileName(w.fullPath)), h('span', { class: 'muted path' }, w.fullPath), w.isAddIn ? h('span', { class: 'tag' }, t('アドイン')) : null))),
            )
          : null,
        h(
          'section',
          null,
          h('h2', null, t('最近使ったファイル')),
          recent.length === 0
            ? h('p', { class: 'muted' }, t('まだありません'))
            : h(
                'ul',
                { class: 'file-list' },
                recent.map((r) =>
                  h(
                    'li',
                    { class: r.exists ? '' : 'missing' },
                    h('button', { type: 'button', class: 'link', disabled: !r.exists, onclick: () => open(r.path) }, fileName(r.path)),
                    h('span', { class: 'muted path' }, r.exists ? r.path : t('{path}（見つかりません）', { path: r.path })),
                    h('button', { type: 'button', class: 'icon-button', title: t('一覧から外す'), onclick: () => void invoke('file.removeRecent', { path: r.path }).then(render) }, svg(uiIcons.close)),
                  ),
                ),
              ),
        ),
      ),
    );
  };
  app.on('session', () => void render());
  void render();
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
