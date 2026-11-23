// 設定画面。左に分類、右にその分類の設定を並べる 2 段組みにする。
// 変えたらすぐに保存し、右上に「保存しました」と小さく出す（保存ボタンを押し忘れて失う、をなくすため）。

import { app } from '../app';
import { invoke, type Settings } from '../bridge';
import { openModal, openOnce } from '../dialogs/modal';
import { h, svg } from '../dom';
import { lang, t, type Lang } from '../i18n';
import { cancelMsoPrefetch, describePrefetch, loadPrefetchStatus, onPrefetchStatus, prefetchStatus, startMsoPrefetch } from '../msoIcons';
import type { IconPrefetchStatus } from '../bridge';
import { renderUpdateSettings } from '../updates';
import { select, settingRow } from './form';
import { shellIcons } from './icons';
import { reloadForLanguage, reloadNeeded, saveLanguage } from './language';
import { updateSettings } from './theme';
import { toast } from './toast';

type CategoryId = 'general' | 'view' | 'callbacks' | 'icons' | 'updates';

const CATEGORIES: readonly { id: CategoryId; title: string }[] = [
  { id: 'general', title: '一般' },
  { id: 'view', title: '表示' },
  { id: 'callbacks', title: 'コールバック' },
  { id: 'icons', title: 'アイコン' },
  { id: 'updates', title: '更新' },
];

let lastCategory: CategoryId = 'general';

export function openSettings(start?: CategoryId): Promise<void> {
  return openOnce('settings', () => build(start ?? lastCategory)).then(() => undefined);
}

