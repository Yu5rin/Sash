import { beforeEach, describe, expect, it } from 'vitest';
import { CHROME_HEIGHT, DEFAULT_PALETTE_RATIO, DEFAULT_SIZES, MIN_CENTER_WIDTH, MIN_XML_HEIGHT, PANE_MIN, fitSizes, maxSizeFor, mountLayout, paletteHeightOf, parseLayout, ratioFromHeight, sanitizeLastRatio, sanitizeRatio } from '../src/layout';

describe('パレットの比率の読み込み', () => {
  it('保存がなければ既定の比率になる', () => {
    expect(parseLayout(null).palette).toBe(DEFAULT_PALETTE_RATIO);
    expect(parseLayout('{}').palette).toBe(DEFAULT_PALETTE_RATIO);
    expect(parseLayout('{}').lastPalette).toBe(DEFAULT_PALETTE_RATIO);
  });

  it('範囲外は 0〜1 に丸め、壊れた値は既定にする', () => {
    expect(sanitizeRatio(1.7)).toBe(1);
    expect(sanitizeRatio(-3)).toBe(0);
    expect(sanitizeRatio('x')).toBe(DEFAULT_PALETTE_RATIO);
    expect(sanitizeRatio(Number.NaN)).toBe(DEFAULT_PALETTE_RATIO);
    expect(parseLayout('{"palette":"abc","last":{"palette":null}}').palette).toBe(DEFAULT_PALETTE_RATIO);
    expect(parseLayout('{"palette":9}').palette).toBe(1);
    expect(parseLayout('これはJSONではない').palette).toBe(DEFAULT_PALETTE_RATIO);
  });

  it('畳む前の比率は、畳んだ状態（0・1）にならない', () => {
    expect(sanitizeLastRatio(0)).toBe(DEFAULT_PALETTE_RATIO);
    expect(sanitizeLastRatio(1)).toBe(DEFAULT_PALETTE_RATIO);
    expect(sanitizeLastRatio(0.6)).toBe(0.6);
    expect(parseLayout('{"palette":0,"last":{"palette":0.3}}').lastPalette).toBe(0.3);
  });

  it('下部パネルの既定は 140px。保存済みの大きさはそのまま使う', () => {
    expect(DEFAULT_SIZES.bottom).toBe(140);
    expect(parseLayout('{"bottom":200}').sizes.bottom).toBe(200);
    expect(parseLayout('{}').sizes.bottom).toBe(140);
  });
});

describe('パレットの高さと比率の変換', () => {
  it('各側は 72px を下回らない', () => {
    expect(ratioFromHeight(40, 600)).toBeCloseTo(72 / 600);
    expect(ratioFromHeight(540, 600)).toBeCloseTo((600 - 1 - 72) / 600);
  });

  it('36px 未満まで引いたらその側を畳む（0＝パレット、1＝ツリー）', () => {
    expect(ratioFromHeight(35, 600)).toBe(0);
    expect(ratioFromHeight(0, 600)).toBe(0);
    expect(ratioFromHeight(600 - 1 - 35, 600)).toBe(1);
    expect(ratioFromHeight(700, 600)).toBe(1);
  });

  it('中間はそのまま比率にする。高さが分からないときは既定', () => {
    expect(ratioFromHeight(270, 600)).toBeCloseTo(0.45);
    expect(ratioFromHeight(270, 0)).toBe(DEFAULT_PALETTE_RATIO);
  });

  it('畳んだ側は見出し（28px）だけ残る', () => {
    expect(paletteHeightOf(0, 600)).toBe(28);
    expect(paletteHeightOf(1, 600)).toBe(600 - 1 - 28);
    expect(paletteHeightOf(0.5, 600)).toBe(300);
  });
});

/** 左ペインを含む最小の画面。jsdom は大きさを持たないので、左ペインの高さを 600 にしておく。 */
function fixture(): HTMLElement {
  document.body.innerHTML = `
    <div id="app">
      <aside class="pane left">
        <section class="palette"><h2><button data-split-toggle="palette" aria-expanded="true">パレット</button></h2><div id="palette"></div></section>
        <div class="splitter h" data-splitter="palette"></div>
        <section class="tree-pane"><h2><button data-split-toggle="tree" aria-expanded="true">ツリー</button></h2><div id="tree"></div></section>
      </aside>
      <div class="splitter v" data-splitter="left" aria-label="パレットとツリーの幅" title="x"></div>
      <div class="splitter h" data-splitter="top" aria-label="キャンバスの高さ" title="x"></div>
      <div class="splitter h" data-splitter="bottom" aria-label="下部パネルの高さ" title="x"></div>
    </div>`;
  const root = document.getElementById('app')!;
  Object.defineProperty(root.querySelector('.pane.left'), 'clientHeight', { value: 600, configurable: true });
  return root;
}

