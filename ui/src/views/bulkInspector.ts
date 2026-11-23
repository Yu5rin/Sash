// インスペクタの「まとめて変更」（仕様書 §19）。複数の要素を選んでいるときに、すべてに共通の属性だけを出し、
// 変えた値を全部の要素に一度の編集（元に戻す 1 回で戻る）で入れる。
// 値がそろっていればその値を、違えば「（複数の値）」を出す。id は要素ごとに違うべきなので出さない。

import { app } from '../app';
import { applyBulkAttr, bulkLabel, bulkValue, commonAttrDefs, kindSummary, type BulkValue } from '../bulkEdit';
import {
  moveToNewGroupSelected, newGroupDisabledReason, runEdit, setSizeSelected, sizeTargets,
} from '../clipboard';
import { h, svg } from '../dom';
import { kindIcon, uiIcons } from '../icons';
import { elementAt } from '../model';
import { ABORT } from '../store';
import type { AttrDef } from '../schema';
import { t } from '../i18n';
import { attrLabel, BOOL_DEFAULT, SECTIONS, sectionName, sectionOf } from './inspector';

export interface BulkHooks {
  pickImageMso(current: string, apply: (v: string) => void): void;
}

/** 「（複数の値）」の表示。 */
function mixedText(): string {
  return t('（複数の値）');
}

/** 選んでいる要素すべてに、属性の値を入れる（一度の編集）。変わる要素がなければ何もしない。 */
function applyAll(d: AttrDef, value: string | null): boolean {
  const store = app.store;
  if (!store) return false;
  const paths = [...store.selections];
  return runEdit('inspector', (doc) => {
    const els = paths.map((p) => elementAt(doc, p)).filter((e): e is Element => e !== null);
    return applyBulkAttr(els, d, value) === 0 ? ABORT : undefined;
  }, bulkLabel(paths.length, d.name, value));
}

let seq = 0;

/** 1行の入力欄。値が違うときは空欄にして「（複数の値）」を薄く出す。Enter か欄を離れたときに確定し、Esc で戻す。 */
function textEditor(d: AttrDef, v: BulkValue): HTMLElement {
  const value = v.mixed ? '' : v.value;
  const input = h('input', {
    type: 'text',
    id: `insp-bulk-${++seq}`,
    value,
    class: v.mixed ? 'insp-mixed' : '',
    placeholder: v.mixed ? mixedText() : '',
    spellcheck: false,
    autocomplete: 'off',
    inputmode: d.kind === 'int' ? 'numeric' : undefined,
    dataset: { attr: d.name, fkey: `bulk:${d.name}:text`, orig: value },
  });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const apply = () => {
    const next = input.value.trim();
    if (next === (input.dataset['orig'] ?? '')) return;
    // 値が違う欄を空のまま離れたときは、何も変えない（「消す」は横のボタンで行う。うっかり全部を消さないように）
    if (v.mixed && next === '') return;
    if (d.kind === 'int' && next && !/^\d+$/.test(next)) {
      error.hidden = false;
      error.textContent = t('0 以上の整数で入力してください');
      return;
    }
    error.hidden = true;
    input.dataset['orig'] = next;
    if (!applyAll(d, next || null)) {
      input.dataset['orig'] = value;
      input.value = value;
    }
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => {
    // 日本語入力の変換中の Enter・Esc は変換のためのもの
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      input.value = input.dataset['orig'] ?? '';
    }
  });
  const anySet = v.mixed ? v.values.some((x) => x !== '') : v.value !== '';
  const clear = anySet
    ? h('button', { type: 'button', class: 'small', title: t('選んでいる要素すべてから {attr} を消します', { attr: d.name }), onclick: () => applyAll(d, null) }, t('消す'))
    : null;
  return h('div', { class: 'insp-inline' }, h('div', { class: 'insp-field' }, input, error), clear);
}

/** 既定 / はい / いいえ。値が違うときは、どれも押されていない状態にする。 */
function boolEditor(d: AttrDef, v: BulkValue): HTMLElement {
  const def = BOOL_DEFAULT[d.name];
  const defaultText = def === undefined ? t('既定') : t('既定（{value}）', { value: def ? t('はい') : t('いいえ') });
  const seg = h('div', { class: 'segmented insp-bool', role: 'radiogroup', 'aria-label': attrLabel(d.name), dataset: { attr: d.name } });
  const options = [['', defaultText], ['true', t('はい')], ['false', t('いいえ')]] as const;
  for (const [value, text] of options) {
    const active = !v.mixed && v.value === value;
    seg.append(h('button', {
      type: 'button',
      class: active ? 'active' : '',
      role: 'radio',
      'aria-checked': String(active),
      // 値が違うときは、最初のボタンに Tab で入れるようにする
      tabIndex: active || (v.mixed && value === '') ? 0 : -1,
      dataset: { fkey: `bulk:${d.name}:bool:${value}` },
      onclick: () => applyAll(d, value || null),
    }, text));
  }
  return v.mixed ? h('div', { class: 'insp-inline' }, seg, h('span', { class: 'insp-mixed-tag' }, mixedText())) : seg;
}

