// インスペクタ（仕様書 §5.4）。選んだ要素に使える属性だけを「基本」「表示」「動作」「詳細」に分けて出す。
// 静的な値と get 系コールバックの組は1行の切り替えにまとめ、両方を同時に指定する矛盾を起こさない。

import { app } from '../app';
import { defaultCallbackName, renameCallback, vba } from '../callbacks';
import { h, svg } from '../dom';
import { kindIcon, uiIcons } from '../icons';
import { identifierOf, setAttr, suggestId, usedIds } from '../model';
import type { ImageEntry } from '../store';
import { attributes, attrsOfEl, callbackSignature, defFor, ID_PATTERN, type AttrDef, type Category } from '../schema';
import { lang, t } from '../i18n';

export interface InspectorHooks {
  pickIdMso(current: string, apply: (v: string) => void): void;
  pickImageMso(current: string, apply: (v: string) => void): void;
  editImage(existing?: ImageEntry): void;
  pickFromLibrary(): void;
}

const CATEGORIES: readonly Category[] = ['基本', '表示', '動作', '詳細'];

/** 分類名。「表示」はメニューの［表示］と同じ文言なので、英語はここで決める。 */
function categoryName(cat: string): string {
  return lang === 'en' && cat === '表示' ? 'Appearance' : t(cat);
}

let hooks: InspectorHooks;

export function mountInspector(host: HTMLElement, h0: InspectorHooks): void {
  hooks = h0;
  const render = () => renderInspector(host);
  app.on('session', render);
  app.on('problems', render);
  app.on('vba', render);
  app.on('store', (c) => {
    if (c && (c.kinds.has('selection') || c.kinds.has('doc') || c.kinds.has('images'))) render();
  });
}

/** 属性を変更する。値が同じなら何もしない。 */
function commit(name: string, value: string | null, also: Record<string, string | null> = {}): void {
  const store = app.store;
  const el = store?.selectedElement;
  if (!store || !el) return;
  const changes: Record<string, string | null> = { [name]: value, ...also };
  const same = Object.entries(changes).every(([k, v]) => (el.getAttribute(k) ?? null) === (v === '' ? null : v));
  if (same) return;
  store.edit('inspector', () => {
    const target = store.selectedElement!;
    for (const [k, v] of Object.entries(changes)) setAttr(target, k, v);
    return undefined;
  });
}


function renderInspector(host: HTMLElement): void {
  const store = app.store;
  const el = store?.selectedElement ?? null;
  const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement.dataset['attr'] : undefined;

  if (!store || !el) {
    host.replaceChildren(h('div', { class: 'insp-empty' }, store ? t('キャンバスかツリーで要素を選択してください') : ''));
    return;
  }
  const def = defFor(el);
  const problems = app.problems.filter((p) => p.path.length === store.selection!.length && p.path.every((v, i) => v === store.selection![i]));

  const header = h(
    'div',
    { class: 'insp-header' },
    h('span', { class: 'kind-icon' }, svg(kindIcon(el.localName))),
    h('div', null, h('div', { class: 'insp-title' }, def ? t(def.title) : el.localName), h('div', { class: 'insp-sub' }, `<${el.localName}>${identifierOf(el) ? ` ${identifierOf(el)}` : ''}`)),
  );

  const problemList = problems.length
    ? h(
        'ul',
        { class: 'insp-problems' },
        problems.map((p) => h('li', { class: p.severity }, svg(uiIcons[p.severity]), h('span', null, p.message))),
      )
    : null;

  if (!def || def.opaque) {
    host.replaceChildren(header, h('div', { class: 'insp-empty' }, t('この要素の属性はXMLエディタで編集してください')));
    return;
  }

  const defs = attrsOfEl(el);
  const sections = CATEGORIES.map((cat) => {
    const rows = defs
      .filter((d) => d.category === cat || (cat === '表示' && d.name === 'image'))
      .filter((d) => !d.staticOf && d.name !== 'imageMso' && d.name !== 'getImage' && !(cat !== '表示' && d.name === 'image'))
      .map((d) => (d.name === 'image' ? iconRow(el) : row(el, d)));
    // 静的な値を持たないコールバック（onAction など）は「動作」に出す
    return rows.length ? h('section', { class: 'insp-section' }, h('h3', null, categoryName(cat)), rows) : null;
  });

  host.replaceChildren(header, ...[problemList, ...sections].filter((x): x is HTMLElement => x !== null));

  if (focused) host.querySelector<HTMLElement>(`[data-attr="${focused}"]`)?.focus();
}

