// 別のブックのリボンから、選んだタブ・グループなどを、いま編集中の文書へ取り込む（仕様書 §23.3）。
// DOM の文書だけを相手にする純粋な処理（ホストやダイアログに触れない）。画像は一緒に運び、id が重なるものは振り直す。
// VBA は運ばれないので、取り込んだ部品が使うコールバック名を返し、呼び出し側（ダイアログ）が Sub の雛形を案内する。

import {
  allowedInsertIndex, childElements, createElement, elementAt, ensureContextMenus, ensureContextualTabs, ensureTabs,
  importElement, insertAt, pathOf, renameDuplicateIds, usedIds, type Path,
} from './model';
import { attributes, NAMESPACES, titleOf } from './schema';
import { t } from './i18n';
import { selectMany, type ImageEntry, type PartStore } from './store';

export type ImportKind = 'tab' | 'group' | 'tabSet' | 'contextMenu' | 'backstage';

/** 取り込み元の文書にある、選べる部品 1 つ。groups は、タブの中のグループ。 */
export interface ImportCandidate {
  /** パスを文字にしたもの（選択の印に使う）。 */
  key: string;
  kind: ImportKind;
  /** 取り込み元の文書でのパス。 */
  path: Path;
  /** 表示名（ラベル、なければ id・idMso）。 */
  title: string;
  /** id か idMso（補足）。 */
  detail: string;
  /** タブのときの、中のグループ。 */
  children: ImportCandidate[];
  /** 取り込めない理由（あれば、選べない）。 */
  disabledReason?: string;
}

const keyOf = (path: Path) => path.join('.');

function nameOf(el: Element): { title: string; detail: string } {
  const id = el.getAttribute('id') ?? el.getAttribute('idMso') ?? '';
  const label = el.getAttribute('label');
  return { title: label || id || titleOf(el.localName), detail: label && id ? id : '' };
}

/** 取り込める部品の一覧を作る。target は取り込み先の文書（取り込めるかの判定に使う）。 */
export function listCandidates(source: Document, target: Document): ImportCandidate[] {
  const is2007 = target.documentElement.namespaceURI === NAMESPACES.office2007;
  const hasBackstage = childElements(target.documentElement).some((c) => c.localName === 'backstage');
  const make = (el: Element, kind: ImportKind): ImportCandidate => {
    const path = pathOf(el);
    const c: ImportCandidate = { key: keyOf(path), kind, path, ...nameOf(el), children: [] };
    if (kind === 'backstage' || kind === 'contextMenu') {
      if (is2007) c.disabledReason = t('customUI（2007）の文書には、Backstage と右クリックメニューを置けません');
      else if (kind === 'backstage' && hasBackstage) c.disabledReason = t('取り込み先にはすでに Backstage があります');
    }
    return c;
  };
  const out: ImportCandidate[] = [];
  const root = source.documentElement;
  const find = (parent: Element | undefined, tag: string) => (parent ? childElements(parent).filter((c) => c.localName === tag) : []);
  const ribbon = find(root, 'ribbon')[0];
  for (const tab of find(find(ribbon, 'tabs')[0], 'tab')) {
    const c = make(tab, 'tab');
    c.children = childElements(tab).filter((g) => g.localName === 'group').map((g) => make(g, 'group'));
    out.push(c);
  }
  for (const set of find(find(ribbon, 'contextualTabs')[0], 'tabSet')) out.push(make(set, 'tabSet'));
  for (const menu of find(find(root, 'contextMenus')[0], 'contextMenu')) out.push(make(menu, 'contextMenu'));
  const backstage = find(root, 'backstage')[0];
  if (backstage) out.push(make(backstage, 'backstage'));
  return out;
}

/** 平らにする（タブ → そのグループの順）。 */
export function flatten(candidates: readonly ImportCandidate[]): ImportCandidate[] {
  return candidates.flatMap((c) => [c, ...c.children]);
}

/**
 * 選んだものを、取り込む単位にそろえる。タブを選んでいれば、その中のグループは一緒に入るので外す
 * （二重に取り込まない）。取り込めないものも外す。文書の順に並べる。
 */
