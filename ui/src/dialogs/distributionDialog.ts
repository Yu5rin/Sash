// 配布前チェックのダイアログ（ツール メニュー。仕様書 §18.2）。集計は distributionCheck.ts、ここは表示と移動だけ。
// 開いている間に問題・VBA の照合・キャンバスの見積もりが変わったら、描き直す（直しながら見られるように）。

import { app } from '../app';
import { vba } from '../callbacks';
import { collectChecks, suggestionCount, summaryLevel, summaryText, type CheckItem, type CheckLevel, type CheckSection, type FitInput } from '../distributionCheck';
import { h, svg } from '../dom';
import { t } from '../i18n';
import { uiIcons } from '../icons';
import { getFitReport, widthLabel } from '../views/ribbonFit';
import { openModal } from './modal';

export interface DistributionDialogOptions {
  /** 項目を押したときに、その場所へ移る（ダイアログは閉じてから呼ぶ）。 */
  onNavigate: (item: CheckItem) => void;
}

/** キャンバスが測った結果を、集計に渡す形にする。まだ幅を測っていなければ null。 */
export function currentFitInput(): FitInput | null {
  const r = getFitReport();
  if (r.checkedWidths.length === 0) return null;
  const label = (w: number) => widthLabel(w, r.scale);
  return { entries: r.overflowing, widthLabel: label, widths: r.checkedWidths.map(label).join(t('、')) };
}

/** いまの状態で集計する。 */
export function currentChecks(): CheckSection[] {
  const store = app.store;
  if (!store) return [];
  return collectChecks({
    doc: store.doc,
    problems: app.problems,
    statuses: vba.statuses(),
    vbaChecked: vba.status === 'ok',
    vbaNote: vba.statusMessage(),
    imageIds: [...store.images.keys()],
    fit: currentFitInput(),
  });
}

const LEVEL_ICON: Readonly<Record<CheckLevel, string>> = { must: uiIcons.warning, should: uiIcons.info, info: uiIcons.info };

/** 項目の印。must のうち severity が error のものは、警告の三角ではなく赤い丸にする（配ってはいけないものだと分かるように）。 */
export const itemIcon = (item: CheckItem): string => (item.level === 'must' && item.severity === 'error' ? uiIcons.error : LEVEL_ICON[item.level]);

export function openDistributionCheck(opts: DistributionDialogOptions): void {
  if (!app.store) return;
  const body = h('div', { class: 'dist-check' });
  const render = () => {
    const sections = currentChecks();
    const level = summaryLevel(sections);
    const m = suggestionCount(sections);
    const header = h('div', { class: `dist-summary ${level === 'ok' ? 'ok' : level}`, role: 'status' },
      svg(level === 'ok' ? uiIcons.info : level === 'error' ? uiIcons.error : uiIcons.warning),
      h('div', null,
        h('strong', null, summaryText(sections)),
        h('span', { class: 'muted' }, m ? t('見直すとよいもの {n} 件', { n: m }) : t('見直すとよいものはありません'))));
    const list = sections.map((s) => {
      const count = s.items.length;
      return h('section', { class: `dist-section${count === 0 ? ' empty' : ''}` },
        h('h3', null, h('span', null, s.title), h('span', { class: `dist-count${s.items.some((i) => i.level === 'must' && i.severity === 'error') ? ' error' : s.items.some((i) => i.level === 'must') || (s.unverified ?? 0) > 0 ? ' must' : ''}` }, (s.unverified ?? 0) > 0 ? t('未確認 {n}', { n: s.unverified! }) : String(count))),
        s.note ? h('p', { class: 'dist-note muted' }, s.note) : null,
        count === 0 ? null : h('ul', { class: 'dist-items' }, s.items.map((item) =>
          h('li', null, h('button', {
            type: 'button',
            class: `dist-item ${item.level}${item.severity === 'error' ? ' error' : ''}`,
            title: item.target === 'callbacks' ? t('コールバックの一覧を開く') : item.target === 'images' ? t('アイコンの一覧を開く') : t('この要素を選ぶ'),
            onclick: () => {
              handle.close();
              opts.onNavigate(item);
            },
          }, svg(itemIcon(item)), h('span', { class: 'dist-text' }, item.text), item.detail ? h('span', { class: 'dist-detail' }, item.detail) : null)))));
    });
    body.replaceChildren(header, ...list);
  };
  render();
  const rerender = () => {
    if (body.isConnected) render();
  };
  const footer = [
    app.info.excelInstalled ? h('button', { type: 'button', class: 'footer-start', onclick: () => void vba.refresh() }, t('VBA を再読み込み')) : null,
    // 閉じるだけのボタンは主ボタンにしない（緑は「何かを実行する」ものだけ）。最初のフォーカスは modal 側が決める
    h('button', { type: 'button', 'data-initial-focus': '', onclick: () => handle.close() }, t('閉じる')),
  ].filter((b): b is HTMLButtonElement => b !== null);
  const handle = openModal(t('配布前チェック'), body, {
    size: 'lg',
    key: 'distributionCheck',
    footer,
    onClose: () => {
      app.off('problems', rerender);
      app.off('vba', rerender);
      window.removeEventListener('sash:fitreport', rerender);
    },
  });
  app.on('problems', rerender);
  app.on('vba', rerender);
  window.addEventListener('sash:fitreport', rerender);
}
