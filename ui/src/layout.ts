// ペインの幅と高さを変えられるようにする（仕様書 §4）。ダブルクリックで畳む・戻す。
// - 仕切りの見た目は 1px の線にし、つかめる範囲は前後 4px ずつ広げる（細い線を狙わなくてよいように）
// - 畳んだペインは細い帯として残し、帯を押すと元の大きさに戻す（どこへ消えたか分からなくならないように）
// - 大きさの保存はドラッグを離したときだけ行う（動かしている間に毎回書き込むと localStorage への書き込みが続くため）
// - 左のペインの中のパレットとツリーの境目も動かせる（パレットは比率で持つ。窓の高さが変わっても同じ見え方になるように）

import { t } from './i18n';

const KEY = 'sash.layout';

export type PaneKey = 'left' | 'right' | 'top' | 'bottom';

interface Sizes {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 下部パネルの既定は 140px。1366×768 では 200px だと、キャンバスと XML の高さが足りなくなるため。
 * 保存済みの大きさがある利用者には影響しない。
 */
/** 比べるために一時的に広げるとき、XML エディタに残す最低限の高さ（px）。 */
export const MIN_XML_HEIGHT = 120;

export const DEFAULT_SIZES: Readonly<Sizes> = { left: 248, right: 300, top: 260, bottom: 140 };

/** これより小さくしたら畳んだものとみなす。 */
const COLLAPSE_BELOW = 48;

// ---- パレットとツリーの境目（仕様書 §4） ----

/** パレットの高さの比率（左ペインの高さに対する割合）の既定。 */
export const DEFAULT_PALETTE_RATIO = 0.45;
/** 見出しの行の高さ。畳んだ側はこの高さだけ残す。 */
export const SPLIT_HEAD = 28;
/** 境目の線の高さ。 */
const SPLIT_LINE = 1;
/** 各側がこれより小さくならないようにする。 */
export const SPLIT_MIN = 72;
/** ドラッグでこれより小さくしたら、その側を畳む。 */
export const SPLIT_COLLAPSE = 36;

/** 比率として読める値に丸める。壊れた値は既定。0 はパレットを畳んだ状態、1 はツリーを畳んだ状態を表す。 */
export function sanitizeRatio(v: unknown, fallback = DEFAULT_PALETTE_RATIO): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** 「畳む前の比率」。畳んだ状態（0 と 1）は戻し先にならないので、範囲の外なら既定にする。 */
export function sanitizeLastRatio(v: unknown): number {
  const r = sanitizeRatio(v);
  return r > 0 && r < 1 ? r : DEFAULT_PALETTE_RATIO;
}

/**
 * パレットの高さ（px）から、保存する比率を決める。container は左ペインの高さ。
 * どちらの側も 72px を下回らないようにし、36px 未満まで引いたらその側を畳む（0＝パレットを畳む、1＝ツリーを畳む）。
 */
export function ratioFromHeight(paletteHeight: number, container: number): number {
  if (!(container > 0)) return DEFAULT_PALETTE_RATIO;
  if (paletteHeight < SPLIT_COLLAPSE) return 0;
  const rest = container - SPLIT_LINE - paletteHeight;
  if (rest < SPLIT_COLLAPSE) return 1;
  const hi = Math.max(SPLIT_MIN, container - SPLIT_LINE - SPLIT_MIN);
  return Math.min(Math.max(paletteHeight, SPLIT_MIN), hi) / container;
}

/** 今のパレットの高さ（px）。畳んだ側は見出しだけ残る。 */
export function paletteHeightOf(ratio: number, container: number): number {
  if (ratio <= 0) return SPLIT_HEAD;
  if (ratio >= 1) return Math.max(SPLIT_HEAD, container - SPLIT_LINE - SPLIT_HEAD);
  return ratio * container;
}

export interface LayoutHandle {
  toggle(key: PaneKey): void;
  /** 畳んでいたら戻す。 */
  expand(key: PaneKey): void;
  isCollapsed(key: PaneKey): boolean;
  /** 既定の大きさに戻す。 */
  reset(): void;
  /**
   * 指定のペインを一時的に畳む（キャンバスを広く使って、リボンを広い幅で見るため。仕様書 §18.7）。
   * 大きさは保存しない（次の起動では元の大きさに戻る）。返した関数を呼ぶと、畳む前の大きさに戻す
   * （その間に利用者が自分で開き直したペインは、そのままにする）。
   */
  collapseTemporarily(keys: readonly PaneKey[]): () => void;
  /**
   * キャンバスの高さを一時的に px だけ広げる（幅を比べるプレビューで 2 段ぶんの高さが要るため。仕様書 §18.7）。
   * 保存しない（動かして保存したときも、広げた分は書かない）。返した関数を呼ぶと広げる前に戻す。
   * キャンバスを畳んでいるときは何もしない。
   */
  growTemporarily(key: 'top', px: number): () => void;
  /** パレットとツリーの境目。畳んでいるか。 */
  isSplitCollapsed(side: 'palette' | 'tree'): boolean;
  /** 畳んでいたら開く（F6・Ctrl+2 で畳んだ側へ移るとき）。 */
  expandSplit(side: 'palette' | 'tree'): void;
  /** 畳んだ帯に出す要約（下部パネルの「問題 n ・ コールバック n」）。null で消す。 */
  setCollapsedSummary(key: PaneKey, text: string | null): void;
}

export interface LoadedLayout {
  sizes: Sizes;
  last: Sizes;
  /** パレットの比率（0〜1）。 */
  palette: number;
  /** パレットを畳む前の比率（0 と 1 の間）。 */
  lastPalette: number;
}

/** 保存された文字列から読む。壊れた値・範囲外の値は既定や範囲に丸める（テストのため文字列を受ける）。 */
export function parseLayout(text: string | null): LoadedLayout {
  try {
    const raw = JSON.parse(text ?? '{}') as Partial<Sizes> & { palette?: unknown; last?: Partial<Sizes> & { palette?: unknown } };
    const pick = (o: Partial<Sizes> | undefined): Partial<Sizes> =>
      Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => k in DEFAULT_SIZES && typeof v === 'number' && Number.isFinite(v) && v >= 0)) as Partial<Sizes>;
    return {
      sizes: { ...DEFAULT_SIZES, ...pick(raw) },
      last: { ...DEFAULT_SIZES, ...pick(raw.last) },
      palette: sanitizeRatio(raw.palette),
      lastPalette: sanitizeLastRatio(raw.last?.palette),
    };
  } catch {
    return { sizes: { ...DEFAULT_SIZES }, last: { ...DEFAULT_SIZES }, palette: DEFAULT_PALETTE_RATIO, lastPalette: DEFAULT_PALETTE_RATIO };
  }
}