/** 列挙値。値が違うときは「（複数の値）」を選んだ状態で出す（選び直すと全部に入る）。 */
function enumEditor(d: AttrDef, v: BulkValue): HTMLElement {
  const value = v.mixed ? null : v.value;
  return h(
    'select',
    {
      dataset: { attr: d.name, fkey: `bulk:${d.name}:enum` },
      onchange: (e: Event) => {
        const next = (e.target as HTMLSelectElement).value;
        if (next === '\u0000') return;
        applyAll(d, next || null);
      },
    },
    v.mixed ? h('option', { value: '\u0000', selected: true, disabled: true }, mixedText()) : null,
    h('option', { value: '', selected: value === '' }, t('未指定')),
    (d.values ?? []).map((x) => h('option', { value: x, selected: x === value }, x)),
    value && !(d.values ?? []).includes(value) ? h('option', { value, selected: true }, value) : null,
  );
}

function editorFor(d: AttrDef, v: BulkValue, hooks: BulkHooks): HTMLElement {
  if (d.kind === 'bool') return boolEditor(d, v);
  if (d.kind === 'enum') return enumEditor(d, v);
  if (d.kind === 'imageMso') {
    return h(
      'div',
      { class: 'insp-inline' },
      textEditor(d, v),
      h('button', { type: 'button', class: 'small', onclick: () => hooks.pickImageMso(v.mixed ? '' : v.value, (x) => applyAll(d, x)) }, t('選ぶ')),
    );
  }
  return textEditor(d, v);
}

/** 幅を詰めるときによく使う操作（大きさの一括変更・新しいグループに移す）。 */
function quickActions(): HTMLElement {
  const sized = sizeTargets().length;
  const groupReason = newGroupDisabledReason();
  const buttons: HTMLElement[] = [];
  if (sized > 0) {
    buttons.push(
      h('button', { type: 'button', class: 'small', title: t('size を large にします（{n} 個）', { n: sized }), onclick: () => setSizeSelected('large', 'inspector') }, t('大きく')),
      h('button', { type: 'button', class: 'small', title: t('size を normal にします（{n} 個）', { n: sized }), onclick: () => setSizeSelected('normal', 'inspector') }, t('小さく')),
    );
  }
  buttons.push(h('button', { type: 'button', class: 'small', disabled: groupReason !== null, title: groupReason ?? t('選んだコントロールを、すぐ後ろに作る新しいグループへ移します'), onclick: () => moveToNewGroupSelected('inspector') }, t('新しいグループに移す')));
  return h('div', { class: 'insp-bulk-actions', role: 'group', 'aria-label': t('まとめての操作') }, buttons);
}

/** 複数選択のときのインスペクタの中身。 */
export function renderBulkInspector(els: readonly Element[], hooks: BulkHooks): HTMLElement[] {
  const n = els.length;
  const tags = new Set(els.map((e) => e.localName));
  const header = h(
    'div',
    { class: 'insp-header' },
    h('span', { class: 'kind-icon' }, svg(kindIcon(tags.size === 1 ? els[0]!.localName : 'group'))),
    h('div', { class: 'insp-heading' },
      h('div', { class: 'insp-title' }, t('{n} 個の要素（{kinds}）', { n, kinds: kindSummary(els) })),
      h('div', { class: 'insp-sub' }, t('変えた値は選んでいる要素すべてに入ります（元に戻すで一度に戻せます）'))),
  );
  const defs = commonAttrDefs(els);
  if (defs.length === 0) {
    return [header, quickActions(), h('div', { class: 'insp-empty' }, t('選んでいる要素に共通の属性はありません。1つずつ選んで編集してください'))];
  }
  const sections = SECTIONS.map((sec) => {
    const rows = defs.filter((d) => sectionOf(d) === sec).map((d) => {
      const v = bulkValue(els, d);
      const editor = editorFor(d, v, hooks);
      const fieldId = editor.querySelector('input')?.id ?? editor.id ?? '';
      return h('div', { class: 'insp-row' },
        h('label', { class: 'insp-label', title: t(d.desc), for: fieldId }, h('span', { class: 'insp-label-ja' }, attrLabel(d.name)), h('span', { class: 'insp-label-raw' }, d.name)),
        h('div', { class: 'insp-value' }, editor));
    });
    if (rows.length === 0) return null;
    return h('section', { class: 'insp-section', dataset: { section: sec } },
      h('div', { class: 'insp-section-head', role: 'heading', 'aria-level': '3' }, svg(uiIcons.chevron), h('span', null, sectionName(sec)), h('span', { class: 'insp-count' }, String(rows.length))),
      h('div', { class: 'insp-rows' }, rows));
  }).filter((x): x is HTMLElement => x !== null);
  return [header, quickActions(), ...sections, h('div', { class: 'insp-multi-note' }, t('id・idMso・画像（image）は要素ごとに違うため、ここでは変えられません'))];
}