const key = (el: Element, k: string, shift = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
const stored = () => JSON.parse(localStorage.getItem('sash.layout') ?? '{}') as { palette?: number; last?: { palette?: number } };

describe('パレットとツリーの仕切り', () => {
  beforeEach(() => localStorage.clear());

  it('role と aria-value を持つ。畳んでいないときは比率の百分率', () => {
    const root = fixture();
    mountLayout(root);
    const sp = root.querySelector('[data-splitter="palette"]')!;
    expect(sp.getAttribute('role')).toBe('separator');
    expect(sp.getAttribute('aria-orientation')).toBe('horizontal');
    expect(sp.getAttribute('aria-valuemin')).toBe('0');
    expect(sp.getAttribute('aria-valuemax')).toBe('100');
    expect(sp.getAttribute('aria-valuenow')).toBe('45');
    expect(root.style.getPropertyValue('--palette-ratio')).toBe('0.45');
  });

  it('既存の 4 本の仕切りにも aria-valuemin / max が付く', () => {
    const root = fixture();
    mountLayout(root);
    const left = root.querySelector('[data-splitter="left"]')!;
    expect(left.getAttribute('aria-valuemin')).toBe('0');
    expect(Number(left.getAttribute('aria-valuemax'))).toBeGreaterThan(0);
  });

  it('↑↓ で 16px、Shift で 64px 動き、離したときに保存する', () => {
    const root = fixture();
    mountLayout(root);
    const sp = root.querySelector('[data-splitter="palette"]')!;
    key(sp, 'ArrowDown');
    expect(Number(root.style.getPropertyValue('--palette-ratio')) * 600).toBeCloseTo(270 + 16);
    key(sp, 'ArrowUp', true);
    expect(Number(root.style.getPropertyValue('--palette-ratio')) * 600).toBeCloseTo(270 + 16 - 64);
    expect(stored().palette).toBeCloseTo((270 + 16 - 64) / 600);
  });

  it('Home でパレット、End でツリーを畳む。同時には畳まない', () => {
    const root = fixture();
    const h = mountLayout(root);
    const sp = root.querySelector('[data-splitter="palette"]')!;
    key(sp, 'Home');
    expect(h.isSplitCollapsed('palette')).toBe(true);
    expect(h.isSplitCollapsed('tree')).toBe(false);
    expect(root.classList.contains('collapsed-palette')).toBe(true);
    expect(root.querySelector('[data-split-toggle="palette"]')!.getAttribute('aria-expanded')).toBe('false');
    key(sp, 'End');
    expect(h.isSplitCollapsed('palette')).toBe(false);
    expect(h.isSplitCollapsed('tree')).toBe(true);
    expect(root.classList.contains('collapsed-palette')).toBe(false);
    expect(root.classList.contains('collapsed-tree')).toBe(true);
    expect(sp.getAttribute('aria-valuetext')).toBe('ツリーを畳んでいます');
  });

  it('畳んだ状態から ↓ で開く（最小 72px まで戻る）', () => {
    const root = fixture();
    const h = mountLayout(root);
    const sp = root.querySelector('[data-splitter="palette"]')!;
    key(sp, 'Home');
    key(sp, 'ArrowDown');
    expect(h.isSplitCollapsed('palette')).toBe(false);
    expect(Number(root.style.getPropertyValue('--palette-ratio')) * 600).toBeCloseTo(72);
  });

  it('Enter とダブルクリックで既定の比率に戻る', () => {
    const root = fixture();
    mountLayout(root);
    const sp = root.querySelector('[data-splitter="palette"]')!;
    key(sp, 'ArrowDown', true);
    key(sp, 'Enter');
    expect(root.style.getPropertyValue('--palette-ratio')).toBe('0.45');
    key(sp, 'ArrowDown', true);
    sp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.style.getPropertyValue('--palette-ratio')).toBe('0.45');
  });

  it('見出しのボタンで畳み、もう一度押すと畳む前の比率に戻る', () => {
    const root = fixture();
    const h = mountLayout(root);
    const sp = root.querySelector('[data-splitter="palette"]')!;
    key(sp, 'ArrowDown', true);
    const before = root.style.getPropertyValue('--palette-ratio');
    const btn = root.querySelector<HTMLElement>('[data-split-toggle="palette"]')!;
    btn.click();
    expect(h.isSplitCollapsed('palette')).toBe(true);
    btn.click();
    expect(h.isSplitCollapsed('palette')).toBe(false);
    expect(root.style.getPropertyValue('--palette-ratio')).toBe(before);
  });

  it('ツリーを畳んでいるときにパレットの見出しを押すと、ツリーが開いてパレットが畳まれる', () => {
    const root = fixture();
    const h = mountLayout(root);
    root.querySelector<HTMLElement>('[data-split-toggle="tree"]')!.click();
    expect(h.isSplitCollapsed('tree')).toBe(true);
    root.querySelector<HTMLElement>('[data-split-toggle="palette"]')!.click();
    expect(h.isSplitCollapsed('tree')).toBe(false);
    expect(h.isSplitCollapsed('palette')).toBe(true);
  });

  it('expandSplit は畳んだ側だけを開く（F6・Ctrl+2 で移るとき）', () => {
    const root = fixture();
    const h = mountLayout(root);
    h.expandSplit('tree');
    expect(h.isSplitCollapsed('tree')).toBe(false);
    key(root.querySelector('[data-splitter="palette"]')!, 'End');
    h.expandSplit('palette');
    expect(h.isSplitCollapsed('tree')).toBe(true);
    h.expandSplit('tree');
    expect(h.isSplitCollapsed('tree')).toBe(false);
  });

  it('保存した比率を次の起動で読む', () => {
    const root = fixture();
    mountLayout(root);
    key(root.querySelector('[data-splitter="palette"]')!, 'ArrowDown', true);
    const saved = stored().palette!;
    const again = fixture();
    mountLayout(again);
    expect(Number(again.style.getPropertyValue('--palette-ratio'))).toBeCloseTo(saved);
  });

  it('畳んだまま保存しても、開き直すと畳む前の比率に戻る', () => {
    const root = fixture();
    mountLayout(root);
    key(root.querySelector('[data-splitter="palette"]')!, 'ArrowDown', true);
    const open = stored().palette!;
    key(root.querySelector('[data-splitter="palette"]')!, 'Home');
    expect(stored().palette).toBe(0);
    expect(stored().last?.palette).toBeCloseTo(open);
    const again = fixture();
    const h = mountLayout(again);
    expect(h.isSplitCollapsed('palette')).toBe(true);
    h.expandSplit('palette');
    expect(Number(again.style.getPropertyValue('--palette-ratio'))).toBeCloseTo(open);
  });

  it('reset で比率も既定に戻り、保存も書き換わる', () => {
    const root = fixture();
    const h = mountLayout(root);
    key(root.querySelector('[data-splitter="palette"]')!, 'End');
    h.reset();
    expect(h.isSplitCollapsed('tree')).toBe(false);
    expect(root.style.getPropertyValue('--palette-ratio')).toBe('0.45');
    expect(stored().palette).toBe(0.45);
  });
});