export function normalizePicks(all: readonly ImportCandidate[], pickedKeys: ReadonlySet<string>): ImportCandidate[] {
  const tabKeys = new Set(all.filter((c) => c.kind === 'tab' && pickedKeys.has(c.key) && !c.disabledReason).map((c) => c.key));
  const out: ImportCandidate[] = [];
  for (const c of all) {
    if (!pickedKeys.has(c.key) || c.disabledReason) continue;
    if (c.kind === 'tab') out.push(c);
    else if (c.kind === 'group') {
      const parentKey = keyOf(c.path.slice(0, -1));
      if (!tabKeys.has(parentKey)) out.push(c);
    } else out.push(c);
  }
  return out;
}

/** 要素の中（自分を含む）で image 属性が指している画像の id。 */
export function usedImageIds(els: readonly Element[]): string[] {
  const ids = new Set<string>();
  const walk = (el: Element) => {
    const v = el.getAttribute('image');
    if (v) ids.add(v);
    for (const c of childElements(el)) walk(c);
  };
  for (const el of els) walk(el);
  return [...ids];
}

/** 要素の中（自分を含む）のコールバック属性。VBA は運ばれないので、取り込んだあとに要る Sub を知らせるために集める。 */
export function callbackUses(els: readonly Element[]): { name: string; attr: string; id: string }[] {
  const out: { name: string; attr: string; id: string }[] = [];
  const walk = (el: Element) => {
    for (const a of Array.from(el.attributes)) {
      if (attributes.get(a.name)?.kind === 'callback' && a.value) out.push({ name: a.value, attr: a.name, id: el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName });
    }
    for (const c of childElements(el)) walk(c);
  };
  for (const el of els) walk(el);
  return out;
}

export interface ImagePlan {
  /** 取り込み元の画像 id → 取り込み先での id（同じ内容がすでにあれば、そのまま使う）。 */
  map: Map<string, string>;
  /** 取り込み先に足す画像。 */
  add: { id: string; dataUrl: string }[];
  /** 番号を付けて振り直した画像（元 → 新）。 */
  renamed: [string, string][];
  /** 指されているが、取り込み元にない画像の id（.xml だけを読んだときなど）。 */
  missing: string[];
}

/**
 * 運ぶ画像と、取り込み先での id を決める。
 * 取り込み先に同じ id で同じ中身の画像があれば、それを使う。同じ id で違う中身なら、番号を付けて避ける（logo → logo_2）。
 */
export function planImages(ids: readonly string[], sourceImages: ReadonlyMap<string, string>, targetImages: ReadonlyMap<string, string>): ImagePlan {
  const plan: ImagePlan = { map: new Map(), add: [], renamed: [], missing: [] };
  const taken = new Set([...targetImages.keys(), ...sourceImages.keys()]);
  for (const id of ids) {
    const dataUrl = sourceImages.get(id);
    if (dataUrl === undefined) {
      plan.missing.push(id);
      continue;
    }
    const existing = targetImages.get(id);
    if (existing === undefined) {
      plan.map.set(id, id);
      plan.add.push({ id, dataUrl });
    } else if (existing === dataUrl) {
      plan.map.set(id, id);
    } else {
      let n = 2;
      while (taken.has(`${id}_${n}`)) n++;
      const next = `${id}_${n}`;
      taken.add(next);
      plan.map.set(id, next);
      plan.add.push({ id: next, dataUrl });
      plan.renamed.push([id, next]);
    }
  }
  return plan;
}

export interface ImportOptions {
  /** id が重なるものを振り直す（しないと、重なったまま入る。Lint がエラーにする）。 */
  renameIds: boolean;
  /** グループを入れる、取り込み先のタブのパス。'new' なら新しいタブを作って入れる。 */
  groupTarget: Path | 'new';
}

export interface ImportedCallback {
  name: string;
  /** 使っている場所（id.属性）。 */
  uses: string[];
}

export interface ImportOutcome {
  /** 取り込んだ要素の（取り込み後の）パス。 */
  added: Path[];
  renamedIds: [string, string][];
  renamedImages: [string, string][];
  addedImages: string[];
  missingImages: string[];
  callbacks: ImportedCallback[];
  /** 同じ idMso のタブ・右クリックメニューがすでにあり、その中へ足したもの。 */
  mergedInto: string[];
}

/** 取り込んだときに id がどう振り直されるかを、文書を変えずに見積もる（取り込む前の確認用）。 */
export function previewIdRenames(target: Document, source: Document, picks: readonly ImportCandidate[]): [string, string][] {
  const used = usedIds(target);
  const out: [string, string][] = [];
  for (const p of picks) {
    const el = elementAt(source, p.path);
    if (!el) continue;
    out.push(...renameDuplicateIds(importElement(target, el), used));
  }
  return out;
}

