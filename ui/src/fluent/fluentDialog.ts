// アイコン集（Fluent UI System Icons）から選ぶダイアログ。Excel がなくても、見栄えのよいアイコンをボタンに付けられるようにする。
// 選んだアイコンは色を付けた SVG にして返す。PNG にするのはアイコンエディタの役目（出力サイズで描き直し、バッジなどの加工もそこでできる）。
// このモジュールとデータは使うときに動的 import で読む（最初の画面の読み込みを重くしないため）。

import './fluent.css';
import { h, svg } from '../dom';
import { openModal, openOnce } from '../dialogs/modal';
import { notify } from '../clipboard';
import { t } from '../i18n';
import {
  buildSvg, COLOR_PRESETS, DEFAULT_COLOR, displayName, loadFluentIcons, safeColor, searchIcons,
  type FluentIcon, type FluentVariant,
} from './fluent';

export interface FluentPick {
  /** 色を付けた SVG。 */
  blob: Blob;
  /** 元画像の名前として使うファイル名（例：save_regular.svg）。 */
  fileName: string;
  /** アイコンの名前（例：save）。 */
  name: string;
  variant: FluentVariant;
  color: string;
}

export interface FluentPickerOptions {
  /** 閉じたときに呼ぶ。picked はアイコンを選んだか（取り消したときに呼び出し元の表示を戻すため）。 */
  onClose?: (picked: boolean) => void;
}

/** 一度に描くアイコンの数。2,900 個を一度に描くと開くのが遅くなるので、スクロールに合わせて足していく。 */
const PAGE = 240;
const STORAGE_KEY = 'sash.fluent';

interface Remembered {
  variant: FluentVariant;
  color: string;
}

/** 前回の種類と色（この利用者の手元だけの好み。保存できない環境では既定に戻るだけ）。 */
function loadRemembered(): Remembered {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Remembered>;
    return { variant: v.variant === 'filled' ? 'filled' : 'regular', color: safeColor(v.color ?? DEFAULT_COLOR) };
  } catch {
    return { variant: 'regular', color: DEFAULT_COLOR };
  }
}

function saveRemembered(r: Remembered): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    // 覚えられなくても選ぶことはできる
  }
}

/** 開く。選んだら onPick を呼んで閉じる。 */
export function openFluentPicker(onPick: (pick: FluentPick) => void, opts: FluentPickerOptions = {}): Promise<void> {
  return openOnce('fluent-icons', () => build(onPick, opts)).then(() => undefined);
}