describe('一時的な操作', () => {
  beforeEach(() => localStorage.clear());

  it('growTemporarily はキャンバスの高さを足し、保存せず、restore で戻る', () => {
    const root = fixture();
    const h = mountLayout(root);
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    const base = root.style.getPropertyValue('--top');
    expect(base).toBe(`${DEFAULT_SIZES.top}px`);
    const restore = h.growTemporarily('top', 200);
    expect(root.style.getPropertyValue('--top')).toBe(`${DEFAULT_SIZES.top + 200}px`);
    // ほかの操作で保存しても、足した分は書かない
    key(root.querySelector('[data-splitter="palette"]')!, 'ArrowDown');
    expect(JSON.parse(localStorage.getItem('sash.layout')!).top).toBe(DEFAULT_SIZES.top);
    restore();
    expect(root.style.getPropertyValue('--top')).toBe(base);
    restore();
    expect(root.style.getPropertyValue('--top')).toBe(base);
  });

  it('growTemporarily は窓に収まる上限（中央の行から XML エディタの最低高さを残した分）を超えない', () => {
    const root = fixture();
    const h = mountLayout(root);
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    h.growTemporarily('top', 5000);
    // 600 − メニューとツールバー 76 − 下部 140 − 仕切り 1 − 仕切り 1 − XML の最低 120
    expect(parseFloat(root.style.getPropertyValue('--top'))).toBeCloseTo(600 - CHROME_HEIGHT - 140 - 1 - 1 - MIN_XML_HEIGHT);
  });

  it('growTemporarily は中央の列の高さから XML エディタの最低高さと仕切りを残す（1366×768 で XML エディタが 0 にならない）', () => {
    const root = fixture();
    const center = document.createElement('main');
    center.className = 'pane center';
    // 1366×768 で、メニュー・ツールバー・下部パネルを除いた中央の列の高さ
    Object.defineProperty(center, 'clientHeight', { value: 551, configurable: true });
    root.append(center);
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    const h = mountLayout(root);
    h.growTemporarily('top', 5000);
    const shown = parseFloat(root.style.getPropertyValue('--top'));
    // 仕切り（jsdom では高さ 0 なので 1px とみなす）と最低高さを残す
    expect(shown).toBe(551 - MIN_XML_HEIGHT - 1);
    // 窓の高さの 85%（652px）で切ると、中央の列（551px）を超えて XML エディタが 0 になる
    expect(shown).toBeLessThan(768 * 0.85);
  });

  it('畳んだ帯には要約を出し、名前を「開く」にする', () => {
    const root = fixture();
    const h = mountLayout(root);
    h.setCollapsedSummary('bottom', '問題 2 ・ コールバック 3');
    const sp = root.querySelector('[data-splitter="bottom"]')!;
    expect(sp.querySelector('.splitter-summary')).toBeNull();
    h.toggle('bottom');
    expect(sp.getAttribute('aria-label')).toBe('下部パネルを開く（問題 2 ・ コールバック 3）');
    expect(sp.querySelector('.splitter-summary')!.textContent).toBe('問題 2 ・ コールバック 3');
    h.toggle('bottom');
    expect(sp.getAttribute('aria-label')).toBe('下部パネルの高さ');
    expect(sp.querySelector('.splitter-summary')).toBeNull();
  });
});