function labelCell(d: AttrDef, tag: string): HTMLElement {
  const tips = [t(d.desc)];
  if (d.example) tips.push(`${t('例：')}${d.name}="${t(d.example)}"`);
  if (d.kind === 'callback') tips.push(t('Sub 名前({signature})', { signature: callbackSignature(d.name, tag) }));
  return h('label', { class: 'insp-label', title: tips.join('\n') }, d.name);
}

function textInput(attr: string, value: string, opts: { placeholder?: string; validate?: (v: string) => string | null; type?: string } = {}): HTMLInputElement {
  const input = h('input', {
    type: opts.type ?? 'text',
    value,
    placeholder: opts.placeholder ?? '',
    spellcheck: false,
    dataset: { attr },
  });
  const apply = () => {
    const v = input.value.trim();
    const err = v && opts.validate ? opts.validate(v) : null;
    input.classList.toggle('invalid', err !== null);
    input.title = err ?? '';
    if (err === null) commit(attr, v || null);
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
    if (e.key === 'Escape') input.value = value;
  });
  return input;
}

function valueEditor(el: Element, d: AttrDef): HTMLElement {
  const value = el.getAttribute(d.name) ?? '';
  switch (d.kind) {
    case 'bool': {
      const seg = h('div', { class: 'segmented', role: 'radiogroup', dataset: { attr: d.name }, tabIndex: 0 });
      for (const [v, text] of [['', t('未指定')], ['true', t('オン')], ['false', t('オフ')]] as const) {
        const active = (value === '1' ? 'true' : value === '0' ? 'false' : value) === v;
        seg.append(h('button', { type: 'button', class: active ? 'active' : '', role: 'radio', 'aria-checked': String(active), onclick: () => commit(d.name, v || null) }, text));
      }
      return seg;
    }
    case 'enum': {
      const sel = h('select', { dataset: { attr: d.name }, onchange: (e: Event) => commit(d.name, (e.target as HTMLSelectElement).value || null) }, h('option', { value: '' }, t('未指定')), (d.values ?? []).map((v) => h('option', { value: v, selected: v === value }, v)));
      return sel;
    }
    case 'int':
      return textInput(d.name, value, { type: 'number', validate: (v) => (/^\d+$/.test(v) ? null : t('整数で入力してください')) });
    case 'id':
      return h(
        'div',
        { class: 'insp-inline' },
        textInput(d.name, value, { validate: (v) => (ID_PATTERN.test(v) ? null : t('英字か _ で始め、英数字と _ . - だけを使ってください')) }),
        h('button', {
          type: 'button',
          class: 'small',
          title: t('種類と連番からidを提案する'),
          onclick: () => {
            const used = usedIds(el.ownerDocument);
            used.delete(value);
            commit('id', suggestId(el.localName, el.getAttribute('label'), used), { idMso: null, idQ: null });
          },
        }, t('提案')),
      );
    case 'idMso':
      return h(
        'div',
        { class: 'insp-inline' },
        textInput(d.name, value),
        h('button', { type: 'button', class: 'small', onclick: () => hooks.pickIdMso(value, (v) => commit(d.name, v, d.name === 'idMso' ? { id: null, idQ: null } : {})) }, t('選ぶ')),
      );
    case 'callback':
      return callbackEditor(el, d.name);
    default:
      return textInput(d.name, value);
  }
}

function callbackEditor(el: Element, attr: string): HTMLElement {
  const value = el.getAttribute(attr) ?? '';
  const input = h('input', { type: 'text', value, placeholder: defaultCallbackName(el, attr), spellcheck: false, dataset: { attr } });
  const apply = () => {
    const v = input.value.trim();
    const ok = !v || /^[A-Za-z_][A-Za-z0-9_.!]*$/.test(v);
    input.classList.toggle('invalid', !ok);
    input.title = ok ? '' : t('VBAのSub名として使えない文字があります');
    if (!ok || v === value) return;
    // 名前を変えたときは、VBA 側の Sub 名も変えるかを確認する
    if (value && v) void renameCallback(app.store!.selection!, attr, value, v);
    else commit(attr, v || null);
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
    if (e.key === 'Escape') input.value = value;
  });
  const status = value ? vba.statuses().find((x) => x.name === value) : undefined;
  const stateText = status && vba.status === 'ok' ? t({ implemented: '実装済み', missing: '未実装', mismatch: '引数が不一致', unused: '' }[status.state]) : '';
  return h(
    'div',
    { class: 'insp-callback' },
    h(
      'div',
      { class: 'insp-inline' },
      input,
      value ? null : h('button', { type: 'button', class: 'small', onclick: () => commit(attr, defaultCallbackName(el, attr)) }, lang === 'en' ? 'Add' : '追加'),
    ),
    value ? h('code', { class: 'insp-signature' }, `Sub ${value}(${callbackSignature(attr, el.localName)})`) : null,
    stateText ? h('span', { class: `cb-state ${status!.state}`, title: status!.reason ?? '' }, stateText) : null,
  );
}