async function build(start: CategoryId): Promise<void> {
  const saved = h('span', { class: 'settings-saved', role: 'status', 'aria-live': 'polite' });
  let savedTimer: number | undefined;
  const flashSaved = () => {
    saved.replaceChildren(svg(shellIcons.check), t('保存しました'));
    saved.classList.add('show');
    window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => saved.classList.remove('show'), 1800);
  };
  const update = async (patch: Partial<Settings>) => {
    try {
      await updateSettings(patch);
      flashSaved();
    } catch (e) {
      toast({ kind: 'error', message: t('設定を保存できませんでした：{message}', { message: (e as Error).message }) });
    }
  };

  const updateSection = await renderUpdateSettings(async (patch) => {
    await updateSettings(patch);
    flashSaved();
  }, app.settings);

  const panels: Record<CategoryId, () => HTMLElement> = {
    general: () => {
      const s = app.settings;
      const notice = h('div', { class: 'notice', hidden: !reloadNeeded() },
        h('span', null, t('言語の変更は、画面を読み込み直すと反映されます。')),
        h('button', { type: 'button', class: 'small', onclick: () => reloadForLanguage() }, t('今すぐ読み込み直す')));
      return h('div', null,
        settingRow(t('言語'), h('div', { class: 'setting-control' },
          select<Lang>(s.language ?? lang, [{ value: 'ja', label: '日本語' }, { value: 'en', label: 'English' }], (v) => {
            void saveLanguage(v).then(() => {
              flashSaved();
              notice.hidden = !reloadNeeded();
            }).catch((e: Error) => toast({ kind: 'error', message: e.message }));
          }),
          notice), t('メニューやメッセージの言語です。リボンの XML の中身は変わりません。')),
        settingRow(t('バージョン'), h('div', { class: 'setting-row' }, `Sash ${app.info.version}`),
          app.info.excelInstalled ? t('Excel が見つかりました。反映と VBA との照合が使えます。') : t('Excel が見つからないため、ファイルの編集と保存だけができます。')));
    },
    view: () => {
      const s = app.settings;
      return h('div', null,
        settingRow(t('テーマ'), select<Settings['theme']>(s.theme, [
          { value: 'system', label: t('システムに合わせる') },
          { value: 'light', label: t('ライト') },
          { value: 'dark', label: t('ダーク') },
        ], (v) => void update({ theme: v })), t('「システムに合わせる」では、Windows の設定（アプリ モード）に合わせて明るさが変わります。')),
        settingRow(t('レイアウト'), select<'canvas' | 'xml'>(s.xmlOnTop ? 'xml' : 'canvas', [
          { value: 'canvas', label: t('キャンバスを上に') },
          { value: 'xml', label: t('XMLエディタを上に') },
        ], (v) => void update({ xmlOnTop: v === 'xml' })), t('XML を主に書く人は、XML エディタを上にすると広く使えます。')));
    },
    callbacks: () => {
      const s = app.settings;
      const text = (value: string, key: 'callbackPattern' | 'callbackSharedPattern' | 'callbackModule') =>
        h('input', { type: 'text', value, spellcheck: false, onchange: (e: Event) => void update({ [key]: (e.target as HTMLInputElement).value.trim() } as Partial<Settings>) });
      return h('div', null,
        settingRow(t('名前の規則'), text(s.callbackPattern, 'callbackPattern'), t('新しく作るコールバックの名前です。{id} はコントロールの id、{attr} は属性名（onAction など）に置き換わります。')),
        settingRow(t('Subの共有'), select<'each' | 'shared'>(s.callbackShared ? 'shared' : 'each', [
          { value: 'each', label: t('コントロールごとに分ける') },
          { value: 'shared', label: t('1つのSubを共有し control.Id で振り分ける') },
        ], (v) => void update({ callbackShared: v === 'shared' })), t('共有すると、ボタンが多くても VBA の Sub は属性ごとに 1 つで済みます。')),
        settingRow(t('共有するときの名前'), text(s.callbackSharedPattern, 'callbackSharedPattern'), t('{attr} が置き換わります')),
        settingRow(t('挿入先のモジュール'), text(s.callbackModule, 'callbackModule'), t('雛形を VBA に入れるときの標準モジュールの名前です。なければ作ります。')));
    },
    icons: () => {
      const s = app.settings;
      return h('div', null,
        settingRow(t('Excel のアイコン'), builtinIconsControl(),
          t('組み込みのアイコン（imageMso）は、この PC の Excel から取り出し、この PC の中（%AppData%\\Sash\\cache）にだけ保存します。Office のアイコンは Microsoft の著作物のため、Sash には同梱していません。取り込んだ後は、Excel を起動しなくても表示できます。')),
        settingRow(t('アイコンの出力サイズ'), select<'32' | '64'>(String(s.iconSize) as '32' | '64', [
          { value: '32', label: '32 × 32' },
          { value: '64', label: t('64 × 64（高DPI）') },
        ], (v) => void update({ iconSize: Number(v) as 32 | 64 })), t('アイコンエディタで書き出す PNG の大きさです。高 DPI の画面でにじむときは 64 にします。')),
        settingRow(t('アイコンライブラリの保存先'), h('div', { class: 'setting-row' },
          h('span', { class: 'path-text', title: s.iconLibraryPath }, s.iconLibraryPath),
          h('button', { type: 'button', class: 'small', onclick: async () => {
            try {
              const p = await invoke('library.chooseFolder');
              if (!p) return;
              app.settings = await invoke('settings.get');
              flashSaved();
              show('icons');
            } catch (e) {
              toast({ kind: 'error', message: (e as Error).message });
            }
          } }, t('変更'))), t('共有フォルダを選ぶと、チームで同じアイコンを使えます。')));
    },
    updates: () => updateSection,
  };

  /** 組み込みのアイコンの取り込みの状態とボタン。取り込み中は進み具合に合わせて書き換える。 */
  function builtinIconsControl(): HTMLElement {
    const text = h('span', { role: 'status', 'aria-live': 'polite' });
    const outdated = h('div', { class: 'notice', hidden: true });
    const buttons = h('div', { class: 'setting-row' });
    const root = h('div', { class: 'setting-control' }, h('div', { class: 'setting-row' }, text), outdated, buttons);
    const render = (st: IconPrefetchStatus | null) => {
      const excel = st?.excelInstalled ?? app.info.excelInstalled;
      text.textContent = st ? describePrefetch(st) : t('状態を確かめています…');
      outdated.hidden = !(st?.outdated && st.state === 'done');
      outdated.textContent = st?.outdated ? t('Excel が更新されています（{version}）。取り込み直すと、新しいアイコンも表示できます。', { version: st.currentExcelVersion ?? '' }) : '';
      const running = st?.state === 'running';
      // 取り込み済みなら Excel からすべて取り直す（Excel の更新で変わったアイコンも反映する）。
      // 途中で止めたものは、取り込めた分を飛ばして続きから取り込む
      const done = st?.state === 'done';
      const label = done ? t('取り込み直す') : (st?.cached ?? 0) > 0 ? t('続きを取り込む') : t('取り込む');
      buttons.replaceChildren(
        running
          ? h('button', { type: 'button', class: 'small', onclick: () => void cancelMsoPrefetch() }, t('中止'))
          : h('button', {
              type: 'button',
              class: 'small',
              disabled: !excel,
              title: excel ? null : t('Excel が見つからないため、取り込めません'),
              onclick: () => void startMsoPrefetch(done),
            }, label),
      );
    };
    render(prefetchStatus());
    // 開いている間だけ追いかける。ダイアログを閉じたり分類を切り替えたりしたら外す
    const off = onPrefetchStatus((st) => {
      if (!root.isConnected) {
        off();
        return;
      }
      render(st);
    });
    void loadPrefetchStatus();
    return root;
  }

  const nav = h('div', { class: 'settings-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('設定の分類') });
  const panel = h('div', { class: 'settings-panel', role: 'tabpanel', tabIndex: -1 });
  const tabs = CATEGORIES.map((c) => h('button', {
    type: 'button',
    role: 'tab',
    id: `settings-tab-${c.id}`,
    'aria-controls': 'settings-panel',
    onclick: () => show(c.id),
  }, t(c.title)));
  nav.append(...tabs);
  panel.id = 'settings-panel';

  const show = (id: CategoryId) => {
    lastCategory = id;
    CATEGORIES.forEach((c, i) => {
      const on = c.id === id;
      tabs[i]!.setAttribute('aria-selected', String(on));
      tabs[i]!.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `settings-tab-${id}`);
    panel.replaceChildren(h('h3', null, t(CATEGORIES.find((c) => c.id === id)!.title)), panels[id]());
  };
  // 分類は ↑↓ で選ぶ（タブ一覧の標準の操作）
  nav.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const j = (next + tabs.length) % tabs.length;
    show(CATEGORIES[j]!.id);
    tabs[j]!.focus();
  });
  show(start);

  const m = openModal(t('設定'), h('div', { class: 'settings-layout' }, nav, panel), { key: 'settings', initialFocus: tabs[CATEGORIES.findIndex((c) => c.id === start)] });
  m.root.classList.add('settings-modal');
  m.root.querySelector('header h2')?.after(saved);
}
