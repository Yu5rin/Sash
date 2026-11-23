// レシピの選択と挿入（仕様書 §9.2）。

import { app } from '../app';
import { invoke } from '../bridge';
import { defaultCallbackName, vba } from '../callbacks';
import { allElements, pathOf, serialize } from '../model';
import { builtinRecipes, insertInstance, instantiate, recipeFromElement, type Recipe } from '../recipes';
import { generateStub, parseProcedures, procedureCode, RIBBON_HOLDER_MODULE, RIBBON_HOLDER_MODULE_NAME } from '../vba';
import { copyText } from '../clipboard';
import type { ToastKind } from '../shell/toast';
import { h } from '../dom';
import { ask, openModal, type ModalHandle } from './modal';
import type { Instance } from '../recipes';
import { t } from '../i18n';

type Toast = (msg: string, kind?: ToastKind) => void;

async function loadCustom(): Promise<Recipe[]> {
  try {
    return (await invoke('recipes.list')) as Recipe[];
  } catch {
    return [];
  }
}

/** 既存の ThisWorkbook のイベント処理と重なったもの・名前を振り直したものを、コピーボタン付きで示す。 */
function conflictNotes(inst: Instance): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (inst.workbookVbaConflicts.length) {
    out.push(h('h3', null, t('既存のイベントに次の行を追加してください')));
    out.push(h('p', { class: 'muted' }, t('ThisWorkbook にすでに同じ名前のイベント処理があるため、自動では足しません。その Sub の中に次の行を足してください。')));
    for (const name of inst.workbookVbaConflicts) {
      const code = inst.workbookVbaConflictCode[name] ?? '';
      out.push(
        h('div', { class: 'recipe-conflict' },
          h('div', { class: 'recipe-conflict-head' }, h('code', null, name), h('button', { type: 'button', class: 'small', onclick: () => copyText(code, t('{name} に足す行をコピーしました', { name })) }, t('コピー'))),
          h('pre', null, code)),
      );
    }
  }
  const renamed = [...inst.renamed, ...inst.renamedProcedures];
  if (renamed.length) {
    out.push(h('p', { class: 'muted' }, t('重なる名前を振り直します：{list}', { list: renamed.map(([a, b]) => `${a} → ${b}`).join(t('、')) })));
  }
  return out;
}

/** 整形した XML（プレビュー用）。 */
function previewXml(el: Element): string {
  const tmp = document.implementation.createDocument(el.namespaceURI, null, null);
  tmp.appendChild(tmp.importNode(el, true));
  return serialize(tmp).replace(/^(<[^\s>/]+)\s+xmlns(:\w+)?="[^"]*"/, '$1').trimEnd();
}

/** 読み込めている VBA の Sub・Function の名前（重なる名前の振り直しと、イベント処理の重なりの判定に使う）。 */
function existingVbaNames(): Set<string> {
  return new Set((vba.modules ?? []).flatMap(parseProcedures).map((p) => p.name));
}

let recipesOpen = false;

export async function openRecipes(toast: Toast): Promise<void> {
  // 読み込みの間にもう一度押されても、二重に開かない
  if (recipesOpen) return;
  recipesOpen = true;
  let custom: Recipe[];
  try {
    custom = await loadCustom();
  } finally {
    recipesOpen = false;
  }
  const all = [...builtinRecipes, ...custom];
  let selected = all[0]!;
  const list = h('div', { class: 'recipe-list', role: 'listbox' });
  const preview = h('div', { class: 'recipe-preview' });

  const renderList = () =>
    list.replaceChildren(
      ...all.map((r) =>
        h('button', { type: 'button', role: 'option', class: `recipe-item${r === selected ? ' active' : ''}`, 'aria-selected': String(r === selected), onclick: () => { selected = r; renderList(); renderPreview(); }, ondblclick: () => void apply() },
          h('span', { class: 'recipe-title' }, t(r.title)),
          r.custom ? h('span', { class: 'tag' }, t('保存したレシピ')) : null),
      ),
    );
  // プレビューは、今の文書に入れたときの姿（id の振り直しや、既存の VBA との重なりを反映したもの）を出す
  const renderPreview = () => {
    let inst: Instance | null = null;
    let error = '';
    try {
      const store = app.store;
      if (store) inst = instantiate(selected, store.doc, existingVbaNames());
    } catch (e) {
      error = (e as Error).message;
    }
    const xml = inst ? previewXml(inst.element) : selected.xml;
    const code = inst ? inst.vba : selected.vba;
    const wb = inst ? inst.workbookVba : selected.workbookVba ?? '';
    preview.replaceChildren(
      ...([
        h('p', null, selected.description ? t(selected.description) : t('（説明なし）')),
        error ? h('p', { class: 'field-error' }, error) : null,
        h('h3', null, t('挿入される XML')),
        h('pre', null, xml),
        code ? h('h3', null, t('VBA（標準モジュール）')) : null,
        code ? h('pre', null, code) : null,
        wb ? h('h3', null, t('VBA（ThisWorkbook）')) : null,
        wb ? h('pre', null, wb) : null,
        ...(inst ? conflictNotes(inst) : []),
        selected.needsRibbon ? h('p', { class: 'muted' }, t('IRibbonUI を保持する共通コード（{module}）と onLoad も一緒に入れます。', { module: RIBBON_HOLDER_MODULE_NAME })) : null,
      ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => x !== null),
    );
  };
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = all.indexOf(selected) + (e.key === 'ArrowDown' ? 1 : -1);
    const next = all[Math.max(0, Math.min(i, all.length - 1))]!;
    if (next === selected) return;
    selected = next;
    renderList();
    renderPreview();
    list.querySelector<HTMLElement>('.recipe-item.active')?.focus();
  });

  const apply = async () => {
    modal.close();
    try {
      const message = await applyRecipe(selected);
      if (message) toast(message);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!selected.custom) return;
    try {
      await invoke('recipes.delete', { id: selected.id });
    } catch (e) {
      toast((e as Error).message, 'error');
      return;
    }
    modal.close();
    toast(t('レシピ「{title}」を削除しました', { title: t(selected.title) }));
  };

  renderList();
  renderPreview();
  const modal = openModal(t('レシピを挿入'), h('div', { class: 'recipes' }, list, preview), {
    wide: true,
    key: 'recipes',
    footer: [
      h('button', { type: 'button', onclick: () => void remove(), class: 'left', disabled: !all.some((r) => r.custom) }, t('削除')),
      h('button', { type: 'button', onclick: () => modal.close() }, t('キャンセル')),
      h('button', { type: 'button', class: 'primary', onclick: () => void apply() }, t('挿入')),
    ],
  });
}