describe('窓に合わせた丸め（総点検 G-1）', () => {
  const vp = { width: 1366, height: 768 };
  const sizes = { left: 848, right: 320, top: 260, bottom: 140 };

  it('左右の合計が窓からはみ出すとき、動かしていない側から下限まで縮める', () => {
    const f = fitSizes(sizes, vp, 'left');
    // 1366 − 中央の最小 320 − 仕切り 2 = 1044 に収まる。右を先に下限（260）まで縮める
    expect(f.left + f.right).toBeLessThanOrEqual(1366 - MIN_CENTER_WIDTH - 2);
    expect(f.right).toBe(PANE_MIN.right);
    expect(f.left).toBe(1044 - PANE_MIN.right);
  });

  it('右を動かしているときは、左を先に縮める', () => {
    const f = fitSizes({ ...sizes, left: 700, right: 700 }, vp, 'right');
    expect(f.right).toBe(700);
    expect(f.left).toBe(1044 - 700);
  });

  it('保存値そのものは変えない（元の窓に戻せば元の大きさに戻る）', () => {
    const copy = { ...sizes };
    fitSizes(sizes, vp);
    expect(sizes).toEqual(copy);
    expect(fitSizes(sizes, { width: 2400, height: 1200 })).toEqual(sizes);
  });

  it('畳んでいるペインは 0 のまま。下限より小さい窓でも下限を割らない', () => {
    expect(fitSizes({ ...sizes, left: 0 }, vp).left).toBe(0);
    expect(fitSizes(sizes, { width: 500, height: 768 }, 'left').right).toBe(PANE_MIN.right);
  });

  it('縦は、下部パネルとキャンバスを中央の行に収める', () => {
    const f = fitSizes({ ...sizes, bottom: 600, top: 600 }, vp);
    expect(f.bottom).toBe(768 - CHROME_HEIGHT - 1 - 200);
    // 中央の行に XML エディタの最低高さが残る
    expect(768 - CHROME_HEIGHT - 1 - f.bottom - 1 - f.top).toBeGreaterThanOrEqual(MIN_XML_HEIGHT);
  });

  it('ドラッグの上限は、もう片方を下限まで縮める前提で決まる', () => {
    expect(maxSizeFor('left', sizes, vp)).toBe(1366 - MIN_CENTER_WIDTH - 2 - PANE_MIN.right);
    expect(maxSizeFor('bottom', sizes, vp)).toBe(768 - CHROME_HEIGHT - 1 - 200);
  });

  it('mountLayout は保存値が窓より大きくても、表示する値を窓に収める。resize でも丸め直す', async () => {
    localStorage.setItem('sash.layout', JSON.stringify({ left: 848, right: 320, top: 260, bottom: 140 }));
    Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    const root = fixture();
    mountLayout(root);
    const px = (k: string) => parseFloat(root.style.getPropertyValue(`--${k}`));
    expect(px('left') + px('right')).toBeLessThanOrEqual(1366 - MIN_CENTER_WIDTH - 2);
    // 窓を広げれば保存値どおりに戻る
    Object.defineProperty(window, 'innerWidth', { value: 2400, configurable: true });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(px('left')).toBe(848);
    expect(JSON.parse(localStorage.getItem('sash.layout')!).left).toBe(848);
  });

  it('下限（左 200px）で止まり、さらに縮めると畳む', () => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true });
    const root = fixture();
    const h = mountLayout(root);
    const sp = root.querySelector('[data-splitter="left"]')!;
    key(sp, 'ArrowLeft');
    expect(parseFloat(root.style.getPropertyValue('--left'))).toBe(DEFAULT_SIZES.left - 16);
    for (let i = 0; i < 2; i++) key(sp, 'ArrowLeft');
    expect(parseFloat(root.style.getPropertyValue('--left'))).toBe(PANE_MIN.left);
    key(sp, 'ArrowLeft');
    expect(h.isCollapsed('left')).toBe(true);
  });
});

