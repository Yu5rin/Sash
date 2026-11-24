// 小さな DOM 組み立てヘルパー。

import { t } from './i18n';

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

/** SVG 文字列から要素を作る。 */
export function svg(markup: string): SVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGElement;
}

export function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(t('#{id} がありません', { id }));
  return el as T;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: number | undefined;
  return (...args: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      // テスト環境の破棄後に遅れて発火しても、画面の無い所で呼ばない
      if (typeof window === 'undefined') return;
      fn(...args);
    }, ms);
  };
}

/**
 * checkVisibility() に渡す設定。visibility: hidden も「見えない」に数える指定は、Chromium 121 で visibilityProperty に
 * 改名された（105〜120 は checkVisibilityCSS）。下限の Chromium 109 でも効くよう両方渡す。
 * 変数に入れているのは、TS の型に無い古い名前を、直接書いた余計なプロパティの検査にかけずに渡すため。
 */
export const VISIBILITY_OPTIONS = { visibilityProperty: true, checkVisibilityCSS: true };