/** レシピを挿入し、VBA も入れる（Excel で開いていなければクリップボードにコピー）。知らせる文言を返す（空ならもう知らせてある）。 */
export async function applyRecipe(recipe: Recipe): Promise<string> {
  const store = app.store;
  const s = app.session;
  if (!store || !s) return '';
  const inst = instantiate(recipe, store.doc, existingVbaNames());

  let onLoadName: string | null = null;
  const inserted = store.edit('canvas', (doc) => {
    if (recipe.needsRibbon && !doc.documentElement.getAttribute('onLoad')) {
      onLoadName = defaultCallbackName(doc.documentElement, 'onLoad');
      doc.documentElement.setAttribute('onLoad', onLoadName);
    }
    const target = store.selection ? allElements(doc).find((e) => samePathOf(e, store.selection!)) ?? null : null;
    return insertInstance(doc, inst, store.selection, target);
  }, t('レシピ「{title}」を挿入', { title: t(recipe.title) }));
  // XML に入れられなかったときは、VBA だけが入って食い違わないよう、ここでやめる。
  // 構文エラー中で断られたときは、store がすでに理由を知らせているので、重ねて知らせない（空の文言を返す）
  if (!inserted && store.syncError) return '';
  if (!inserted) throw new Error(t('レシピ「{title}」を挿入できませんでした', { title: t(recipe.title) }));
  if (inst.workbookVbaConflicts.length) showConflicts(inst);

  let code = inst.vba;
  if (onLoadName) code = generateStub({ name: onLoadName, expected: '', uses: [{ attr: 'onLoad', tag: 'customUI', id: 'customUI', path: [] }] }) + '\r\n' + code;
  const renamedAll = [...inst.renamed, ...inst.renamedProcedures];
  const renamedNote = renamedAll.length ? t('（重なる名前を {list} に変えました）', { list: renamedAll.map(([a, b]) => `${a}→${b}`).join(t('、')) }) : '';
  if (!code && !inst.workbookVba) return t('レシピ「{title}」を挿入しました{note}', { title: t(recipe.title), note: renamedNote });

  if (vba.canWrite) {
    const r = await ask(t('VBAも挿入しますか？'), t(inst.workbookVba ? 'レシピのVBAを {module} と ThisWorkbook の末尾に追加します。既存のコードは書き換えません。' : 'レシピのVBAを {module} の末尾に追加します。既存のコードは書き換えません。', { module: app.settings.callbackModule }), [
      { value: 'insert', label: t('挿入する'), primary: true },
      { value: 'copy', label: t('コピーだけ') },
    ]);
    if (r === 'insert') {
      const needsCore = recipe.needsRibbon && !vba.modules!.some((m) => m.name === RIBBON_HOLDER_MODULE_NAME);
      if (needsCore) await invoke('vba.insert', { path: s.path, module: RIBBON_HOLDER_MODULE_NAME, code: RIBBON_HOLDER_MODULE, documentModule: false });
      if (code) await invoke('vba.insert', { path: s.path, module: app.settings.callbackModule, code, documentModule: false });
      if (inst.workbookVba) await invoke('vba.insert', { path: s.path, module: 'ThisWorkbook', code: inst.workbookVba, documentModule: true });
      await vba.refresh();
      return t('レシピ「{title}」をXMLとVBAに挿入しました{note}。Excelでブックを保存してください', { title: t(recipe.title), note: renamedNote });
    }
  }
  // モジュールごとに分けて持つ（コピー失敗時の画面で、貼り付け先ごとに［コピー］を出すため）
  const modules: VbaSection[] = [
    ...(recipe.needsRibbon ? [{ name: RIBBON_HOLDER_MODULE_NAME + t('（まだなければ）'), code: RIBBON_HOLDER_MODULE }] : []),
    { name: app.settings.callbackModule, code },
    ...(inst.workbookVba ? [{ name: 'ThisWorkbook', code: inst.workbookVba }] : []),
  ];
  const all = joinSections(modules);
  try {
    await navigator.clipboard.writeText(all);
  } catch {
    // コピーできなくても XML は入っているので、VBA は画面で見せる
    showCode(modules);
    return t('レシピ「{title}」を挿入しました。VBA はコピーできなかったので、表示した内容を貼り付けてください', { title: t(recipe.title) });
  }
  return t('レシピ「{title}」を挿入し、VBAをクリップボードにコピーしました{note}', { title: t(recipe.title), note: renamedNote });
}

