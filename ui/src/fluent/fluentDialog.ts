// アイコン集（Fluent UI System Icons・Tabler Icons・Lucide・Sash のオリジナル）から選ぶダイアログ。Excel がなくても、見栄えのよいアイコンをボタンに付けられるようにする。
// 選んだアイコンは色を付けた SVG にして返す。PNG にするのはアイコンエディタの役目（出力サイズで描き直し、バッジなどの加工もそこでできる）。
// このモジュールとデータは使うときに動的 import で読む（最初の画面の読み込みを重くしないため）。
// 検索は概念の辞書による絞り込み（iconSearch.ts）。「お金」「配送」「ねこ」のようなあいまいな言葉で探せる。

import './fluent.css';
import { h, svg } from '../dom';
import { openModal, openOnce } from '../dialogs/modal';
import { notify } from '../clipboard';
import { lang, t } from '../i18n';
import {
  buildSvg, DEFAULT_COLOR, displayName, iconSet, loadIconSet, safeColor, setFilePrefix, setLabel,
  type FluentIcon, type FluentVariant, type IconSet,
} from './fluent';
import { CATEGORIES } from './iconCategories';
import { buildColorPalette } from './colorPalette';
import { normalizeHex, pushRecent } from './iconPalette';
import { buildIndex, relatedConcepts, searchIconSet, type IconHit, type SearchResult } from './iconSearch';

export interface FluentPick {
  /** 色を付けた SVG。 */
  blob: Blob;
  /** 元画像の名前として使うファイル名（例：save_regular.svg、tabler-home_regular.svg）。 */
  fileName: string;
  /** アイコンの名前（例：save）。 */
  name: string;
  /** どのアイコン集か（省略したら Fluent。Fluent だけだった頃の呼び出しを壊さないため）。 */
  set?: IconSet;
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

type SetFilter = 'all' | IconSet;

interface Remembered {
  variant: FluentVariant;
  color: string;
  set: SetFilter;
  /** 最近使った色（新しい順）。 */
  recent: string[];
}

/** 前回の種類・色・アイコン集（この利用者の手元だけの好み。保存できない環境では既定に戻るだけ）。 */
function loadRemembered(): Remembered {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Remembered>;
    return {
      variant: v.variant === 'filled' ? 'filled' : 'regular',
      color: safeColor(v.color ?? DEFAULT_COLOR),
      set: v.set === 'fluent' || v.set === 'tabler' || v.set === 'lucide' || v.set === 'sash' ? v.set : 'all',
      recent: Array.isArray(v.recent) ? v.recent.map((c) => normalizeHex(String(c))).filter((c): c is string => c !== null).slice(0, 8) : [],
    };
  } catch {
    return { variant: 'regular', color: DEFAULT_COLOR, set: 'all', recent: [] };
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
  let category = 'all';
  let icons: FluentIcon[] | null = null;
  let result: SearchResult | null = null;
  let results: IconHit[] = [];
  let shown = 0;
  let selected: FluentIcon | null = null;
  let picked = false;

  const search = h('input', { type: 'search', class: 'fluent-search', placeholder: t('アイコンを検索（例：お金、配送、ねこ、A）'), spellcheck: false, 'aria-label': t('アイコンを検索') });
  const variantButtons = (['regular', 'filled'] as const).map((v) =>
    h('button', { type: 'button', dataset: { variant: v }, 'aria-pressed': String(state.variant === v), class: state.variant === v ? 'active' : '', onclick: () => setVariant(v) }, v === 'regular' ? t('線') : t('塗り')),
  );
  const variantSwitch = h('div', { class: 'segmented', role: 'group', 'aria-label': t('アイコンのスタイル') }, variantButtons);
  const setButtons = (['all', 'fluent', 'tabler', 'lucide', 'sash'] as const).map((v) =>
    h('button', { type: 'button', dataset: { set: v }, 'aria-pressed': String(state.set === v), class: state.set === v ? 'active' : '', onclick: () => setSet(v) }, v === 'all' ? t('すべて') : setLabel(v)),
  );
  const setSwitch = h('div', { class: 'segmented', role: 'group', 'aria-label': t('アイコン集の出どころ') }, setButtons);
  // 色：右の欄にパレット（色相ごと・Office の標準の色・最近使った色・#RRGGBB の入力）を常に出す。以前の 6 色（既定のグレー・Excel の緑・青・赤・オレンジ・黒）もパレットの中にある
  const palette = buildColorPalette({ value: state.color, recent: state.recent, onPick: (c) => setColor(c) });

  // カテゴリのチップ。件数は、今の検索語・出どころ・スタイルで絞った結果の中の数（チップを押す前に、どこに何があるか分かるように）
  const chipDefs = [{ id: 'all', ja: 'すべて' }, ...CATEGORIES];
  const chips = chipDefs.map((c) =>
    h('button', { type: 'button', class: 'fluent-chip', dataset: { category: c.id }, 'aria-pressed': String(c.id === category), onclick: () => setCategory(c.id) },
      h('span', null, t(c.ja)), h('span', { class: 'fluent-chip-count' })),
  );
  const chipRow = h('div', { class: 'fluent-chips', role: 'group', 'aria-label': t('カテゴリで絞り込む') }, chips);

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
    palette.el,
  );

