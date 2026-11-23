// キャンバスのヒントの試し表示（仕様書 §5.2）。
// コントロールにマウスを乗せると Excel に近い形のヒント（太字の見出し＋本文）を出し、
// 「キーヒントを表示」ではキーヒント（Alt を押したときの文字）を重ねて見せる。

import { h } from '../dom';
import { t } from '../i18n';

export interface ScreentipContent {
  /** 太字の見出し。screentip がなければラベル（Excel はラベルを見出しにする）。 */
  title: string;
  /** 本文（supertip）。 */
  body: string;
  /** 見出し・本文が VBA（getScreentip / getSupertip）で決まる。 */
  dynamicTitle: boolean;
  dynamicBody: boolean;
  id: string;
}

/** ヒントに出す中身を決める。label は表示中のラベル（getLabel の試し表示を含む）。 */
export function screentipContent(el: Element, label: string): ScreentipContent {
  const dynamicTitle = el.hasAttribute('getScreentip');
  const dynamicBody = el.hasAttribute('getSupertip');
  return {
    title: dynamicTitle ? '' : el.getAttribute('screentip') ?? label,
    body: dynamicBody ? '' : el.getAttribute('supertip') ?? '',
    dynamicTitle,
    dynamicBody,
    id: el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName,
  };
}

/**
 * Excel の組み込みタブのキーヒント（日本語版・Microsoft 365 の画面からの見積もり。実機で確かめていない）。
 * 自分のタブのキーヒントとの重なりを見つけるために使う。
 */
export const BUILTIN_TAB_KEYTIPS: Readonly<Record<string, string>> = {
  TabHome: 'H',
  TabInsert: 'N',
  TabPageLayoutExcel: 'P',
  TabFormulas: 'M',
  TabData: 'A',
  TabReview: 'R',
  TabView: 'W',
  TabDeveloper: 'L',
  HelpTab: 'Y2',
};

/** 同じキーヒント（大文字小文字は区別しない）を持つものの鍵を返す。 */
export function duplicateKeytips(entries: readonly { key: string; keytip: string }[]): Set<string> {
  const byTip = new Map<string, string[]>();
  for (const e of entries) {
    const tip = e.keytip.trim().toUpperCase();
    if (!tip) continue;
    byTip.set(tip, [...(byTip.get(tip) ?? []), e.key]);
  }
  const out = new Set<string>();
  for (const keys of byTip.values()) if (keys.length > 1) for (const k of keys) out.add(k);
  return out;
}

// ---- マウスを乗せたときのヒント ----

/** Excel はすぐには出さないので、少し待ってから出す（動かしただけでちらつかないように）。 */
const SHOW_DELAY_MS = 500;

let tipEl: HTMLElement | null = null;
let timer: number | undefined;
let currentNode: HTMLElement | null = null;

export function hideScreentip(): void {
  window.clearTimeout(timer);
  timer = undefined;
  currentNode = null;
  tipEl?.remove();
  tipEl = null;
}

/**
 * host の中の [data-tip] のノードにヒントを付ける。resolve はノードから中身を返す（出さないなら null）。
 * ヒントは画面基準（fixed）で body に置く。リボンを縮小表示（zoom）しても文字を読める大きさで出すため。
 */
export function attachScreentips(host: HTMLElement, resolve: (node: HTMLElement) => ScreentipContent | null): void {
  host.addEventListener('mouseover', (e) => {
    const node = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (node === currentNode) return;
    hideScreentip();
    if (!node || !host.contains(node) || node.closest('.rb-menu-popup')) return;
    currentNode = node;
    timer = window.setTimeout(() => {
      if (currentNode !== node || !node.isConnected) return;
      const content = resolve(node);
      if (content) show(node, content);
    }, SHOW_DELAY_MS);
  });
  host.addEventListener('mouseleave', hideScreentip);
  for (const type of ['mousedown', 'dragstart', 'wheel', 'keydown', 'contextmenu'] as const) host.addEventListener(type, hideScreentip, true);
  window.addEventListener('scroll', hideScreentip, true);
}

function show(node: HTMLElement, c: ScreentipContent): void {
  tipEl?.remove();
  const vba = t('VBA で決まります');
  tipEl = h(
    'div',
    { class: 'rb-screentip', role: 'tooltip' },
    h('div', { class: `rb-screentip-title${c.dynamicTitle ? ' dynamic' : ''}` }, c.dynamicTitle ? vba : c.title || c.id),
    c.dynamicBody || c.body ? h('div', { class: `rb-screentip-body${c.dynamicBody ? ' dynamic' : ''}` }, c.dynamicBody ? vba : c.body) : null,
    h('div', { class: 'rb-screentip-id' }, c.id),
  );
  document.body.append(tipEl);
  // Excel はリボンのすぐ下にヒントを出すので、リボン本体の下端にそろえる
  const r = node.getBoundingClientRect();
  const body = node.closest('.rb-body')?.getBoundingClientRect();
  const top = Math.max(r.bottom, body?.bottom ?? r.bottom) + 2;
  const w = tipEl.offsetWidth;
  const ht = tipEl.offsetHeight;
  const left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top + ht > window.innerHeight - 4 ? Math.max(4, r.top - ht - 2) : top}px`;
}