function samePathOf(el: Element, path: readonly number[]): boolean {
  const p = pathOf(el);
  return p.length === path.length && p.every((v, i) => v === path[i]);
}

/** 選択中のタブかグループを、レシピとして保存する。 */
export async function saveAsRecipe(toast: Toast): Promise<void> {
  const store = app.store;
  const el = store?.selectedElement;
  if (!store || !el || (el.localName !== 'tab' && el.localName !== 'group')) {
    toast(t('レシピにするタブかグループを選択してください'), 'error');
    return;
  }
  const title = h('input', { type: 'text', value: el.getAttribute('label') ?? el.getAttribute('id') ?? '', spellcheck: false });
  const desc = h('input', { type: 'text', value: '', spellcheck: false });
  const save = async () => {
    // コールバックの VBA は、読めていれば実装をそのまま、なければ雛形を入れる
    const names = new Set(allElements(store.doc).filter((x) => x === el || el.contains(x)).flatMap((x) => Array.from(x.attributes).map((a) => a.value)));
    const statuses = vba.statuses().filter((x) => names.has(x.name));
    const code = statuses
      .map((x) => {
        const mod = x.procedure ? vba.modules?.find((m) => m.name === x.procedure!.module) : undefined;
        return mod && x.procedure ? procedureCode(mod, x.procedure) : generateStub(x);
      })
      .join('\r\n');
    const recipe = recipeFromElement(el, title.value.trim() || t('名前なし'), desc.value.trim(), code);
    await invoke('recipes.save', recipe as unknown as Record<string, unknown>);
    modal.close();
    toast(t('レシピ「{title}」を保存しました', { title: recipe.title }));
  };
  const modal = openModal(t('レシピとして保存'), h('div', { class: 'settings' }, h('label', null, t('名前'), title), h('label', null, t('説明'), desc), h('p', { class: 'muted' }, t('選択中の <{tag}> と、使っているコールバックのVBAを保存します。', { tag: el.localName }))), {
    footer: [h('button', { type: 'button', onclick: () => modal.close() }, t('キャンセル')), h('button', { type: 'button', class: 'primary', onclick: () => void save() }, t('保存'))],
  });
}

/** ThisWorkbook の既存のイベント処理に足してほしい行を、挿入のあとに示す。 */
function showConflicts(inst: Instance): void {
  const m = openModal(t('既存のイベントに次の行を追加してください'), h('div', { class: 'recipe-preview' }, ...conflictNotes(inst)), {
    footer: [h('button', { type: 'button', class: 'primary', onclick: () => m.close() }, t('閉じる'))],
  });
}

export interface VbaSection {
  name: string;
  code: string;
}

/** クリップボードに一括で書く形（モジュールの見出しコメントで区切る）。 */
export function joinSections(sections: readonly VbaSection[]): string {
  return sections.filter((x) => x.code || x.name).map((x) => `' ===== ${x.name} =====\r\n${x.code}`).join('\r\n');
}

/**
 * コピーに失敗したときに VBA を見せる画面。貼り付け先のモジュールごとに見出しと［コピー］を置き、
 * 一括の［すべてコピー］を主にする（クリップボードが使えないとき、利用者が選択して手でコピーする手間を減らすため）。
 */
export function showCode(sections: readonly VbaSection[]): ModalHandle {
  const copyAll = h('button', { type: 'button', class: 'primary', onclick: () => copyText(joinSections(sections), t('VBA をすべてコピーしました')) }, t('すべてコピー'));
  const body = h('div', { class: 'recipe-preview vba-sections' },
    ...sections.flatMap((x) => [
      h('div', { class: 'vba-section-head' },
        h('h3', null, x.name),
        h('button', { type: 'button', class: 'small', onclick: () => copyText(x.code, t('{name} をコピーしました', { name: x.name })) }, t('コピー'))),
      h('pre', null, x.code),
    ]));
  const m = openModal(t('VBA に貼り付けるコード'), body, {
    wide: true,
    footer: [copyAll, h('button', { type: 'button', onclick: () => m.close() }, t('閉じる'))],
    initialFocus: copyAll,
  });
  return m;
}
