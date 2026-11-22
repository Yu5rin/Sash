// ペインの幅と高さを変えられるようにする（仕様書 §4）。ダブルクリックで畳む・戻す。

const KEY = 'sash.layout';

interface Sizes {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const defaults: Sizes = { left: 240, right: 300, top: 260, bottom: 160 };

function load(): Sizes {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Sizes>) };
  } catch {
    return { ...defaults };
  }
}

export function mountLayout(root: HTMLElement): void {
  const sizes = load();
  const apply = () => {
    root.style.setProperty('--left', `${sizes.left}px`);
    root.style.setProperty('--right', `${sizes.right}px`);
    root.style.setProperty('--top', `${sizes.top}px`);
    root.style.setProperty('--bottom', `${sizes.bottom}px`);
    try {
      localStorage.setItem(KEY, JSON.stringify(sizes));
    } catch {
      // 保存できなくても動作には影響しない
    }
  };
  apply();

  for (const sp of Array.from(root.querySelectorAll<HTMLElement>('[data-splitter]'))) {
    const key = sp.dataset['splitter'] as keyof Sizes;
    const vertical = key === 'left' || key === 'right';
    const sign = key === 'right' || key === 'bottom' ? -1 : 1;
    let last = sizes[key] || defaults[key];
    sp.addEventListener('pointerdown', (e) => {
      sp.setPointerCapture(e.pointerId);
      const start = vertical ? e.clientX : e.clientY;
      const startSize = sizes[key];
      const move = (ev: PointerEvent) => {
        const delta = ((vertical ? ev.clientX : ev.clientY) - start) * sign;
        sizes[key] = Math.max(0, Math.min(startSize + delta, (vertical ? window.innerWidth : window.innerHeight) * 0.7));
        apply();
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        if (sizes[key] > 40) last = sizes[key];
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => {
      sizes[key] = sizes[key] > 0 ? 0 : last;
      apply();
    });
  }
}