describe('下部パネルの自動開閉（総点検 B-1）', () => {
  beforeEach(() => localStorage.clear());

  it('問題がなければ帯に畳み、出たら開く。保存は書き換えない', () => {
    const root = fixture();
    const h = mountLayout(root);
    expect(h.isCollapsed('bottom')).toBe(false);
    h.setBottomAuto(false);
    expect(h.isCollapsed('bottom')).toBe(true);
    expect(root.classList.contains('collapsed-bottom')).toBe(true);
    h.setBottomAuto(true);
    expect(h.isCollapsed('bottom')).toBe(false);
    expect(root.style.getPropertyValue('--bottom')).toBe(`${DEFAULT_SIZES.bottom}px`);
    // 自動の開閉だけでは何も保存しない
    expect(localStorage.getItem('sash.layout')).toBeNull();
  });

  it('自動で畳んでいるあいだに別の操作で保存しても、下部パネルの大きさは 0 にならない', () => {
    const root = fixture();
    const h = mountLayout(root);
    h.setBottomAuto(false);
    key(root.querySelector('[data-splitter="left"]')!, 'ArrowRight');
    expect(JSON.parse(localStorage.getItem('sash.layout')!).bottom).toBe(DEFAULT_SIZES.bottom);
    expect(JSON.parse(localStorage.getItem('sash.layout')!).bottomAuto).toBe(true);
  });

  it('利用者が開閉・ドラッグしたら、以後は自動にしない（bottomAuto: false を保存）', () => {
    const root = fixture();
    const h = mountLayout(root);
    h.setBottomAuto(false);
    h.toggle('bottom'); // 利用者が開いた
    expect(h.isCollapsed('bottom')).toBe(false);
    expect(JSON.parse(localStorage.getItem('sash.layout')!).bottomAuto).toBe(false);
    h.setBottomAuto(false);
    expect(h.isCollapsed('bottom')).toBe(false);
  });

  it('保存された bottomAuto: false は、次の起動でも自動にしない。古い保存で大きさを変えていた人も自動にしない', () => {
    expect(parseLayout('{"bottomAuto":false}').bottomAuto).toBe(false);
    expect(parseLayout('{"bottom":200}').bottomAuto).toBe(false);
    expect(parseLayout('{"bottom":140}').bottomAuto).toBe(true);
    expect(parseLayout(null).bottomAuto).toBe(true);
    localStorage.setItem('sash.layout', JSON.stringify({ ...DEFAULT_SIZES, bottomAuto: false }));
    const h = mountLayout(fixture());
    h.setBottomAuto(false);
    expect(h.isCollapsed('bottom')).toBe(false);
  });

  it('既定のレイアウトに戻すと、自動に戻る', () => {
    const root = fixture();
    const h = mountLayout(root);
    h.toggle('bottom');
    h.reset();
    h.setBottomAuto(false);
    expect(h.isCollapsed('bottom')).toBe(true);
  });
});
