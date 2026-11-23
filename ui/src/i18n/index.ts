// 画面の言語（仕様書 §9.3：日本語を既定にし、英語UIも用意する）。
// 日本語の文言そのものをキーにする（gettext と同じ考え方）。英語の辞書にない文言は日本語のまま出す。
// 言語はモジュールの読み込み時に決まるので、切り替えたときは画面を読み込み直す。

import { en as enA } from './en/a';
import { en as enB } from './en/b';
import { en as enC } from './en/c';
import { en as enD } from './en/d';
import { en as enE } from './en/e';

export type Lang = 'ja' | 'en';

const STORAGE_KEY = 'sash.lang';

function initialLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'ja';
  } catch {
    return 'ja';
  }
}

export const lang: Lang = initialLang();

const dictionary: Readonly<Record<string, string>> = { ...enA, ...enB, ...enC, ...enD, ...enE };

/** 言語を保存する。反映するには画面の読み込み直しが必要。 */
export function storeLang(next: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 保存できない環境では日本語のまま
  }
}

/**
 * 文言を今の言語にする。{name} の形の差し込みに対応する。
 * 例：t('問題 {n}', { n: 3 }) → 英語なら "Problems 3"
 */
export function t(ja: string, params?: Readonly<Record<string, string | number>>): string {
  const text = lang === 'en' ? dictionary[ja] ?? ja : ja;
  return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}

/** 辞書にない日本語の文言（テスト用）。 */
export function missingKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => !(k in dictionary));
}

/** index.html の data-i18n（中身）と data-i18n-title（title 属性）を訳す。 */
export function translateDocument(root: ParentNode = document): void {
  if (lang === 'ja') return;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) el.textContent = t(el.dataset['i18n']!);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n-title]'))) el.title = t(el.dataset['i18nTitle']!);
  document.documentElement.lang = lang;
}
