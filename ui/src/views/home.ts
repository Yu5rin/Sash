// ホーム画面。ファイルを開いていないときに、最近使ったファイルと Excel で開いているブックを並べる。

import { app } from '../app';
import { invoke } from '../bridge';
import { h, svg } from '../dom';
import { uiIcons } from '../icons';

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
        h('p', { class: 'muted' }, 'xlsm / xlam のリボンを、見たまま作って直せるエディタ'),
        h('div', { class: 'home-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => open() }, svg(uiIcons.open), 'ファイルを開く（Ctrl+O）'), h('span', { class: 'muted' }, 'またはファイルをこの画面にドロップ')),
        workbooks.length
          ? h(
              'section',
              null,
              h('h2', null, 'Excelで開いているブック'),
              h('ul', { class: 'file-list' }, workbooks.map((w) => h('li', null, h('button', { type: 'button', class: 'link', onclick: () => open(w.fullPath) }, fileName(w.fullPath)), h('span', { class: 'muted path' }, w.fullPath), w.isAddIn ? h('span', { class: 'tag' }, 'アドイン') : null))),
            )
          : null,
        h(
          'section',
          null,
          h('h2', null, '最近使ったファイル'),
          recent.length === 0
            ? h('p', { class: 'muted' }, 'まだありません')
            : h(
                'ul',
                { class: 'file-list' },
                recent.map((r) =>
                  h(
                    'li',
                    { class: r.exists ? '' : 'missing' },
                    h('button', { type: 'button', class: 'link', disabled: !r.exists, onclick: () => open(r.path) }, fileName(r.path)),
                    h('span', { class: 'muted path' }, r.exists ? r.path : `${r.path}（見つかりません）`),
                    h('button', { type: 'button', class: 'icon-button', title: '一覧から外す', onclick: () => void invoke('file.removeRecent', { path: r.path }).then(render) }, svg(uiIcons.close)),
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
