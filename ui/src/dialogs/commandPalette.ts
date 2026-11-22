// コマンドパレット（仕様書 §9.3）。Ctrl+K で開き、すべての操作を名前で呼べる。

import { fuzzyScore } from '../catalog/catalog';
import { h } from '../dom';

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
  const q = query.trim();
  const scored = commands
    .map((c) => ({ c, s: q ? Math.max(fuzzyScore(q, c.title), fuzzyScore(q, `${c.group} ${c.title}`) * 0.9, fuzzyScore(q, c.keywords ?? '') * 0.8) : 1 }))
    .filter((x) => x.s > 0);
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? 99 : i;
  };
  return scored.sort((a, b) => (q ? b.s - a.s : 0) || rank(a.c.id) - rank(b.c.id)).map((x) => x.c);
}

let open = false;

export function openCommandPalette(commands: () => Command[]): void {
  if (open) return;
  open = true;
  const all = commands().filter((c) => c.enabled?.() ?? true);
  const input = h('input', { type: 'search', placeholder: 'コマンドを検索（例：保存、ボタン、レシピ、テーマ）', spellcheck: false, 'aria-label': 'コマンドを検索' });
  const list = h('ul', { class: 'palette-results', role: 'listbox' });
  let items: Command[] = [];
  let index = 0;

  const close = () => {
    open = false;
    backdrop.remove();
  };
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    remember(c.id);
    c.run();
  };
  const render = () => {
    items = rankCommands(all, input.value, recentIds()).slice(0, 60);
    index = Math.min(index, Math.max(items.length - 1, 0));
    list.replaceChildren(
      ...items.map((c, i) =>
        h('li', { role: 'option', class: i === index ? 'active' : '', 'aria-selected': String(i === index), onmousedown: (e: MouseEvent) => { e.preventDefault(); run(c); } },
          h('span', { class: 'cmd-group' }, c.group),
          h('span', { class: 'cmd-title' }, c.title),
          c.shortcut ? h('kbd', null, c.shortcut) : null),
      ),
    );
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    index = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') index = Math.min(index + 1, items.length - 1);
    else if (e.key === 'ArrowUp') index = Math.max(index - 1, 0);
    else if (e.key === 'Enter') return run(items[index]);
    else if (e.key === 'Escape') return close();
    else return;
    e.preventDefault();
    render();
  });

  const backdrop = h('div', { class: 'palette-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, h('div', { class: 'command-palette', role: 'dialog', 'aria-label': 'コマンドパレット' }, input, list));
  document.body.append(backdrop);
  input.focus();
  render();
}
