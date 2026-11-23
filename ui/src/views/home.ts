// ホーム画面。ファイルを開いていないときに、最近使ったファイルと Excel で開いているブックを並べる。
// Excel のブックは、ホームを出すたびと再読み込みのボタンで取り直す（起動時は app.info が届く前に描くため、
// それだけに頼ると「Excel で開いているブック」が出てこなかった）。

import { app } from '../app';
import { invoke, type OpenWorkbook, type RecentFile } from '../bridge';
import { h, svg } from '../dom';
import { uiIcons } from '../icons';
import { t } from '../i18n';
import { shellIcons } from '../shell/icons';
import { splitPath } from '../shell/text';
import { toast } from '../shell/toast';
import { openSample } from '../sample';
import '../styles-w3.css';

/** 「はじめての方へ」を畳んだかどうか（この利用者の手元だけの好み。保存できない環境では毎回開いて出すだけ）。 */
const ONBOARDING_KEY = 'sash.home.onboarding';

function onboardingCollapsed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function rememberOnboarding(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(ONBOARDING_KEY, 'collapsed');
    else localStorage.removeItem(ONBOARDING_KEY);
  } catch {
    // 覚えられなくても表示には困らない
  }
}

/**
 * 「はじめての方へ」。Sash は Excel のブックの中のリボン定義を編集するもので、ブックそのものは作れない。
 * 最初につまずくのは「何を開けばよいか」なので、Excel で保存するところから順に示し、ファイルがなくても試せるサンプルを置く。
 */
function onboardingCard(): HTMLElement {
  const steps: [string, string][] = [
    [t('Excel で .xlam / .xlsm を保存する'), t('リボンを付けたいブックを、Excel で「マクロ有効ブック」か「アドイン」として保存します。')],
    [t('Sash で開く'), t('［ファイルを開く］か、このページへのドロップで開きます。リボン定義がなければ新しく作ります。')],
    [t('レシピでタブを作る'), t('［挿入］→［レシピ］から、よく使う形のタブやボタンをまとめて追加できます。あとは見たまま直します。')],
    [t('Excel へ反映する（F5）'), t('ブックを Excel で開いたまま F5 を押すと、保存して Excel のリボンを読み直します。')],
  ];
  const details = h('details', { class: 'card onboarding', open: !onboardingCollapsed() },
    h('summary', { class: 'card-head' }, h('h2', null, t('はじめての方へ'))),
    h('div', { class: 'card-body' },
      h('ol', { class: 'onboarding-steps' }, steps.map(([title, body], i) =>
        h('li', null,
          h('span', { class: 'onboarding-num', 'aria-hidden': 'true' }, String(i + 1)),
          h('div', null, h('strong', null, title), h('p', null, body))))),
      h('div', { class: 'onboarding-actions' },
        h('button', { type: 'button', onclick: () => void openSample() }, svg(uiIcons.recipe), t('サンプルを開いて試す')),
        h('span', { class: 'muted' }, t('ファイルがなくても試せます。サンプルは保存できません。')))));
  details.addEventListener('toggle', () => rememberOnboarding(!details.open));
  return details;
}

export interface HomeHandle {
  /** 一覧を取り直して描き直す。 */
  refresh(): void;
}

type WorkbookState = { kind: 'noExcel' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; books: OpenWorkbook[] };