/** 静的な値とコールバックを切り替えられる行。 */
function row(el: Element, d: AttrDef): HTMLElement {
  const dyn = d.dynamic ? attributes.get(d.dynamic) : undefined;
  const available = dyn && defFor(el)?.attrs.includes(dyn.name);
  const useDynamic = available && el.hasAttribute(dyn.name);
  const editor = useDynamic ? callbackEditor(el, dyn.name) : valueEditor(el, d);
  const toggle = available
    ? h(
        'button',
        {
          type: 'button',
          class: `mode-switch${useDynamic ? ' on' : ''}`,
          title: useDynamic ? t('固定の値（{name}）に戻す', { name: d.name }) : t('VBAで動的に返す（{name}）に切り替える', { name: dyn.name }),
          onclick: () => (useDynamic ? commit(dyn.name, null) : commit(dyn.name, defaultCallbackName(el, dyn.name), { [d.name]: null })),
        },
        'VBA',
      )
    : null;
  return h('div', { class: 'insp-row' }, labelCell(useDynamic ? dyn : d, el.localName), h('div', { class: 'insp-value' }, editor), toggle);
}

/** アイコンの行。組み込み（imageMso）、埋め込み画像（image）、VBA（getImage）を切り替える。 */
function iconRow(el: Element): HTMLElement {
  const store = app.store!;
  const mode = el.hasAttribute('getImage') ? 'getImage' : el.hasAttribute('image') ? 'image' : el.hasAttribute('imageMso') ? 'imageMso' : '';
  const canDynamic = defFor(el)?.attrs.includes('getImage');
  const sel = h(
    'select',
    {
      dataset: { attr: 'icon-mode' },
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        const clear = { image: null, imageMso: null, getImage: null } as Record<string, string | null>;
        if (v === 'imageMso') commit('imageMso', el.getAttribute('imageMso') ?? 'HappyFace', { ...clear, imageMso: el.getAttribute('imageMso') ?? 'HappyFace' });
        else if (v === 'image') hooks.editImage();
        else if (v === 'getImage') commit('getImage', defaultCallbackName(el, 'getImage'), { ...clear, getImage: defaultCallbackName(el, 'getImage') });
        else commit('image', null, clear);
      },
    },
    h('option', { value: '', selected: mode === '' }, t('なし')),
    h('option', { value: 'imageMso', selected: mode === 'imageMso' }, t('組み込みアイコン')),
    h('option', { value: 'image', selected: mode === 'image' }, t('画像ファイル')),
    canDynamic ? h('option', { value: 'getImage', selected: mode === 'getImage' }, t('VBAで返す')) : null,
  );

  let detail: HTMLElement | null = null;
  if (mode === 'imageMso') {
    const v = el.getAttribute('imageMso') ?? '';
    detail = h('div', { class: 'insp-inline' }, textInput('imageMso', v), h('button', { type: 'button', class: 'small', onclick: () => hooks.pickImageMso(v, (x) => commit('imageMso', x)) }, t('選ぶ')));
  } else if (mode === 'image') {
    const id = el.getAttribute('image') ?? '';
    const img = store.images.get(id);
    detail = h(
      'div',
      { class: 'insp-inline' },
      img ? h('img', { class: 'insp-thumb', src: img.dataUrl, alt: '' }) : null,
      h(
        'select',
        { dataset: { attr: 'image' }, onchange: (e: Event) => commit('image', (e.target as HTMLSelectElement).value || null) },
        [...store.images.keys()].map((k) => h('option', { value: k, selected: k === id }, k)),
        img ? null : h('option', { value: id, selected: true }, id ? t('{id}（見つかりません）', { id }) : t('選択してください')),
      ),
      img?.edit ? h('button', { type: 'button', class: 'small', title: t('元画像と設定から加工し直す'), onclick: () => hooks.editImage(img) }, t('加工し直す')) : null,
      h('button', { type: 'button', class: 'small', onclick: () => hooks.editImage() }, t('新しく作る')),
      h('button', { type: 'button', class: 'small', title: t('アイコンライブラリから選ぶ'), onclick: () => hooks.pickFromLibrary() }, t('ライブラリ')),
    );
  } else if (mode === 'getImage') {
    detail = callbackEditor(el, 'getImage');
  }
  const d = attributes.get('image')!;
  return h('div', { class: 'insp-row wide' }, h('label', { class: 'insp-label', title: t(d.desc) }, t('アイコン')), h('div', { class: 'insp-value' }, sel, detail));
}
