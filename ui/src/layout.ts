// ペインの幅と高さを変えられるようにする（仕様書 §4）。ダブルクリックで畳む・戻す。
// - 仕切りの見た目は 1px の線にし、つかめる範囲は前後 4px ずつ広げる（細い線を狙わなくてよいように）
// - 畳んだペインは細い帯として残し、帯を押すと元の大きさに戻す（どこへ消えたか分からなくならないように）
// - 大きさの保存はドラッグを離したときだけ行う（動かしている間に毎回書き込むと localStorage への書き込みが続くため）

import { t } from './i18n';

const KEY = 'sash.layout';

export type PaneKey = 'left' | 'right' | 'top' | 'bottom';

interface Sizes {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_SIZES: Readonly<Sizes> = { left: 248, right: 300, top: 260, bottom: 200 };

/** これより小さくしたら畳んだものとみなす。 */
const COLLAPSE_BELOW = 48;

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
}

function load(): { sizes: Sizes; last: Sizes } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Sizes> & { last?: Partial<Sizes> };
    const pick = (o: Partial<Sizes> | undefined): Partial<Sizes> =>
      Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => k in DEFAULT_SIZES && typeof v === 'number' && Number.isFinite(v) && v >= 0)) as Partial<Sizes>;
    return { sizes: { ...DEFAULT_SIZES, ...pick(raw) }, last: { ...DEFAULT_SIZES, ...pick(raw.last) } };
  } catch {
    return { sizes: { ...DEFAULT_SIZES }, last: { ...DEFAULT_SIZES } };
  }
}

export function mountLayout(root: HTMLElement): LayoutHandle {
  const { sizes, last } = load();
  const splitters = new Map<PaneKey, HTMLElement>();

  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...sizes, last }));
    } catch {
      // 保存できなくても動作には影響しない
    }
  };

  const apply = () => {
    for (const key of Object.keys(DEFAULT_SIZES) as PaneKey[]) {
      const collapsed = sizes[key] === 0;
      root.style.setProperty(`--${key}`, `${sizes[key]}px`);
      root.classList.toggle(`collapsed-${key}`, collapsed);
      const sp = splitters.get(key);
      if (sp) {
        sp.classList.toggle('collapsed', collapsed);
        sp.dataset['title'] ??= sp.title;
        sp.title = collapsed ? t('クリックで元の大きさに戻す') : sp.dataset['title'];
        sp.setAttribute('aria-valuenow', String(Math.round(sizes[key])));
      }
    }
  };

  const max = (key: PaneKey) => ((key === 'left' || key === 'right' ? window.innerWidth : window.innerHeight) * 0.7);

  const setSize = (key: PaneKey, value: number, save: boolean) => {
    sizes[key] = Math.max(0, Math.min(value, max(key)));
    if (sizes[key] >= COLLAPSE_BELOW) last[key] = sizes[key];
    apply();
    if (save) persist();
  };

  const toggle = (key: PaneKey) => setSize(key, sizes[key] > 0 ? 0 : last[key] || DEFAULT_SIZES[key], true);

  for (const sp of Array.from(root.querySelectorAll<HTMLElement>('[data-splitter]'))) {
    const key = sp.dataset['splitter'] as PaneKey;
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
  };
}