export function mountHome(host: HTMLElement, open: (path?: string) => void): HomeHandle {
  let recent: RecentFile[] | null = null;
  let workbooks: WorkbookState = { kind: 'loading' };
  let generation = 0;

  const fileButton = (path: string, opts: { missing?: boolean; badges?: HTMLElement[]; title?: string }) => {
    const { name, folder } = splitPath(path);
    return h('button', {
      type: 'button',
      class: 'file-open',
      disabled: opts.missing ?? false,
      title: opts.title ?? path,
      onclick: () => open(path),
    },
    svg(shellIcons.file),
    h('span', { class: 'file-text' }, h('span', { class: 'file-name' }, name), h('span', { class: 'file-folder' }, folder)),
    opts.badges?.length ? h('span', { class: 'file-badges' }, opts.badges) : null);
  };

  const recentCard = () => {
    const body = recent === null
      ? h('p', { class: 'empty-state' }, t('読み込み中…'))
      : recent.length === 0
        ? h('div', { class: 'empty-state' }, h('strong', null, t('最近使ったファイルはまだありません')), h('span', null, t('開いたファイルがここに並びます。')))
        : h('ul', { class: 'file-list' }, recent.map((r) =>
            h('li', { class: `file-item${r.exists ? '' : ' missing'}` },
              fileButton(r.path, {
                missing: !r.exists,
                title: r.exists ? r.path : t('{path}（見つかりません）', { path: r.path }),
                badges: r.exists ? [] : [h('span', { class: 'badge-soft warning' }, t('見つかりません'))],
              }),
              h('button', {
                type: 'button',
                class: 'icon-button file-remove',
                title: t('一覧から消す'),
                'aria-label': t('{name} を一覧から消す', { name: splitPath(r.path).name }),
                onclick: () => void invoke('file.removeRecent', { path: r.path }).then(loadRecent).catch((e: Error) => toast({ kind: 'error', message: e.message })),
              }, svg(uiIcons.close)))));
    return h('section', { class: 'card', 'aria-labelledby': 'home-recent' },
      h('div', { class: 'card-head' }, h('h2', { id: 'home-recent' }, t('最近使ったファイル'))),
      h('div', { class: 'card-body' }, body));
  };

  const workbookCard = () => {
    let body: HTMLElement;
    switch (workbooks.kind) {
      case 'noExcel':
        body = h('div', { class: 'empty-state' }, h('strong', null, t('Excel が見つかりません')), h('span', null, t('ファイルの編集と保存はできます。Excel への反映には Excel が必要です。')));
        break;
      case 'loading':
        body = h('p', { class: 'empty-state' }, t('読み込み中…'));
        break;
      case 'error':
        body = h('div', { class: 'empty-state' }, h('strong', null, t('ブックの一覧を取得できませんでした')), h('span', null, workbooks.message));
        break;
      case 'ok': {
        const books = workbooks.books.filter((w) => /\.(xlsm|xlam|xltm|xlsb)$/i.test(w.fullPath));
        body = books.length === 0
          ? h('div', { class: 'empty-state' },
              h('strong', null, t('Excel が起動していないか、マクロ有効ブックが開かれていません')),
              h('span', null, t('Excel でブックを開いてから［再読み込み］を押してください。')))
          : h('ul', { class: 'file-list' }, books.map((w) =>
              h('li', { class: 'file-item' }, fileButton(w.fullPath, {
                badges: [
                  w.isAddIn ? h('span', { class: 'badge-soft' }, t('アドイン')) : null,
                  w.isDirty ? h('span', { class: 'badge-soft warning' }, t('Excel 側に未保存の変更')) : null,
                ].filter((x): x is HTMLSpanElement => x !== null),
              }))));
      }
    }
    return h('section', { class: 'card', 'aria-labelledby': 'home-books' },
      h('div', { class: 'card-head' },
        h('h2', { id: 'home-books' }, t('Excelで開いているブック')),
        app.info.excelInstalled
          ? h('button', { type: 'button', class: 'small', onclick: () => void loadWorkbooks(), disabled: workbooks.kind === 'loading' }, svg(shellIcons.refresh), t('再読み込み'))
          : null),
      h('div', { class: 'card-body' }, body));
  };

  const drop = h('div', { class: 'home-drop' },
    svg(shellIcons.folder),
    h('p', null, h('strong', null, t('ここにファイルをドロップ'))),
    h('p', { class: 'muted' }, '.xlsm / .xlam / .xltm / .xlsb'));
  // ドロップそのものは main.ts の window の処理に任せ、ここでは場所を示すだけにする
  drop.addEventListener('dragenter', () => drop.classList.add('over'));
  drop.addEventListener('dragleave', (e) => {
    if (!drop.contains(e.relatedTarget as Node)) drop.classList.remove('over');
  });
  drop.addEventListener('drop', () => drop.classList.remove('over'));

  const render = () => {
    if (app.session) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const hadFocus = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).textContent : null;
    host.replaceChildren(
      h('div', { class: 'home-inner' },
        h('div', { class: 'home-hero' },
          h('div', null,
            h('h1', null, 'Sash'),
            h('p', { class: 'home-lead' }, t('xlsm / xlam のリボンを、見たまま作って直せるエディタ')),
            h('button', { type: 'button', class: 'primary home-open', onclick: () => open() }, svg(uiIcons.open), t('ファイルを開く'), h('kbd', null, 'Ctrl+O'))),
          drop),
        onboardingCard(),
        h('div', { class: 'home-cards' }, recentCard(), workbookCard())),
    );
    // 一覧を描き直してもフォーカスを失わないよう、同じ文字のボタンへ戻す
    if (hadFocus !== null) Array.from(host.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent === hadFocus)?.focus();
  };

  const loadRecent = async () => {
    recent = await invoke('file.recent').catch(() => []);
    render();
  };

  const loadWorkbooks = async () => {
    if (!app.info.excelInstalled) {
      workbooks = { kind: 'noExcel' };
      render();
      return;
    }
    const mine = ++generation;
    workbooks = { kind: 'loading' };
    render();
    try {
      const books = await invoke('excel.openWorkbooks');
      if (mine === generation) workbooks = { kind: 'ok', books };
    } catch (e) {
      if (mine === generation) workbooks = { kind: 'error', message: (e as Error).message };
    }
    render();
  };

  const refresh = () => {
    if (app.session) {
      render();
      return;
    }
    void loadRecent();
    void loadWorkbooks();
  };

  // ↑↓ でファイルの一覧を移る（Tab だけだと「消す」ボタンも挟まって遠いため）
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('.file-open:not(:disabled)'));
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 && !(document.activeElement as HTMLElement)?.closest('.file-item')) return;
    e.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    next?.focus();
  });

  // Excel でブックを開いてから Sash に戻ってきたときにも取り直す
  window.addEventListener('focus', () => {
    if (!app.session && !host.hidden) void loadWorkbooks();
  });

  app.on('session', () => {
    if (!app.session) refresh();
    else render();
  });
  render();
  return { refresh };
}