/**
 * 選んだ部品を取り込む。画像の追加と XML の編集を 1 つの履歴にまとめる（元に戻す 1 回で、取り込む前に戻る）。
 * 取り込めなかった（構文エラー中など。理由は store が知らせる）ときは null。
 */
export function applyImport(
  store: PartStore,
  source: { doc: Document; images: ReadonlyMap<string, string> },
  picks: readonly ImportCandidate[],
  opts: ImportOptions,
  label = t('別のブックから取り込み'),
): ImportOutcome | null {
  const sourceEls = picks.map((p) => elementAt(source.doc, p.path)).filter((e): e is Element => e !== null);
  if (sourceEls.length === 0) return null;
  const imagePlan = planImages(usedImageIds(sourceEls), source.images, new Map([...store.images.values()].map((i) => [i.id, i.dataUrl])));
  const entries: ImageEntry[] = imagePlan.add.map((i) => ({ id: i.id, dataUrl: i.dataUrl, isNew: true }));
  const outcome: ImportOutcome = {
    added: [],
    renamedIds: [],
    renamedImages: imagePlan.renamed,
    addedImages: imagePlan.add.map((i) => i.id),
    missingImages: imagePlan.missing,
    callbacks: [],
    mergedInto: [],
  };
  const ok = store.addImagesAndEdit(entries, (doc) => {
    const used = usedIds(doc);
    const placed: Element[] = [];
    const roots: Element[] = [];
    let newTab: Element | null = null;
    const append = (parent: Element, child: Element) => insertAt(parent, child, allowedInsertIndex(parent, child.localName, parent.children.length) ?? parent.children.length);
    for (const src of sourceEls) {
      const copy = importElement(doc, src);
      // 画像の参照を、取り込み先での id に付け替える
      const retarget = (el: Element) => {
        const v = el.getAttribute('image');
        if (v && imagePlan.map.has(v)) el.setAttribute('image', imagePlan.map.get(v)!);
        for (const c of childElements(el)) retarget(c);
      };
      retarget(copy);
      if (opts.renameIds) outcome.renamedIds.push(...renameDuplicateIds(copy, used));
      roots.push(copy);
      switch (src.localName) {
        case 'tab': {
          const tabs = ensureTabs(doc);
          const idMso = copy.getAttribute('idMso');
          const existing = idMso ? childElements(tabs).find((x) => x.getAttribute('idMso') === idMso) : undefined;
          if (existing) {
            // 同じ組み込みタブ（TabHome など）は 2 つ置けないので、中のグループを既存のタブへ足す
            for (const g of childElements(copy)) {
              append(existing, g);
              placed.push(g);
            }
            outcome.mergedInto.push(idMso!);
          } else {
            append(tabs, copy);
            placed.push(copy);
          }
          break;
        }
        case 'group': {
          let tab: Element | null = null;
          if (opts.groupTarget !== 'new') {
            const t0 = elementAt(doc, opts.groupTarget);
            tab = t0?.localName === 'tab' ? t0 : null;
          }
          if (!tab) {
            if (!newTab) {
              newTab = createElement(doc, 'tab');
              newTab.setAttribute('label', t('取り込んだグループ'));
              append(ensureTabs(doc), newTab);
            }
            tab = newTab;
          }
          append(tab, copy);
          placed.push(copy);
          break;
        }
        case 'tabSet':
          append(ensureContextualTabs(doc), copy);
          placed.push(copy);
          break;
        case 'contextMenu': {
          const menus = ensureContextMenus(doc);
          const idMso = copy.getAttribute('idMso');
          const existing = idMso ? childElements(menus).find((x) => x.getAttribute('idMso') === idMso) : undefined;
          if (existing) {
            for (const c of childElements(copy)) {
              append(existing, c);
              placed.push(c);
            }
            outcome.mergedInto.push(idMso!);
          } else {
            append(menus, copy);
            placed.push(copy);
          }
          break;
        }
        case 'backstage':
          append(doc.documentElement, copy);
          placed.push(copy);
          break;
        default:
          break;
      }
    }
    const byName = new Map<string, string[]>();
    for (const u of callbackUses(roots)) byName.set(u.name, [...(byName.get(u.name) ?? []), `${u.id}.${u.attr}`]);
    outcome.callbacks = [...byName].map(([name, uses]) => ({ name, uses }));
    outcome.added = placed.map((el) => pathOf(el));
    return selectMany(outcome.added);
  }, label);
  return ok ? outcome : null;
}