function build(onPick: (pick: FluentPick) => void, opts: FluentPickerOptions): void {
  const state = loadRemembered();
  let icons: FluentIcon[] | null = null;
  let results: FluentIcon[] = [];
  let shown = 0;
  let selected: FluentIcon | null = null;
  let picked = false;

  const search = h('input', { type: 'search', class: 'fluent-search', placeholder: t('アイコンを検索（例：保存、表、arrow）'), spellcheck: false, 'aria-label': t('アイコンを検索') });
  const variantButtons = (['regular', 'filled'] as const).map((v) =>
    h('button', { type: 'button', dataset: { variant: v }, 'aria-pressed': String(state.variant === v), class: state.variant === v ? 'active' : '', onclick: () => setVariant(v) }, v === 'regular' ? t('線') : t('塗り')),
  );
  const variantSwitch = h('div', { class: 'segmented', role: 'group', 'aria-label': t('アイコンのスタイル') }, variantButtons);
  const colorInput = h('input', { type: 'color', value: state.color, title: t('色を選ぶ'), 'aria-label': t('色を選ぶ'), oninput: () => setColor(colorInput.value) });
  const swatches = COLOR_PRESETS.map((p) =>
    h('button', { type: 'button', class: 'fluent-swatch', style: `--swatch:${p.color}`, title: `${t(p.label)}（${p.color}）`, 'aria-label': t(p.label), dataset: { color: p.color }, onclick: () => setColor(p.color) }),
  );
  const colorRow = h('div', { class: 'fluent-colors', role: 'group', 'aria-label': t('色') }, h('span', { class: 'muted small' }, t('色')), ...swatches, colorInput);

  const grid = h('div', { class: 'fluent-grid', role: 'listbox', 'aria-label': t('アイコンの一覧'), tabIndex: -1 });
  const more = h('button', { type: 'button', class: 'small fluent-more', hidden: true, onclick: () => renderMore() });
  const gridWrap = h('div', { class: 'fluent-grid-wrap' }, grid, more);
  const status = h('div', { class: 'catalog-status muted small', role: 'status' }, t('読み込み中…'));

  const previewName = h('div', { class: 'fluent-preview-name' });
  const previewRow = h('div', { class: 'icon-preview-row' });
  const previewPane = h(
    'div',
    { class: 'fluent-preview' },
    h('h3', null, t('プレビュー（実寸）')),
    previewName,
    previewRow,
    h('p', { class: 'muted small' }, t('「使う」を押すとアイコンエディタが開き、出力サイズの PNG にして設定します。バッジなどの加工もそこでできます。')),
    h('p', { class: 'muted small fluent-credit' }, t('アイコン：Microsoft Fluent UI System Icons（MIT License）')),
  );

  const useButton = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => confirm() }, t('使う'));
  const content = h(
    'div',
    { class: 'catalog fluent-picker' },
    h('div', { class: 'fluent-toolbar' }, search, variantSwitch),
    colorRow,
    h('div', { class: 'fluent-main' }, gridWrap, previewPane),
    status,
  );
  const modal = openModal(t('アイコン集（Fluent）から選ぶ'), content, {
    wide: true,
    initialFocus: search,
    footer: [h('button', { type: 'button', onclick: () => modal.close() }, t('キャンセル')), useButton],
    onClose: () => {
      observer?.disconnect();
      opts.onClose?.(picked);
    },
  });

  // 末尾の「さらに表示」が見えたら自動で足す（IntersectionObserver がない環境ではボタンを押す）
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && !more.hidden && renderMore(), { root: gridWrap, rootMargin: '200px' })
    : null;
  observer?.observe(more);

  // ---- 描画 ----

  function itemFor(icon: FluentIcon): HTMLElement {
    const markup = buildSvg(icon, state.variant, '#000000', 24);
    const item = h(
      'div',
      { class: `fluent-item${icon === selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(icon === selected), 'aria-label': displayName(icon.name), title: displayName(icon.name), tabIndex: -1, dataset: { name: icon.name } },
      // 一覧は画面の文字色で描く（暗いテーマでも見えるように）。実際の色はプレビューで確かめる
      markup ? svg(markup.replace(/fill="#000000"/, 'fill="currentColor"')) : null,
    );
    item.addEventListener('click', () => select(icon, item));
    item.addEventListener('dblclick', () => {
      select(icon, item);
      confirm();
    });
    return item;
  }

  function renderMore(): void {
    const next = results.slice(shown, shown + PAGE);
    grid.append(...next.map(itemFor));
    shown += next.length;
    more.hidden = shown >= results.length;
    more.textContent = t('さらに表示（残り {n} 件）', { n: results.length - shown });
    updateTabStop();
  }

  function render(): void {
    if (!icons) return;
    results = searchIcons(icons, search.value, state.variant);
    shown = 0;
    grid.replaceChildren();
    gridWrap.scrollTop = 0;
    if (results.length === 0) {
      more.hidden = true;
      grid.append(
        h('div', { class: 'empty-state fluent-empty' },
          h('strong', null, t('「{q}」に合うアイコンはありません', { q: search.value.trim() })),
          h('span', null, t('別の言葉か、英語の名前（例：save, table, arrow）で探してください。'))),
      );
    } else {
      renderMore();
    }
    status.textContent = t('{shown} / {total} 件', { shown: results.length, total: icons.length });
  }

  /** 矢印キーで移れるよう、フォーカスを受ける項目は1つだけにする（Tab で格子の中を一つずつ巡らないように）。 */
  function updateTabStop(): void {
    const items = Array.from(grid.querySelectorAll<HTMLElement>('.fluent-item'));
    const current = items.find((x) => x.classList.contains('selected')) ?? items[0];
    for (const x of items) x.tabIndex = x === current ? 0 : -1;
  }

  function renderPreview(): void {
    useButton.disabled = !selected;
    if (!selected) {
      previewName.textContent = t('アイコンを選んでください');
      previewRow.replaceChildren();
      return;
    }
    previewName.textContent = displayName(selected.name);
    const cell = (bg: 'light' | 'dark', px: number) => {
      const markup = buildSvg(selected!, state.variant, state.color, px);
      return h('div', { class: `icon-preview ${bg}` }, markup ? svg(markup) : null, h('span', null, px === 16 ? t('小') : t('大')));
    };
    previewRow.replaceChildren(cell('light', 16), cell('light', 32), cell('dark', 16), cell('dark', 32));
  }

  function select(icon: FluentIcon, item?: HTMLElement): void {
    selected = icon;
    for (const x of Array.from(grid.querySelectorAll<HTMLElement>('.fluent-item.selected'))) {
      x.classList.remove('selected');
      x.setAttribute('aria-selected', 'false');
    }
    if (item) {
      item.classList.add('selected');
      item.setAttribute('aria-selected', 'true');
    }
    updateTabStop();
    renderPreview();
  }

  function setVariant(v: FluentVariant): void {
    if (state.variant === v) return;
    state.variant = v;
    saveRemembered(state);
    for (const b of variantButtons) {
      const on = b.dataset['variant'] === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    // 選んでいたアイコンにその種類がなければ、選択を外す
    if (selected && selected[v] === 0) selected = null;
    render();
    renderPreview();
  }

  function setColor(c: string): void {
    state.color = safeColor(c);
    colorInput.value = state.color;
    saveRemembered(state);
    for (const s of swatches) s.setAttribute('aria-pressed', String(s.dataset['color'] === state.color));
    renderPreview();
  }

  function confirm(): void {
    if (!selected) return;
    const markup = buildSvg(selected, state.variant, state.color);
    if (!markup) return;
    picked = true;
    const pick: FluentPick = {
      blob: new Blob([markup], { type: 'image/svg+xml' }),
      fileName: `${selected.name}_${state.variant}.svg`,
      name: selected.name,
      variant: state.variant,
      color: state.color,
    };
    modal.close();
    onPick(pick);
  }

  // ---- 操作 ----

  const runSearch = (() => {
    let timer: number | undefined;
    return () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(render, 120);
    };
  })();
  // 日本語の変換中は検索しない（確定したときに検索する）
  search.addEventListener('input', (e) => {
    if ((e as InputEvent).isComposing) return;
    runSearch();
  });
  search.addEventListener('compositionend', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'Enter' && !selected) {
      // 何も選んでいなければ、先頭のアイコンを選ぶ（もう一度 Enter で「使う」）
      e.preventDefault();
      const first = grid.querySelector<HTMLElement>('.fluent-item');
      if (first) {
        const icon = results[0];
        if (icon) select(icon, first);
      }
    }
  });

  function focusItem(index: number): void {
    const items = Array.from(grid.querySelectorAll<HTMLElement>('.fluent-item'));
    if (items.length === 0) return;
    // まだ描いていない先へ進むときは、続きを描いてから移る
    if (index >= items.length && shown < results.length) {
      renderMore();
      focusItem(index);
      return;
    }
    const el = items[Math.max(0, Math.min(index, items.length - 1))]!;
    for (const x of items) x.tabIndex = x === el ? 0 : -1;
    el.focus();
    el.scrollIntoView?.({ block: 'nearest' });
  }

  grid.addEventListener('keydown', (e) => {
    const items = Array.from(grid.querySelectorAll<HTMLElement>('.fluent-item'));
    const idx = items.indexOf(e.target as HTMLElement);
    if (idx < 0) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const icon = results[idx];
      if (!icon) return;
      // 選んであるものでもう一度 Enter を押したら決定する
      if (e.key === 'Enter' && selected === icon) confirm();
      else select(icon, items[idx]);
      return;
    }
    // 1行の個数は、上端の位置が同じものを数える
    const top = items[0]!.offsetTop;
    const firstOther = items.findIndex((x) => x.offsetTop !== top);
    const cols = Math.max(1, firstOther < 0 ? items.length : firstOther);
    const delta = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, PageDown: cols * 4, PageUp: -cols * 4 } as Record<string, number>)[e.key];
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusItem(e.key === 'Home' ? 0 : results.length - 1);
      return;
    }
    if (delta === undefined) return;
    e.preventDefault();
    const next = idx + delta;
    if (next < 0) search.focus();
    else focusItem(next);
  });

  setColor(state.color);
  renderPreview();
  void loadFluentIcons()
    .then((data) => {
      icons = data.icons;
      render();
    })
    .catch((e: unknown) => {
      const message = t('アイコン集を読み込めませんでした：{message}', { message: e instanceof Error ? e.message : String(e) });
      status.textContent = message;
      notify({ kind: 'error', message });
    });
}
