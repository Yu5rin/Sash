// 別のブックのリボンから、選んだタブ・グループなどを、いま編集中の文書へ取り込む（仕様書 §23.3）。
// DOM の文書だけを相手にする純粋な処理（ホストやダイアログに触れない）。画像は一緒に運び、id が重なるものは振り直す。
// VBA は運ばれないので、取り込んだ部品が使うコールバック名を返し、呼び出し側（ダイアログ）が Sub の雛形を案内する。

import {
  allElements, allowedInsertIndex, childElements, createElement, elementAt, ensureContextMenus, ensureContextualTabs, ensureTabs,
  importElement, insertAt, pathOf, renameDuplicateIds, usedIds, type Path,
} from './model';
import { attributes, NAMESPACES, titleOf } from './schema';
import { t } from './i18n';
import { bareCallbackName, callbackName, type NamingRule } from './vba';
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
  /** コールバック名の命名規則。id を振り直したとき、規則で付けた名前も付け直す（なければ付け直さない）。 */
  naming?: NamingRule;
  /** 取り込み先の VBA にある Sub の名前（付け直した名前が重ならないように避ける）。 */
  takenCallbacks?: ReadonlySet<string>;
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
  /** id を振り直したので、命名規則で付け直したコールバック名（元 → 新）。 */
  renamedCallbacks: [string, string][];
  /** 付け直せず（規則外の名前）、取り込み先のほかのコントロールと同じ Sub を共有してしまうコールバック名。 */
  sharedCallbacks: string[];
  /** 取り込み先と重なったので外した keytip（要素の表示名と keytip）。 */
  droppedKeytips: { id: string; keytip: string }[];
  /** 同じ組み込みのタブ・右クリックメニューへ合流させたので、取り込み元のものを捨てた属性。 */
  mergeDroppedAttrs: { idMso: string; attrs: string[] }[];
  /** 取り込み先のルートへ宣言を足した名前空間の接頭辞（idQ などが使う）。 */
  addedPrefixes: string[];
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
    renamedCallbacks: [],
    sharedCallbacks: [],
    droppedKeytips: [],
    mergeDroppedAttrs: [],
    addedPrefixes: [],
  };
  const ok = store.addImagesAndEdit(entries, (doc) => {
    const used = usedIds(doc);
    const taken = new Set([...(opts.takenCallbacks ?? [])].map((n) => n.toLowerCase()));
    // 取り込む前の、取り込み先のコールバック名と keytip（重なりを調べるため）
    const existingCallbacks = new Set<string>();
    for (const el of allElements(doc)) {
      for (const a of Array.from(el.attributes)) {
        if (attributes.get(a.name)?.kind === 'callback' && a.value) {
          existingCallbacks.add(bareCallbackName(a.value).toLowerCase());
          taken.add(bareCallbackName(a.value).toLowerCase());
        }
      }
    }
    const prefixes = new Map<string, string>();
    const resolvePrefix = (p: string): string => {
      const cached = prefixes.get(p);
      if (cached !== undefined) return cached;
      const uri = source.doc.documentElement.getAttribute(`xmlns:${p}`);
      if (!uri) return p;
      const root = doc.documentElement;
      let name = p;
      for (let n = 2; ; n++) {
        const have = root.getAttribute(`xmlns:${name}`);
        if (have === uri) break;
        if (have === null) {
          root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${name}`, uri);
          outcome.addedPrefixes.push(name);
          break;
        }
        name = `${p}${n}`;
      }
      prefixes.set(p, name);
      return name;
    };
    const placed: Element[] = [];
    /** 合流させたとき、取り込み元の要素自身の属性（label・getVisible など）は使われない。何を捨てたかを控える。 */
    const noteDropped = (copy: Element, idMso: string) => {
      const attrs = Array.from(copy.attributes).map((a) => a.name).filter((n) => n !== 'idMso' && n !== 'keytip' && !n.startsWith('xmlns'));
      if (attrs.length) outcome.mergeDroppedAttrs.push({ idMso, attrs });
    };
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
      // idQ・insertAfterQ などの「接頭辞:名前」は、取り込み先のルートに接頭辞の宣言がないと読めなくなる。宣言を足す（違う URI で使われていれば付け替える）
      const fixPrefixes = (el: Element) => {
        for (const q of ['idQ', 'insertAfterQ', 'insertBeforeQ']) {
          const v = el.getAttribute(q);
          const i = v ? v.indexOf(':') : -1;
          if (v && i > 0) {
            const np = resolvePrefix(v.slice(0, i));
            if (np !== v.slice(0, i)) el.setAttribute(q, `${np}${v.slice(i)}`);
          }
        }
        for (const c of childElements(el)) fixPrefixes(c);
      };
      fixPrefixes(copy);
      // id を振り直す前に、id から規則で付けたコールバック名を持つ要素を控える
      const before: { el: Element; oldId: string }[] = [];
      const note = (el: Element) => {
        const id = el.getAttribute('id');
        if (id) before.push({ el, oldId: id });
        for (const c of childElements(el)) note(c);
      };
      note(copy);
      if (opts.renameIds) {
        outcome.renamedIds.push(...renameDuplicateIds(copy, used));
        const rule = opts.naming;
        for (const { el, oldId } of before) {
          const newId = el.getAttribute('id')!;
          if (!rule || rule.shared || newId === oldId) continue;
          for (const a of Array.from(el.attributes)) {
            if (attributes.get(a.name)?.kind !== 'callback' || !a.value) continue;
            const old = a.value;
            const bare = bareCallbackName(old);
            if (bare.toLowerCase() !== callbackName(rule, oldId, a.name, el.localName).toLowerCase()) continue;
            const next = callbackName(rule, newId, a.name, el.localName, taken);
            taken.add(next.toLowerCase());
            const value = `${old.slice(0, old.length - bare.length)}${next}`;
            el.setAttribute(a.name, value);
            outcome.renamedCallbacks.push([old, value]);
          }
        }
      }
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
            noteDropped(copy, idMso!);
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
            noteDropped(copy, idMso!);
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
    // keytip は、同じ画面（タブどうし・同じタブの中のコントロールどうし）で重なると、Excel でどちらか一方しか効かない。重なるものは外す
    const idOf = (el: Element) => el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName;
    const dedupeIn = (el: Element, used: Set<string>) => {
      const k = el.getAttribute('keytip');
      if (k) {
        if (used.has(k.toUpperCase())) {
          outcome.droppedKeytips.push({ id: idOf(el), keytip: k });
          el.removeAttribute('keytip');
        } else used.add(k.toUpperCase());
      }
      for (const c of childElements(el)) dedupeIn(c, used);
    };
    const keytipsIn = (scope: Element, exclude: Element, into: Set<string>) => {
      for (const c of childElements(scope)) {
        if (c === exclude) continue;
        const k = c.getAttribute('keytip');
        if (k) into.add(k.toUpperCase());
        keytipsIn(c, exclude, into);
      }
    };
    for (const p of placed) {
      if (p.localName === 'tab') {
        const siblings = new Set<string>();
        for (const x of childElements(p.parentElement!)) if (x !== p && x.getAttribute('keytip')) siblings.add(x.getAttribute('keytip')!.toUpperCase());
        const k = p.getAttribute('keytip');
        if (k && siblings.has(k.toUpperCase())) {
          outcome.droppedKeytips.push({ id: idOf(p), keytip: k });
          p.removeAttribute('keytip');
        }
        const used = new Set<string>();
        for (const c of childElements(p)) dedupeIn(c, used);
      } else {
        const used = new Set<string>();
        const tab = p.closest('tab');
        if (tab) keytipsIn(tab, p, used);
        dedupeIn(p, used);
      }
    }
    const byName = new Map<string, string[]>();
    for (const u of callbackUses(roots)) byName.set(u.name, [...(byName.get(u.name) ?? []), `${u.id}.${u.attr}`]);
    outcome.callbacks = [...byName].map(([name, uses]) => ({ name, uses }));
    // 付け直せなかった名前が、取り込み先のほかのコントロールと同じ Sub を指していれば、押すと既存のマクロが動く
    // （命名規則が「Sub を共有する」のときは、規則どおりの名前は共有が意図なので警告しない）
    const shared = new Set<string>();
    const walkShared = (el: Element) => {
      for (const a of Array.from(el.attributes)) {
        if (attributes.get(a.name)?.kind !== 'callback' || !a.value || !existingCallbacks.has(bareCallbackName(a.value).toLowerCase())) continue;
        const byRule = opts.naming?.shared === true && bareCallbackName(a.value).toLowerCase() === callbackName(opts.naming, idOf(el), a.name, el.localName).toLowerCase();
        if (!byRule) shared.add(a.value);
      }
      for (const c of childElements(el)) walkShared(c);
    };
    for (const r of roots) walkShared(r);
    outcome.sharedCallbacks = [...shared];
    outcome.added = placed.map((el) => pathOf(el));
    return selectMany(outcome.added);
  }, label);
  return ok ? outcome : null;
}
