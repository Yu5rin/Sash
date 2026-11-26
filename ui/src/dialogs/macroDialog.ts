// 既存のマクロを選ぶダイアログ（仕様書 §23.1）。読み込み済みの VBA から、割り当てられる Sub をモジュールごとに並べる。
// Excel で開いていなくて VBA を読めないときは、Sub の名前を手で入れる欄に切り替える。

import { vba } from '../callbacks';
import { h } from '../dom';
import { t } from '../i18n';
import { listMacros, manualMacro, type MacroEntry } from '../macroAssign';
import { openModal } from './modal';

/** 絞り込み（モジュール名・Sub 名のどちらにも、大文字小文字を区別せず一致）。 */
export function filterMacros(macros: readonly MacroEntry[], query: string): MacroEntry[] {
  const q = query.trim().toLowerCase();
  return q ? macros.filter((m) => m.name.toLowerCase().includes(q) || m.module.toLowerCase().includes(q)) : [...macros];
}

/** マクロを選ぶ。選ばずに閉じたら null。subject は割り当てる先の説明（例：「集計する（ボタン）」）。 */
export function pickMacro(subject: string): Promise<MacroEntry | null> {
  return new Promise((resolve) => {
    const macros = vba.canWrite && vba.modules ? listMacros(vba.modules) : null;
    let chosen: MacroEntry | null = null;
    let done = false;
    const finish = (m: MacroEntry | null) => {
      if (done) return;
      done = true;
      resolve(m);
    };

    const assign = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => { finish(chosen); handle.close(); } }, t('割り当てる'));
    const cancel = h('button', { type: 'button', onclick: () => handle.close() }, t('キャンセル'));
    const setChosen = (m: MacroEntry | null) => {
      chosen = m;
      assign.disabled = m === null;
    };

    const intro = h('p', { class: 'modal-message' },
      t('「{subject}」を押したときに呼ぶマクロを選びます。選ぶと、そのマクロを呼ぶだけの Sub（リボンの引数を受け取る形）を作って割り当てます。', { subject }));
    const body = h('div', { class: 'macro-dialog' }, intro);
    let list: HTMLElement | null = null;
    let input: HTMLInputElement | null = null;

    if (macros) {
      const search = h('input', { type: 'search', class: 'macro-search', placeholder: t('モジュール名・Sub 名で絞り込む'), 'aria-label': t('モジュール名・Sub 名で絞り込む') }) as HTMLInputElement;
      list = h('div', { class: 'macro-list', role: 'listbox', 'aria-label': t('マクロの一覧') });
      const render = () => {
        const shown = filterMacros(macros, search.value);
        if (chosen && !shown.includes(chosen)) setChosen(null);
        if (macros.length === 0) {
          list!.replaceChildren(h('p', { class: 'empty-state' }, t('この VBA に Sub がありません')));
          return;
        }
        if (shown.length === 0) {
          list!.replaceChildren(h('p', { class: 'empty-state' }, t('一致するマクロはありません')));
          return;
        }
        const modules = [...new Set(shown.map((m) => m.module))];
        list!.replaceChildren(...modules.map((module) =>
          h('section', { class: 'macro-module' },
            h('h3', null, module),
            ...shown.filter((m) => m.module === module).map((m) =>
              h('button', {
                type: 'button',
                role: 'option',
                class: `macro-row${chosen === m ? ' selected' : ''}${m.assignable ? '' : ' disabled'}`,
                'aria-selected': String(chosen === m),
                'aria-disabled': String(!m.assignable),
                title: m.reason ?? (m.duplicated ? t('同じ名前の Sub が別のモジュールにもあります。「{call}」と、モジュール名つきで呼びます', { call: m.qualified }) : m.qualified),
                onclick: () => {
                  if (!m.assignable) return;
                  setChosen(m);
                  render();
                },
                ondblclick: () => {
                  if (!m.assignable) return;
                  finish(m);
                  handle.close();
                },
              },
              h('code', null, m.name),
              m.reason ? h('span', { class: 'macro-reason muted' }, m.reason) : m.duplicated ? h('span', { class: 'macro-reason muted' }, t('同じ名前が別のモジュールにもあります')) : null)))));
      };
      search.addEventListener('input', render);
      body.append(search, list);
      input = search;
      render();
    } else {
      const manual = h('input', { type: 'text', class: 'macro-name', placeholder: t('例：集計　または　modMain.集計'), 'aria-label': t('マクロ（Sub）の名前'), spellcheck: false }) as HTMLInputElement;
      const error = h('p', { class: 'field-error', hidden: true });
      manual.addEventListener('input', () => {
        const m = manualMacro(manual.value);
        setChosen(m);
        error.hidden = manual.value.trim() === '' || m !== null;
        error.textContent = t('VBA の Sub の名前として使えません（「モジュール名.Sub 名」の形も書けます）');
      });
      body.append(
        h('p', { class: 'muted' }, vba.statusMessage() || t('Excel で開いていないため、VBA からマクロを選べません。')),
        h('p', { class: 'muted' }, t('呼びたいマクロの名前を入れてください。呼び出し用の Sub のコードは、クリップボードにコピーします。')),
        manual,
        error);
      input = manual;
    }

    const handle = openModal(t('既存のマクロを割り当てる'), body, {
      size: macros ? 'lg' : 'md',
      key: 'macroPicker',
      footer: [assign, cancel],
      initialFocus: input ?? undefined,
      onClose: () => finish(null),
    });
  });
}
