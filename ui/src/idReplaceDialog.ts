// ID の一括置換のダイアログ。入力に合わせて「古い id → 新しい id」の一覧をその場で見せ、問題がなければ一度の編集で当てる。
// 計画づくりは idReplace.ts（純粋な処理）に任せ、ここは表示と、VBA の Sub 名の書き換えの順番だけを受け持つ。

import { app } from './app';
import { namingRule, renameVbaSubs, vba } from './callbacks';
import { notify, runEdit } from './clipboard';
import { openModal } from './dialogs/modal';
import { debounce, h } from './dom';
import { t } from './i18n';
import { applyIdReplacePlan, planIdReplace, type IdReplaceMode, type IdReplacePlan } from './idReplace';
import { reportRefusal } from './store';
import { parseProcedures } from './vba';
import './styles-w3.css';

/** 一覧に出す行の上限。数千の id があっても開くのが遅くならないよう、先頭だけを出して残りの数を示す。 */
const PREVIEW_LIMIT = 300;

/** ID の一括置換を開く（メニュー・コマンドパレットから呼ぶ）。 */
export function openIdReplaceDialog(initial: { find?: string; replace?: string } = {}): void {
  const store = app.store;
  if (!store) return;
  if (store.syncError) {
    reportRefusal(t('XMLに構文エラーがあるため、この操作はできません。先にXMLエディタでエラーを直してください'));
    return;
  }
  const rule = namingRule();
  let mode: IdReplaceMode = 'prefix';
  let plan: IdReplacePlan | null = null;

  const findInput = h('input', { type: 'text', class: 'idr-find', value: initial.find ?? '', placeholder: t('例：btn'), spellcheck: false, autocomplete: 'off', 'aria-label': t('探す文字列') });
  const replaceInput = h('input', { type: 'text', class: 'idr-replace', value: initial.replace ?? '', placeholder: t('例：cmd'), spellcheck: false, autocomplete: 'off', 'aria-label': t('置き換える文字列') });
  const modeSelect = h('select', { 'aria-label': t('置き換える場所'), onchange: () => { mode = modeSelect.value as IdReplaceMode; update(); } },
    h('option', { value: 'prefix' }, t('先頭だけ')),
    h('option', { value: 'substring' }, t('含まれるところすべて')));
  // 共有の Sub（Ribbon_{attr}）の名前には id が入らないので、コールバック名の置き換えは出さない
  const cbCheck = h('input', { type: 'checkbox', checked: !rule.shared, disabled: rule.shared, onchange: () => update() });
  const vbaCheck = h('input', { type: 'checkbox', checked: vba.canWrite, disabled: !vba.canWrite, onchange: () => update() });
  const summary = h('p', { class: 'idr-summary', 'aria-live': 'polite' });
  const table = h('div', { class: 'idr-preview' });
  const applyButton = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => void run() }, t('置き換える'));

  const procNames = (): Set<string> => new Set(vba.canWrite ? vba.modules!.flatMap(parseProcedures).map((p) => p.name.toLowerCase()) : []);

  const update = () => {
    const doc = app.store?.doc;
    if (!doc) return;
    const find = findInput.value;
    plan = find ? planIdReplace(doc, { find, replace: replaceInput.value, mode, renameCallbacks: cbCheck.checked && !rule.shared, rule }) : null;
    applyButton.disabled = !plan || plan.ids.length === 0 || plan.hasProblems;
    if (!plan) {
      summary.textContent = t('探す文字列を入れると、変わる id をここに示します');
      summary.className = 'idr-summary';
      table.replaceChildren();
      return;
    }
    const bad = plan.ids.filter((r) => r.invalid || r.conflict).length + plan.callbacks.filter((c) => c.conflict).length;
    summary.className = `idr-summary${bad ? ' bad' : ''}`;
    summary.textContent = plan.ids.length === 0
      ? t('当てはまる id はありません')
      : bad
        ? t('id {n} 件のうち、{bad} 件に問題があります。直すまで置き換えられません', { n: plan.ids.length, bad })
        : plan.callbacks.length
          ? t('id {n} 件とコールバック名 {m} 件を置き換えます', { n: plan.ids.length, m: plan.callbacks.length })
          : t('id {n} 件を置き換えます', { n: plan.ids.length });

    const known = vbaCheck.checked ? procNames() : new Set<string>();
    const idRows = plan.ids.slice(0, PREVIEW_LIMIT).map((r) => {
      const note = r.invalid ? t('id として使えません') : r.conflict ? t('ほかの id と重なります') : '';
      return h('tr', { class: note ? 'bad' : '' },
        h('td', { class: 'idr-kind' }, `<${r.tag}>`),
        h('td', null, h('code', null, r.oldId)),
        h('td', { class: 'idr-arrow', 'aria-hidden': 'true' }, '→'),
        h('td', null, h('code', null, r.newId)),
        h('td', { class: 'idr-note' }, note));
    });
    const cbRows = plan.callbacks.slice(0, PREVIEW_LIMIT).map((c) => {
      const inVba = known.has(c.oldName.replace(/^.*[.!]/, '').toLowerCase());
      const note = c.conflict ? t('ほかのコールバック名と重なります') : inVba ? t('VBA の Sub 名も変えます') : '';
      return h('tr', { class: c.conflict ? 'bad' : '' },
        h('td', { class: 'idr-kind' }, t('コールバック名')),
        h('td', null, h('code', null, c.oldName)),
        h('td', { class: 'idr-arrow', 'aria-hidden': 'true' }, '→'),
        h('td', null, h('code', null, c.newName)),
        h('td', { class: 'idr-note' }, note));
    });
    const more = plan.ids.length + plan.callbacks.length - idRows.length - cbRows.length;
    table.replaceChildren(...([
      plan.ids.length
        ? h('table', null,
            h('thead', null, h('tr', null, h('th', null, t('種類')), h('th', null, t('今')), h('th', null, ''), h('th', null, t('置き換え後')), h('th', null, ''))),
            h('tbody', null, idRows, cbRows))
        : h('p', { class: 'muted' }, t('当てはまる id はありません')),
      more > 0 ? h('p', { class: 'muted' }, t('ほか {n} 件', { n: more })) : null,
    ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => x !== null));
  };
  const updateSoon = debounce(update, 100);
  for (const input of [findInput, replaceInput]) {
    // 日本語の変換中は一覧を作り直さない（確定したときに作る）
    input.addEventListener('input', (e) => !(e as InputEvent).isComposing && updateSoon());
    input.addEventListener('compositionend', updateSoon);
  }

  const run = async () => {
    const store = app.store;
    if (!store) return;
    // 入力の直後に押されたときのため、計画をいまの入力と文書で作り直してから当てる
    update();
    const p = plan;
    if (!p || p.ids.length === 0 || p.hasProblems) return;
    if (store.syncError) {
      reportRefusal(t('XMLに構文エラーがあるため、この操作はできません。先にXMLエディタでエラーを直してください'));
      return;
    }
    applyButton.disabled = true;
    const doc = store.doc;
    // VBA を先に書き換え、変えられなかった Sub のコールバック名は XML でも変えない（XML と VBA の名前がずれないように）
    const skip = new Set<string>();
    let vbaNote = '';
    if (vbaCheck.checked && vba.canWrite && p.callbacks.length) {
      const res = await renameVbaSubs(p.callbacks.map((c) => ({ oldName: c.oldName, newName: c.newName })));
      for (const f of res.failed) for (const c of p.callbacks) if (c.oldName.replace(/^.*[.!]/, '') === f.name) skip.add(c.oldName);
      if (res.failed.length) {
        notify({ kind: 'error', message: t('VBAの Sub 名を {n} 件変えられませんでした（そのコールバック名は変えていません）：{list}', { n: res.failed.length, list: res.failed.map((f) => `${f.name}（${f.reason}）`).join(t('、')) }) });
      }
      if (res.renamed.length) vbaNote = t('（VBA の Sub {n} 件も変更）', { n: res.renamed.length });
    }
    // VBA を待っている間に文書が変わっていたら、計画のパスがずれているかもしれないので当てない
    if (app.store !== store || store.doc !== doc) {
      notify({ kind: 'error', message: t('置き換えの途中で文書が変わったため、XML は変えませんでした。もう一度やり直してください') });
      modal.close();
      return;
    }
    const n = p.ids.length;
    const ok = runEdit('other', (d) => applyIdReplacePlan(d, p, skip), t('ID の一括置換（{find} → {replace}、{n} 件）', { find: findInput.value, replace: replaceInput.value, n }));
    if (ok) {
      notify({ kind: 'success', message: t('id を {n} 件置き換えました', { n }) + vbaNote });
      modal.close();
    } else {
      applyButton.disabled = false;
    }
  };

  const body = h('div', { class: 'idr' },
    h('div', { class: 'idr-form' },
      h('label', null, h('span', null, t('探す')), findInput),
      h('label', null, h('span', null, t('置き換え後')), replaceInput),
      h('label', null, h('span', null, t('場所')), modeSelect)),
    h('div', { class: 'idr-options' },
      h('label', { class: 'check' }, cbCheck, h('span', null, t('命名規則（{pattern}）どおりのコールバック名も変える', { pattern: rule.pattern }))),
      h('label', { class: 'check', title: vba.canWrite ? '' : vba.statusMessage() }, vbaCheck, h('span', null, t('VBA の Sub 名も変える（宣言行だけ）')))),
    rule.shared ? h('p', { class: 'muted' }, t('コールバックを共有する設定なので、コールバック名には id が入らず、変える必要はありません')) : null,
    summary,
    table);

  const modal = openModal(t('ID の一括置換'), body, {
    wide: true,
    key: 'id-replace',
    initialFocus: findInput,
    footer: [h('button', { type: 'button', onclick: () => modal.close() }, t('キャンセル')), applyButton],
  });
  update();
}
