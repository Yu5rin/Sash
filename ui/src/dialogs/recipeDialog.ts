// レシピの選択と挿入（仕様書 §9.2）。

import { app } from '../app';
import { invoke } from '../bridge';
import { defaultCallbackName, vba } from '../callbacks';
import { allElements, pathOf } from '../model';
import { builtinRecipes, insertInstance, instantiate, recipeFromElement, type Recipe } from '../recipes';
import { generateStub, parseProcedures, procedureCode, RIBBON_HOLDER_MODULE, RIBBON_HOLDER_MODULE_NAME } from '../vba';
import { h } from '../dom';
import { ask, openModal } from './modal';

type Toast = (msg: string, kind?: 'info' | 'error') => void;

async function loadCustom(): Promise<Recipe[]> {
  try {
    return (await invoke('recipes.list')) as Recipe[];
  } catch {
    return [];
  }
}

export async function openRecipes(toast: Toast): Promise<void> {
  const custom = await loadCustom();
  const all = [...builtinRecipes, ...custom];
  let selected = all[0]!;
  const list = h('div', { class: 'recipe-list', role: 'listbox' });
  const preview = h('div', { class: 'recipe-preview' });

  const renderList = () =>
    list.replaceChildren(
      ...all.map((r) =>
        h('button', { type: 'button', role: 'option', class: `recipe-item${r === selected ? ' active' : ''}`, 'aria-selected': String(r === selected), onclick: () => { selected = r; renderList(); renderPreview(); }, ondblclick: () => void apply() },
          h('span', { class: 'recipe-title' }, r.title),
          r.custom ? h('span', { class: 'tag' }, '保存したレシピ') : null),
      ),
    );
  const renderPreview = () =>
    preview.replaceChildren(
      ...([
      h('p', null, selected.description || '（説明なし）'),
      h('h3', null, 'XML'),
      h('pre', null, selected.xml),
      selected.vba ? h('h3', null, 'VBA（標準モジュール）') : null,
      selected.vba ? h('pre', null, selected.vba) : null,
      selected.workbookVba ? h('h3', null, 'VBA（ThisWorkbook）') : null,
      selected.workbookVba ? h('pre', null, selected.workbookVba) : null,
      selected.needsRibbon ? h('p', { class: 'muted' }, `IRibbonUI を保持する共通コード（${RIBBON_HOLDER_MODULE_NAME}）と onLoad も一緒に入れます。`) : null,
      ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => x !== null),
    );

  const apply = async () => {
    modal.close();
    try {
      toast(await applyRecipe(selected));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!selected.custom) return;
    await invoke('recipes.delete', { id: selected.id });
    modal.close();
    toast(`レシピ「${selected.title}」を削除しました`);
  };

  renderList();
  renderPreview();
  const modal = openModal('レシピを挿入', h('div', { class: 'recipes' }, list, preview), {
    wide: true,
    footer: [
      h('button', { type: 'button', onclick: () => void remove(), class: 'left' }, '削除'),
      h('button', { type: 'button', onclick: () => modal.close() }, 'キャンセル'),
      h('button', { type: 'button', class: 'primary', onclick: () => void apply() }, '挿入'),
    ],
  });
}

/** レシピを挿入し、VBA も入れる（Excel で開いていなければクリップボードにコピー）。 */
export async function applyRecipe(recipe: Recipe): Promise<string> {
  const store = app.store;
  const s = app.session;
  if (!store || !s) return '';
  const vbaNames = new Set((vba.modules ?? []).flatMap(parseProcedures).map((p) => p.name));
  const inst = instantiate(recipe, store.doc, vbaNames);

  let onLoadName: string | null = null;
  store.edit('canvas', (doc) => {
    if (recipe.needsRibbon && !doc.documentElement.getAttribute('onLoad')) {
      onLoadName = defaultCallbackName(doc.documentElement, 'onLoad');
      doc.documentElement.setAttribute('onLoad', onLoadName);
    }
    const target = store.selection ? allElements(doc).find((e) => samePathOf(e, store.selection!)) ?? null : null;
    return insertInstance(doc, inst, store.selection, target);
  });

  let code = inst.vba;
  if (onLoadName) code = generateStub({ name: onLoadName, expected: '', uses: [{ attr: 'onLoad', tag: 'customUI', id: 'customUI', path: [] }] }) + '\r\n' + code;
  const renamedNote = inst.renamed.size ? `（重なる id を ${[...inst.renamed].map(([a, b]) => `${a}→${b}`).join('、')} に変えました）` : '';
  if (!code && !inst.workbookVba) return `レシピ「${recipe.title}」を挿入しました${renamedNote}`;

  if (vba.canWrite) {
    const r = await ask('VBAも挿入しますか？', `レシピのVBAを ${app.settings.callbackModule}${inst.workbookVba ? ' と ThisWorkbook' : ''} の末尾に追加します。既存のコードは書き換えません。`, [
      { value: 'insert', label: '挿入する', primary: true },
      { value: 'copy', label: 'コピーだけ' },
    ]);
    if (r === 'insert') {
      const needsCore = recipe.needsRibbon && !vba.modules!.some((m) => m.name === RIBBON_HOLDER_MODULE_NAME);
      if (needsCore) await invoke('vba.insert', { path: s.path, module: RIBBON_HOLDER_MODULE_NAME, code: RIBBON_HOLDER_MODULE, documentModule: false });
      if (code) await invoke('vba.insert', { path: s.path, module: app.settings.callbackModule, code, documentModule: false });
      if (inst.workbookVba) await invoke('vba.insert', { path: s.path, module: 'ThisWorkbook', code: inst.workbookVba, documentModule: true });
      await vba.refresh();
      return `レシピ「${recipe.title}」をXMLとVBAに挿入しました${renamedNote}。Excelでブックを保存してください`;
    }
  }
  const all = [recipe.needsRibbon ? `' ===== ${RIBBON_HOLDER_MODULE_NAME}（まだなければ）=====\r\n${RIBBON_HOLDER_MODULE}` : '', `' ===== ${app.settings.callbackModule} =====\r\n${code}`, inst.workbookVba ? `' ===== ThisWorkbook =====\r\n${inst.workbookVba}` : ''].filter(Boolean).join('\r\n');
  await navigator.clipboard.writeText(all);
  return `レシピ「${recipe.title}」を挿入し、VBAをクリップボードにコピーしました${renamedNote}`;
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
    toast('レシピにするタブかグループを選択してください', 'error');
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
    const recipe = recipeFromElement(el, title.value.trim() || '名前なし', desc.value.trim(), code);
    await invoke('recipes.save', recipe as unknown as Record<string, unknown>);
    modal.close();
    toast(`レシピ「${recipe.title}」を保存しました`);
  };
  const modal = openModal('レシピとして保存', h('div', { class: 'settings' }, h('label', null, '名前', title), h('label', null, '説明', desc), h('p', { class: 'muted' }, `選択中の <${el.localName}> と、使っているコールバックのVBAを保存します。`)), {
    footer: [h('button', { type: 'button', onclick: () => modal.close() }, 'キャンセル'), h('button', { type: 'button', class: 'primary', onclick: () => void save() }, '保存')],
  });
}
