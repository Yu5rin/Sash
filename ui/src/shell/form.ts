// 設定画面などのフォームの部品。見出し・入力・説明の並びをそろえるために共通にする。

import { h } from '../dom';

let nextId = 1;

/** 1 つの設定。左に名前、右に入力と説明を置く。 */
export function settingRow(label: string, control: HTMLElement, hint?: string | HTMLElement | null): HTMLElement {
  const id = `setting-${nextId++}`;
  const hintId = hint ? `${id}-hint` : null;
  // 入力欄に名前と説明を結び付ける（読み上げで何の設定か分かるように）
  const target = control.matches('input, select, textarea') ? control : control.querySelector<HTMLElement>('input, select, textarea');
  if (target) {
    target.id ||= id;
    if (hintId) target.setAttribute('aria-describedby', hintId);
  }
  return h('div', { class: 'setting' },
    h('label', { class: 'setting-label', for: target?.id ?? null }, label),
    h('div', { class: 'setting-control' },
      control,
      hint ? h('p', { class: 'setting-hint', id: hintId }, hint) : null));
}

/** チェックボックスと文言を 1 行にしたもの。 */
export function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void, opts: { disabled?: boolean } = {}): HTMLElement {
  const input = h('input', { type: 'checkbox', checked, disabled: opts.disabled ?? false, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  return h('label', { class: 'setting-check' }, input, label);
}

/** 選択肢。 */
export function select<T extends string>(value: T, options: readonly { value: T; label: string }[], onChange: (value: T) => void): HTMLSelectElement {
  return h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
}