  const useButton = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => confirm() }, t('使う'));
  const content = h(
    'div',
    { class: 'catalog fluent-picker' },
    h('div', { class: 'fluent-toolbar' }, search, variantSwitch, setSwitch),
    chipRow,
    h('div', { class: 'fluent-main' }, gridWrap, previewPane),
    h('div', { class: 'fluent-footnote' }, status, h('span', { class: 'muted small fluent-credit' }, t('アイコン：Fluent UI System Icons・Tabler Icons（MIT）、Lucide（ISC）、Sash のオリジナル'))),
  );
  const modal = openModal(t('アイコン集から選ぶ'), content, {
    wide: true,
    tall: true,
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

  /** 一覧のホバーに出す説明：名前（出どころ）と、当たった理由（例：お金 → money）。 */
  function tooltipFor(hit: IconHit): string {
    const base = `${displayName(hit.icon.name)}（${setLabel(iconSet(hit.icon))}）`;
    return hit.via ? `${base}\n${hit.via}` : base;
  }

  function itemFor(hit: IconHit): HTMLElement {
    const icon = hit.icon;
    // 一覧は画面の文字色で描く（暗いテーマでも見えるように）。実際の色はプレビューで確かめる
    const markup = buildSvg(icon, state.variant, 'currentColor', 24);
    const item = h(
      'div',
      { class: `fluent-item${icon === selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(icon === selected), 'aria-label': `${displayName(icon.name)}（${setLabel(iconSet(icon))}）`, title: tooltipFor(hit), tabIndex: -1, dataset: { name: icon.name, set: iconSet(icon) } },
      markup ? svg(markup) : null,
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

  /** チップの件数と押された状態を、今の結果に合わせる。 */
  function renderChips(): void {
    for (const chip of chips) {
      const id = chip.dataset['category']!;
      const n = id === 'all' ? (result?.total ?? 0) : (result?.counts[id] ?? 0);
      const countEl = chip.querySelector<HTMLElement>('.fluent-chip-count')!;
      countEl.textContent = result ? String(n) : '';
      const on = id === category;
      chip.setAttribute('aria-pressed', String(on));
      chip.classList.toggle('active', on);
      // 件数が 0 のチップは隠す（選んでいるものは、外せるよう残す）。検索語に関係のないカテゴリが並んで、場所を取らないように
      chip.hidden = !on && result !== null && n === 0;
    }
  }

  function render(): void {
    if (!icons) return;
    const query = search.value;
    result = searchIconSet(icons, query, { variant: state.variant, set: state.set, category });
    results = result.hits;
    shown = 0;
    grid.replaceChildren();
    gridWrap.scrollTop = 0;
    renderChips();
    if (results.length === 0) {
      more.hidden = true;
      const q = query.trim();
      const related = q ? relatedConcepts(q, 6, lang) : [];
      grid.append(
        h('div', { class: 'empty-state fluent-empty' },
          h('strong', null, q ? t('「{q}」に合うアイコンはありません', { q }) : t('この条件に合うアイコンはありません')),
          h('span', null, t('言葉を変えるか、カテゴリ・アイコン集の絞り込みを外してください。')),
          related.length
            ? h('div', { class: 'fluent-related' }, h('span', { class: 'muted small' }, t('近い言葉：')),
                ...related.map((w) => h('button', { type: 'button', class: 'small', onclick: () => trySearch(w) }, w)))
            : null),
      );
    } else {
      renderMore();
    }
    const count = t('{shown} / {total} 件', { shown: results.length, total: icons.length });
    status.textContent = result.relaxed ? `${t('すべての語に合うものがないので、いずれかに合うものを出しています')}　${count}` : count;
  }

  /** 近い言葉のボタン：検索欄に入れて探す。 */
  function trySearch(word: string): void {
    search.value = word;
    category = 'all';
    render();
    search.focus();
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
    previewName.replaceChildren(
      displayName(selected.name),
      ' ',
      h('span', { class: `fluent-badge ${iconSet(selected)}`, title: t('アイコン集の出どころ') }, setLabel(iconSet(selected))),
    );
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

  function setSet(v: SetFilter): void {
    if (state.set === v) return;
    state.set = v;
    saveRemembered(state);
    for (const b of setButtons) {
      const on = b.dataset['set'] === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    // 外したアイコン集のアイコンを選んでいたら、選択を外す
    if (selected && v !== 'all' && iconSet(selected) !== v) selected = null;
    render();
    renderPreview();
  }

  function setCategory(id: string): void {
    // 押されているチップをもう一度押したら、「すべて」に戻す
    category = category === id ? 'all' : id;
    render();
  }

  function setColor(c: string): void {
    state.color = safeColor(c);
    saveRemembered(state);
    palette.setValue(state.color);
    renderPreview();
  }

  function confirm(): void {
    if (!selected) return;
    const markup = buildSvg(selected, state.variant, state.color);
    if (!markup) return;
    picked = true;
    // 使った色を「最近使った色」に覚える（次に開いたとき、パレットの中に出る）
    state.recent = pushRecent(state.recent, state.color);
    saveRemembered(state);
    const set = iconSet(selected);
    const pick: FluentPick = {
      blob: new Blob([markup], { type: 'image/svg+xml' }),
      // 集どうしに同じ名前（home など）があるので、Fluent 以外のファイル名には出どころを付ける
      fileName: `${setFilePrefix(set)}${selected.name}_${state.variant}.svg`,
      name: selected.name,
      set,
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
        const hit = results[0];
        if (hit) select(hit.icon, first);
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
      const icon = results[idx]?.icon;
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
  renderChips();
  void loadIconSet()
    .then((data) => {
      icons = data.icons;
      // 索引は最初の検索の前に作っておく（初回の検索だけ遅くならないように）
      buildIndex(icons);
      render();
    })
    .catch((e: unknown) => {
      const message = t('アイコン集を読み込めませんでした：{message}', { message: e instanceof Error ? e.message : String(e) });
      status.textContent = message;
      notify({ kind: 'error', message });
    });
}