function load(): LoadedLayout {
  try {
    return parseLayout(localStorage.getItem(KEY));
  } catch {
    return parseLayout(null);
  }
}

export function mountLayout(root: HTMLElement): LayoutHandle {
  const loaded = load();
  const { sizes, last } = loaded;
  /** パレットの比率。0 はパレットを畳んだ状態、1 はツリーを畳んだ状態（同時には畳まない）。 */
  let palette = loaded.palette;
  let lastPalette = loaded.lastPalette;
  const splitters = new Map<PaneKey, HTMLElement>();
  const summaries = new Map<PaneKey, string>();
  /** 一時的に足した高さ（保存しない）。sizes に足してしまうと、ほかの操作で保存されてしまうため別に持つ。 */
  const bonus = { top: 0 };
  const leftPane = root.querySelector<HTMLElement>('.pane.left');
  const paletteSplitter = root.querySelector<HTMLElement>('[data-splitter="palette"]');
  const splitToggles = Array.from(root.querySelectorAll<HTMLElement>('[data-split-toggle]'));

  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...sizes, palette, last: { ...last, palette: lastPalette } }));
    } catch {
      // 保存できなくても動作には影響しない
    }
  };

  const max = (key: PaneKey) => ((key === 'left' || key === 'right' ? window.innerWidth : window.innerHeight) * 0.7);

  const openLabels: Readonly<Record<PaneKey, string>> = {
    left: 'パレットとツリーを開く',
    right: 'インスペクタを開く',
    top: 'キャンバスを開く',
    bottom: '下部パネルを開く',
  };

  const applySplit = () => {
    const paletteCollapsed = palette <= 0;
    const treeCollapsed = palette >= 1;
    root.classList.toggle('collapsed-palette', paletteCollapsed);
    root.classList.toggle('collapsed-tree', treeCollapsed);
    if (!paletteCollapsed && !treeCollapsed) root.style.setProperty('--palette-ratio', String(palette));
    for (const b of splitToggles) {
      const side = b.dataset['splitToggle'] as 'palette' | 'tree';
      const open = side === 'palette' ? !paletteCollapsed : !treeCollapsed;
      b.setAttribute('aria-expanded', String(open));
      b.title = open ? t('クリックで畳む') : t('クリックで開く');
    }
    const sp = paletteSplitter;
    if (!sp) return;
    const pct = Math.round(palette * 100);
    sp.setAttribute('aria-valuemin', '0');
    sp.setAttribute('aria-valuemax', '100');
    sp.setAttribute('aria-valuenow', String(pct));
    sp.setAttribute('aria-valuetext', paletteCollapsed ? t('パレットを畳んでいます') : treeCollapsed ? t('ツリーを畳んでいます') : t('パレット {p}%', { p: pct }));
  };

  const apply = () => {
    for (const key of Object.keys(DEFAULT_SIZES) as PaneKey[]) {
      const collapsed = sizes[key] === 0;
      const shown = collapsed || key !== 'top' ? sizes[key] : sizes[key] + bonus.top;
      root.style.setProperty(`--${key}`, `${shown}px`);
      root.classList.toggle(`collapsed-${key}`, collapsed);
      const sp = splitters.get(key);
      if (sp) {
        sp.classList.toggle('collapsed', collapsed);
        sp.dataset['title'] ??= sp.title;
        sp.dataset['label'] ??= sp.getAttribute('aria-label') ?? '';
        sp.title = collapsed ? t('クリックで元の大きさに戻す') : sp.dataset['title'];
        // 畳んだ帯は「開くボタン」として読み上げられるよう、名前も付け替える。下部は中身の要約も添える
        const summary = summaries.get(key);
        sp.setAttribute('aria-label', collapsed ? `${t(openLabels[key])}${summary ? `（${summary}）` : ''}` : sp.dataset['label']);
        sp.setAttribute('aria-valuemin', '0');
        sp.setAttribute('aria-valuemax', String(Math.round(max(key))));
        sp.setAttribute('aria-valuenow', String(Math.round(sizes[key])));
        let sum = sp.querySelector<HTMLElement>(':scope > .splitter-summary');
        if (collapsed && summary) {
          if (!sum) {
            sum = document.createElement('span');
            sum.className = 'splitter-summary';
            sum.setAttribute('aria-hidden', 'true');
            sp.append(sum);
          }
          sum.textContent = summary;
        } else sum?.remove();
      }
    }
    applySplit();
  };

  const setSize = (key: PaneKey, value: number, save: boolean) => {
    sizes[key] = Math.max(0, Math.min(value, max(key)));
    if (sizes[key] >= COLLAPSE_BELOW) last[key] = sizes[key];
    apply();
    if (save) persist();
  };

  const toggle = (key: PaneKey) => setSize(key, sizes[key] > 0 ? 0 : last[key] || DEFAULT_SIZES[key], true);

  // ---- パレットとツリーの境目 ----

  const containerHeight = () => leftPane?.clientHeight ?? 0;

  const setPalette = (ratio: number, save: boolean) => {
    palette = sanitizeRatio(ratio);
    if (palette > 0 && palette < 1) lastPalette = palette;
    apply();
    if (save) persist();
  };

  /** パレットの高さ（px）を指定して動かす。畳む・最小の高さの規則は ratioFromHeight に任せる。 */
  const setPaletteHeight = (px: number, save: boolean) => {
    const c = containerHeight();
    setPalette(c > 0 ? ratioFromHeight(px, c) : DEFAULT_PALETTE_RATIO, save);
  };

  const toggleSplit = (side: 'palette' | 'tree') => {
    if (side === 'palette') setPalette(palette <= 0 ? lastPalette : 0, true);
    else setPalette(palette >= 1 ? lastPalette : 1, true);
  };

  for (const b of splitToggles) b.addEventListener('click', () => toggleSplit(b.dataset['splitToggle'] as 'palette' | 'tree'));

  if (paletteSplitter) {
    const sp = paletteSplitter;
    sp.setAttribute('role', 'separator');
    sp.setAttribute('aria-orientation', 'horizontal');
    sp.setAttribute('aria-label', t('パレットとツリーの高さ'));
    sp.title = t('ドラッグで高さを変更、ダブルクリックで既定の比率に戻す');
    sp.tabIndex = 0;
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      root.classList.add('resizing');
      const start = e.clientY;
      const c = containerHeight();
      const startHeight = paletteHeightOf(palette, c);
      // 畳むところまで引いたとき、戻し先は引く前の比率にする（途中の小さい値を覚えてしまわないように）
      const restoreRatio = palette > 0 && palette < 1 ? palette : lastPalette;
      let frame = 0;
      let pending = startHeight;
      const move = (ev: PointerEvent) => {
        pending = startHeight + (ev.clientY - start);
        // 描き直しは 1 フレームに 1 回にまとめる
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0;
          // テスト環境の破棄後に遅れて発火しても DOM を触らない
          if (typeof window === 'undefined') return;
          setPaletteHeight(pending, false);
        });
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        sp.removeEventListener('pointercancel', up);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        root.classList.remove('resizing');
        setPaletteHeight(pending, true);
        if (palette <= 0 || palette >= 1) {
          lastPalette = restoreRatio;
          persist();
        }
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
      sp.addEventListener('pointercancel', up);
    });
    // 既存の 4 本は「畳む」だが、ここは両側が畳める境目なので「既定の比率に戻す」にする
    sp.addEventListener('dblclick', () => setPalette(DEFAULT_PALETTE_RATIO, true));
    sp.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      const now = () => paletteHeightOf(palette, containerHeight());
      if (e.key === 'ArrowUp') setPaletteHeight(now() - step, true);
      else if (e.key === 'ArrowDown') setPaletteHeight(now() + step, true);
      else if (e.key === 'Home') setPalette(0, true);
      else if (e.key === 'End') setPalette(1, true);
      else if (e.key === 'Enter' || e.key === ' ') setPalette(DEFAULT_PALETTE_RATIO, true);
      else return;
      e.preventDefault();
    });
  }

  for (const sp of Array.from(root.querySelectorAll<HTMLElement>('[data-splitter]'))) {
    const key = sp.dataset['splitter'] as PaneKey | 'palette';
    if (key === 'palette') continue;
    splitters.set(key, sp);
    const vertical = key === 'left' || key === 'right';
    const sign = key === 'right' || key === 'bottom' ? -1 : 1;
    sp.setAttribute('role', 'separator');
    sp.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
    sp.tabIndex = 0;

    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 畳んだ帯は、押せば戻すボタンとして振る舞う
      if (sizes[key] === 0) {
        e.preventDefault();
        setSize(key, last[key] || DEFAULT_SIZES[key], true);
        return;
      }
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      root.classList.add('resizing');
      const start = vertical ? e.clientX : e.clientY;
      const startSize = sizes[key];
      let frame = 0;
      let pending = startSize;
      const move = (ev: PointerEvent) => {
        pending = startSize + ((vertical ? ev.clientX : ev.clientY) - start) * sign;
        // 描き直しは 1 フレームに 1 回にまとめる
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0;
          // テスト環境の破棄後に遅れて発火しても DOM を触らない
          if (typeof window === 'undefined') return;
          setSize(key, pending < COLLAPSE_BELOW / 2 ? 0 : pending, false);
        });
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        sp.removeEventListener('pointercancel', up);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        root.classList.remove('resizing');
        setSize(key, pending < COLLAPSE_BELOW / 2 ? 0 : pending, true);
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
      sp.addEventListener('pointercancel', up);
    });
    sp.addEventListener('dblclick', () => toggle(key));
    // キーボードでも動かせるようにする（矢印で 16px、Enter で畳む・戻す）
    sp.addEventListener('keydown', (e) => {
      const grow = vertical ? (key === 'left' ? 'ArrowRight' : 'ArrowLeft') : key === 'top' ? 'ArrowDown' : 'ArrowUp';
      const shrink = vertical ? (key === 'left' ? 'ArrowLeft' : 'ArrowRight') : key === 'top' ? 'ArrowUp' : 'ArrowDown';
      if (e.key === grow) setSize(key, (sizes[key] || 0) + 16, true);
      else if (e.key === shrink) setSize(key, sizes[key] - 16 < COLLAPSE_BELOW / 2 ? 0 : sizes[key] - 16, true);
      else if (e.key === 'Enter' || e.key === ' ') toggle(key);
      else return;
      e.preventDefault();
    });
  }
  apply();

  return {
    toggle,
    expand: (key) => {
      if (sizes[key] === 0) setSize(key, last[key] || DEFAULT_SIZES[key], true);
    },
    isCollapsed: (key) => sizes[key] === 0,
    reset: () => {
      Object.assign(sizes, DEFAULT_SIZES);
      Object.assign(last, DEFAULT_SIZES);
      palette = DEFAULT_PALETTE_RATIO;
      lastPalette = DEFAULT_PALETTE_RATIO;
      bonus.top = 0;
      apply();
      persist();
    },
    collapseTemporarily: (keys) => {
      const before = keys.map((k) => [k, sizes[k]] as const);
      for (const k of keys) sizes[k] = 0;
      apply();
      return () => {
        for (const [k, v] of before) if (sizes[k] === 0) sizes[k] = v;
        apply();
      };
    },
    growTemporarily: (_key, px) => {
      // 中央の列（キャンバス + XML エディタ）の高さから、XML エディタの最低限の高さと仕切りを残した分までしか広げない。
      // 窓の高さの割合で決めると、メニュー・ツールバー・下部パネルの分を無視して広げすぎ、
      // 1366×768 で XML エディタの高さが 0 になった。中央の列の高さが測れない環境では、窓の高さの 85% を上限にする
      const center = root.querySelector<HTMLElement>('.pane.center');
      const column = center?.clientHeight ?? 0;
      const splitterH = splitters.get('top')?.offsetHeight ?? 0;
      const limit = column > 0 ? column - MIN_XML_HEIGHT - Math.max(1, splitterH) : window.innerHeight * 0.85;
      const room = Math.max(0, limit - sizes.top - bonus.top);
      const added = sizes.top === 0 ? 0 : Math.max(0, Math.min(px, room));
      bonus.top += added;
      apply();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        bonus.top = Math.max(0, bonus.top - added);
        apply();
      };
    },
    isSplitCollapsed: (side) => (side === 'palette' ? palette <= 0 : palette >= 1),
    expandSplit: (side) => {
      if (side === 'palette' ? palette <= 0 : palette >= 1) setPalette(lastPalette, true);
    },
    setCollapsedSummary: (key, text) => {
      // 問題の数などが変わるたびに呼ばれるので、変わらなければ描き直さない
      if ((summaries.get(key) ?? null) === (text || null)) return;
      if (text) summaries.set(key, text);
      else summaries.delete(key);
      apply();
    },
  };
}
