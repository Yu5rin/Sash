// コマンドパレット（仕様書 §9.3）。Ctrl+K で開き、すべての操作を名前で呼べる。
// - ひらがな・カタカナ、全角・半角、大文字・小文字を区別せずに探す
// - 何も打っていないときは、最近使ったものを上に出す
// - 開いている間はアプリ全体のショートカットを止める（modal.ts のレイヤーとして積むので isModalOpen() が true になる）

import { fuzzyScore } from '../catalog/catalog';
import { h } from '../dom';
import { t } from '../i18n';
import { normalizeForSearch } from '../shell/text';
import { pushLayer } from './modal';

export interface Command {
  id: string;
  title: string;
  /** 分類（例：ファイル、編集、追加、レシピ）。 */
  group: string;
  shortcut?: string;
  /** 検索に使う別名。 */
  keywords?: string;
  enabled?: () => boolean;
  run: () => void;
}

const RECENT_KEY = 'sash.commands.recent';

function recentIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 10)));
  } catch {
    // 記録できなくても動作には影響しない
  }
}

export function rankCommands(commands: readonly Command[], query: string, recent: readonly string[] = []): Command[] {
  const q = normalizeForSearch(query.trim());
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? 99 : i;
  };
  const scored = commands
    .map((c) => {
      if (!q) return { c, s: 1 };
      const title = normalizeForSearch(c.title);
      const s = Math.max(fuzzyScore(q, title), fuzzyScore(q, normalizeForSearch(`${c.group} ${c.title}`)) * 0.9, fuzzyScore(q, normalizeForSearch(c.keywords ?? '')) * 0.8);
      // 最近使ったものを少しだけ上げる（同じくらいの一致なら、よく使うほうを先に）
      return { c, s: s > 0 ? s + Math.max(0, 10 - rank(c.id)) : 0 };
    })
    .filter((x) => x.s > 0);
  return scored.sort((a, b) => (q ? b.s - a.s : 0) || rank(a.c.id) - rank(b.c.id)).map((x) => x.c);
}

let open = false;

export function openCommandPalette(commands: () => Command[]): void {
  if (open) return;
  open = true;
  const all = commands().filter((c) => c.enabled?.() ?? true);
  const input = h('input', { type: 'search', placeholder: t('コマンドを検索（例：保存、ボタン、レシピ、テーマ）'), spellcheck: false, 'aria-label': t('コマンドを検索'), role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'command-results', 'aria-autocomplete': 'list' });
  const list = h('ul', { class: 'palette-results', role: 'listbox', id: 'command-results', 'aria-label': t('コマンド') });
  let items: Command[] = [];
  let index = 0;

  const run = (c: Command | undefined) => {
    if (!c) return;
    layer.close();
    remember(c.id);
    c.run();
  };
  const render = () => {
    const recent = recentIds();
    items = rankCommands(all, input.value, recent).slice(0, 80);
    index = Math.min(index, Math.max(items.length - 1, 0));
    if (items.length === 0) {
      list.replaceChildren(h('li', { class: 'palette-results-empty', role: 'presentation' }, input.value.trim() ? t('「{query}」に一致するコマンドはありません', { query: input.value.trim() }) : t('使えるコマンドはありません')));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const recentCount = input.value.trim() ? 0 : items.filter((c) => recent.includes(c.id)).length;
    const rows: HTMLElement[] = [];
    items.forEach((c, i) => {
      if (recentCount > 0 && i === 0) rows.push(h('li', { class: 'palette-results-head', role: 'presentation' }, t('最近使ったもの')));
      if (recentCount > 0 && i === recentCount) rows.push(h('li', { class: 'palette-results-head', role: 'presentation' }, t('すべてのコマンド')));
      rows.push(h('li', { id: `cmd-${i}`, role: 'option', class: i === index ? 'active' : '', 'aria-selected': String(i === index), onmousedown: (e: MouseEvent) => { e.preventDefault(); run(c); }, onmousemove: () => { if (index !== i) { index = i; render(); } } },
        h('span', { class: 'cmd-group' }, c.group),
        h('span', { class: 'cmd-title' }, c.title),
        c.shortcut ? h('kbd', null, c.shortcut) : null));
    });
    list.replaceChildren(...rows);
    input.setAttribute('aria-activedescendant', `cmd-${index}`);
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    index = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') index = Math.min(index + 1, items.length - 1);
    else if (e.key === 'ArrowUp') index = Math.max(index - 1, 0);
    else if (e.key === 'PageDown') index = Math.min(index + 8, items.length - 1);
    else if (e.key === 'PageUp') index = Math.max(index - 8, 0);
    else if (e.key === 'Enter') {
      e.preventDefault();
      return run(items[index]);
    } else return;
    e.preventDefault();
    render();
  });

  const dialog = h('div', { class: 'command-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('コマンドパレット') },
    input,
    list,
    h('div', { class: 'command-palette-foot', 'aria-hidden': 'true' },
      h('span', null, h('kbd', null, '↑↓'), ' ', t('項目を選ぶ')),
      h('span', null, h('kbd', null, 'Enter'), ' ', t('実行')),
      h('span', null, h('kbd', null, 'Esc'), ' ', t('閉じる'))));
  const backdrop = h('div', { class: 'palette-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && layer.close() }, dialog);
  const layer = pushLayer({ element: backdrop, dialog, key: 'commandPalette', onClose: () => (open = false) });
  input.focus();
  render();
}
