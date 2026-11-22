// レシピの選択と挿入（仕様書 §9.2）。

import { app } from '../app';
import { invoke } from '../bridge';
import { defaultCallbackName, vba } from '../callbacks';
import { allElements, pathOf } from '../model';
import { builtinRecipes, insertInstance, instantiate, recipeFromElement, type Recipe } from '../recipes';
import { generateStub, parseProcedures, procedureCode, RIBBON_HOLDER_MODULE, RIBBON_HOLDER_MODULE_NAME } from '../vba';
import { h } from '../dom';
import { ask, openModal } from './modal';
import { t } from '../i18n';

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
          h('span', { class: 'recipe-title' }, t(r.title)),
          r.custom ? h('span', { class: 'tag' }, t('保存したレシピ')) : null),
      ),
    );
  const renderPreview = () =>
    preview.replaceChildren(
      ...([
      h('p', null, selected.description ? t(selected.description) : t('（説明なし）')),
      h('h3', null, 'XML'),
      h('pre', null, selected.xml),
      selected.vba ? h('h3', null, t('VBA（標準モジュール）')) : null,
      selected.vba ? h('pre', null, selected.vba) : null,
      selected.workbookVba ? h('h3', null, t('VBA（ThisWorkbook）')) : null,
      selected.workbookVba ? h('pre', null, selected.workbookVba) : null,
      selected.needsRibbon ? h('p', { class: 'muted' }, t('IRibbonUI を保持する共通コード（{module}）と onLoad も一緒に入れます。', { module: RIBBON_HOLDER_MODULE_NAME })) : null,
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
    toast(t('レシピ「{title}」を削除しました', { title: t(selected.title) }));
  };

  renderList();
  renderPreview();
  const modal = openModal(t('レシピを挿入'), h('div', { class: 'recipes' }, list, preview), {
    wide: true,
    footer: [
      h('button', { type: 'button', onclick: () => void remove(), class: 'left' }, t('削除')),
      h('button', { type: 'button', onclick: () => modal.close() }, t('キャンセル')),
      h('button', { type: 'button', class: 'primary', onclick: () => void apply() }, t('挿入')),
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
  const renamedNote = inst.renamed.size ? t('（重なる id を {list} に変えました）', { list: [...inst.renamed].map(([a, b]) => `${a}→${b}`).join(t('、')) }) : '';
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
  const all = [recipe.needsRibbon ? `' ===== ${RIBBON_HOLDER_MODULE_NAME}${t('（まだなければ）')}=====\r\n${RIBBON_HOLDER_MODULE}` : '', `' ===== ${app.settings.callbackModule} =====\r\n${code}`, inst.workbookVba ? `' ===== ThisWorkbook =====\r\n${inst.workbookVba}` : ''].filter(Boolean).join('\r\n');
  await navigator.clipboard.writeText(all);
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
