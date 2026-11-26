// customUI の内部モデル。XML の DOM（Document）をそのまま唯一の正とする。
// DOM を直接持つので、キャンバスで編集してもコメントと属性の並び順は保たれる（仕様書 §5.5）。
// 要素の位置は「ルートからの子要素の番号の並び」（パス）で表し、XML を読み直しても選択を保てるようにする。

import {
  backstageElements, canContain, canContainEl, defFor, elements, ID_PREFIX, inBackstage, isXmlId, NAMESPACES, slotIndex, titleOf,
} from './schema';
import { t as tr } from './i18n';

export type Path = readonly number[];

export type ParseResult = { ok: true; doc: Document } | { ok: false; message: string; line?: number };

export function parseXml(xml: string): ParseResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    // Chromium のエラー文（"error on line 3 at column 5: ..."）から、行・列・内容だけを取り出す
    const text = (error.textContent ?? '').replace(/\s+/g, ' ');
    const m = /line (\d+) at column (\d+):\s*(.*?)(?:\s*Below is a rendering.*)?$/i.exec(text);
    if (m) return { ok: false, message: tr('{line}行目 {column}列：{message}', { line: m[1]!, column: m[2]!, message: m[3]! }), line: Number(m[1]) };
    const line = /line (\d+)/i.exec(text);
    return { ok: false, message: text.trim() || tr('XML の構文エラー'), line: line ? Number(line[1]) : undefined };
  }
  return { ok: true, doc };
}

export function childElements(el: Element): Element[] {
  return Array.from(el.children);
}

export function elementAt(doc: Document, path: Path): Element | null {
  let el: Element | null = doc.documentElement;
  for (const i of path) {
    el = el?.children[i] ?? null;
    if (!el) return null;
  }
  return el;
}

/**
 * その場で名前を入力している間、入力欄が持つパスがまだ同じ要素を指しているかを確かめるための控え。
 * 文書が（XML の編集・元に戻す・並べ替えなどで）変わると、パスの先が別の要素になりうる。確定してしまうと別の要素の
 * ラベルを書き換えるので、同じ種類・同じ id（id がなければ同じラベル）かどうかで見分ける。
 */
export interface ElementSnapshot {
  tag: string;
  id: string | null;
  label: string | null;
}

export function snapshotOf(el: Element): ElementSnapshot {
  return { tag: el.localName, id: el.getAttribute('id'), label: el.getAttribute('label') };
}

/** path の先が、snapshot を取ったときと同じ要素か。 */
export function isSameElementAt(doc: Document, path: Path, snap: ElementSnapshot): boolean {
  const cur = elementAt(doc, path);
  if (!cur || cur.localName !== snap.tag) return false;
  return snap.id !== null ? cur.getAttribute('id') === snap.id : cur.getAttribute('label') === snap.label;
}

export function pathOf(el: Element): number[] {
  const path: number[] = [];
  let cur: Element = el;
  while (cur.parentElement) {
    path.unshift(Array.prototype.indexOf.call(cur.parentElement.children, cur));
    cur = cur.parentElement;
  }
  return path;
}

export function samePath(a: Path | null, b: Path | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 文書の順（先行順）での前後。a が先なら負、同じなら 0、後なら正。祖先は子孫より先。 */
export function comparePaths(a: Path, b: Path): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function isAncestorPath(ancestor: Path, path: Path): boolean {
  return ancestor.length < path.length && ancestor.every((v, i) => v === path[i]);
}

/** 文書順（先行順）にすべての要素を返す。XML テキスト上の位置との対応付けに使う。 */
export function allElements(doc: Document): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    out.push(el);
    for (const c of Array.from(el.children)) walk(c);
  };
  if (doc.documentElement) walk(doc.documentElement);
  return out;
}

export function displayName(el: Element): string {
  // 分割ボタンは label を持てず、中の先頭のボタンが持つ。ツリーなどで id だけが並ばないよう、中のボタンのラベルを出す
  if (el.localName === 'splitButton' && !el.hasAttribute('label')) {
    const inner = Array.from(el.children).find((c) => c.localName === 'button' || c.localName === 'toggleButton');
    const innerLabel = inner?.getAttribute('label');
    if (innerLabel) return innerLabel;
  }
  return el.getAttribute('label') ?? el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ') ?? '';
}

export function identifierOf(el: Element): string | null {
  return el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.getAttribute('idQ');
}

// ---- 整形 ----

const INDENT = '  ';

/** 文書を整形して文字列にする。コメントと属性の順序は保ち、空白だけを整える。 */
export function serialize(doc: Document): string {
  const lines: string[] = [];
  for (const node of Array.from(doc.childNodes)) {
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      const pi = node as ProcessingInstruction;
      lines.push(`<?${pi.target} ${pi.data}?>`);
    } else if (node.nodeType === Node.COMMENT_NODE) {
      lines.push(`<!--${(node as Comment).data}-->`);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      writeElement(node as Element, 0, lines);
    }
  }
  return lines.join('\n') + '\n';
}

function writeElement(el: Element, depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth);
  const attrs = Array.from(el.attributes).map((at) => ` ${at.name}="${escapeAttr(at.value)}"`).join('');
  const kids = Array.from(el.childNodes).filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.COMMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== '') || n.nodeType === Node.CDATA_SECTION_NODE,
  );
  if (kids.length === 0) {
    lines.push(`${pad}<${el.tagName}${attrs} />`);
    return;
  }
  lines.push(`${pad}<${el.tagName}${attrs}>`);
  for (const k of kids) {
    if (k.nodeType === Node.ELEMENT_NODE) writeElement(k as Element, depth + 1, lines);
    else if (k.nodeType === Node.COMMENT_NODE) lines.push(`${pad}${INDENT}<!--${(k as Comment).data}-->`);
    else if (k.nodeType === Node.CDATA_SECTION_NODE) lines.push(`${pad}${INDENT}<![CDATA[${k.textContent}]]>`);
    else lines.push(`${pad}${INDENT}${escapeText(k.textContent!.trim())}`);
  }
  lines.push(`${pad}</${el.tagName}>`);
}

/**
 * 属性値のエスケープ。改行・復帰・タブは、そのまま書くと読み直したときに空白へ正規化されてしまうので文字参照にする。
 * > は属性値の中ではエスケープしなくても正しいが、]]> などの誤読を避けるため常に &gt; にする。
 */
export function escapeAttr(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function escapeText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ---- id の提案 ----

/**
 * ファイル内の id をすべて集める。
 * idQ は「接頭辞:名前」の形で別のアドインの id を指すもので、自分の id と同じ空間ではないので含めない。
 */
export function usedIds(doc: Document): Set<string> {
  const ids = new Set<string>();
  for (const el of allElements(doc)) {
    const id = el.getAttribute('id');
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * id を提案する。ラベルが英数字なら単語をつなげ（例：「Export CSV」→ btnExportCsv）、
 * それ以外は種類の接頭辞に連番を付ける（例：btn1）。
 */
export function suggestId(tag: string, label: string | null, used: ReadonlySet<string>): string {
  const prefix = ID_PREFIX[tag] ?? tag.slice(0, 3);
  const words = label !== null && /^[\x20-\x7e]+$/.test(label) ? label.match(/[A-Za-z0-9]+/g) : null;
  if (words) {
    const base = prefix + words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('');
    if (isXmlId(base) && !used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(base + n)) return base + n;
  }
  for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

/**
 * 日本語などのラベルそのものを使った id の案（例：ボタン「出荷一覧を作る」→ btn出荷一覧を作る）。
 * id には Unicode の文字を使える（仕様書 §17.2）ので、英字にできないラベルでも、読んで分かる id を選べるようにする。
 * 空白や記号は落とし、文字・数字・_ だけを残す。使えない形になるとき（空・数字だけなど）は null。
 */
export function suggestIdFromLabel(tag: string, label: string | null, used: ReadonlySet<string>): string | null {
  const prefix = ID_PREFIX[tag] ?? tag.slice(0, 3);
  const body = (label ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}_]/gu, '');
  if (!body) return null;
  const base = prefix + body;
  if (!isXmlId(base)) return null;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(base + n)) return base + n;
}

// ---- 編集操作 ----

// ---- 要素の作成（接頭辞つきの文書に対応） ----

/**
 * 文書と同じ名前空間・同じ接頭辞で要素を作る。
 * <mso:customUI xmlns:mso="…"> のような文書に接頭辞なしの要素を足すと、書き出したときに名前空間が外れてしまうため。
 */
export function createIn(doc: Document, tag: string): Element {
  const root = doc.documentElement;
  return doc.createElementNS(root.namespaceURI, root.prefix ? `${root.prefix}:${tag}` : tag);
}

/** 別の文書の要素を、この文書の名前空間・接頭辞で作り直して取り込む（コメントと文字列も写す）。 */
export function importElement(doc: Document, el: Element): Element {
  const copy = createIn(doc, el.localName);
  for (const at of Array.from(el.attributes)) {
    if (at.name === 'xmlns' || at.name.startsWith('xmlns:')) continue;
    if (at.namespaceURI) copy.setAttributeNS(at.namespaceURI, at.name, at.value);
    else copy.setAttribute(at.name, at.value);
  }
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.ELEMENT_NODE) copy.append(importElement(doc, n as Element));
    else copy.append(doc.importNode(n, true));
  }
  return copy;
}

const DEFAULT_LABEL: Readonly<Record<string, string>> = {
  tab: '新しいタブ', group: '新しいグループ', button: 'ボタン', toggleButton: 'トグル', checkBox: 'チェック',
  menu: 'メニュー', dynamicMenu: 'メニュー', gallery: 'ギャラリー', dropDown: 'ドロップダウン', comboBox: 'コンボ',
  editBox: '入力', labelControl: 'ラベル', item: '項目',
  taskGroup: 'タスク', taskFormGroup: 'タスク', category: 'カテゴリ', task: 'タスク', hyperlink: 'リンク',
  groupBox: '枠', radioGroup: '選択', radioButton: '選択肢', menuGroup: 'グループ',
};

/**
 * パレットから置く要素を作る。分割ボタンなど、子要素が必須のものは一緒に作る。
 * parent を渡すと、その場所に合った定義（Backstage の中かどうか）で作る。
 */
export function createElement(doc: Document, tag: string, parent: Element | null = null): Element {
  const used = usedIds(doc);
  const bs = tag === 'backstage' || inBackstage(parent);
  const make = (t: string): Element => {
    const el = createIn(doc, t);
    const def = bs ? backstageElements.get(t) : elements.get(t);
    const label = DEFAULT_LABEL[t] !== undefined ? tr(DEFAULT_LABEL[t]) : null;
    // item の id は省略できるが、getItemID などで区別しやすいように付けておく
    if (def?.idRequired || t === 'separator' || t === 'box' || t === 'buttonGroup' || t === 'item' || t === 'menuGroup') {
      const id = suggestId(t, null, used);
      used.add(id);
      el.setAttribute('id', id);
    }
    if (label && def?.attrs.includes('label')) el.setAttribute('label', label);
    return el;
  };

  const el = make(tag);
  if (bs) {
    buildBackstage(el, make);
    return el;
  }
  if (tag === 'contextMenu') {
    // コンテキストメニューは組み込みのメニュー（idMso）に項目を足すもの。既定はセルの右クリックメニュー
    el.removeAttribute('id');
    el.setAttribute('idMso', 'ContextMenuCell');
    el.append(make('button'));
  } else if (tag === 'splitButton') {
    el.append(make('button'), make('menu'));
    el.children[1]!.append(make('button'));
  } else if (tag === 'menu') {
    el.append(make('button'));
  } else if (tag === 'dialogBoxLauncher') {
    el.append(make('button'));
  } else if (tag === 'dropDown' || tag === 'comboBox') {
    el.append(make('item'));
  }
  return el;
}

/** customUI > ribbon > tabs を必要なら作って返す。 */
export function ensureTabs(doc: Document): Element {
  return ensureChild(ensureChild(doc.documentElement, 'ribbon'), 'tabs');
}

/** 親の直下にある tag の要素を返す。なければスキーマの順序に合う位置に作る（ribbon は commands の後ろ、backstage の前など）。 */
function ensureChild(parent: Element, tag: string): Element {
  const found = childElements(parent).find((c) => c.localName === tag);
  if (found) return found;
  const el = createIn(parent.ownerDocument, tag);
  insertAt(parent, el, allowedInsertIndex(parent, tag, parent.children.length) ?? parent.children.length);
  return el;
}

/** Backstage の要素に、最低限の中身を足す。 */
function buildBackstage(el: Element, make: (t: string) => Element): void {
  const doc = el.ownerDocument;
  const group = (): Element => {
    const g = make('group');
    const top = createIn(doc, 'topItems');
    top.append(make('button'));
    g.append(top);
    return g;
  };
  const column = (name: string, ...kids: Element[]) => {
    const c = createIn(doc, name);
    c.append(...kids);
    return c;
  };
  switch (el.localName) {
    case 'backstage': {
      const tab = make('tab');
      tab.append(column('firstColumn', group()));
      el.append(tab);
      break;
    }
    case 'tab':
      el.append(column('firstColumn', group()));
      break;
    case 'group': {
      const top = createIn(doc, 'topItems');
      top.append(make('button'));
      el.append(top);
      break;
    }
    case 'taskGroup':
    case 'taskFormGroup': {
      const cat = make('category');
      const task = make('task');
      if (el.localName === 'taskFormGroup') task.append(group());
      cat.append(task);
      el.append(cat);
      break;
    }
    case 'radioGroup':
      el.append(make('radioButton'), make('radioButton'));
      break;
    case 'dropDown':
    case 'comboBox':
      el.append(make('item'));
      break;
    case 'menu': {
      // Backstage の menu の直下には menuGroup しか置けないので、menuGroup の中にボタンを入れる
      const mg = make('menuGroup');
      mg.append(make('button'));
      el.append(mg);
      break;
    }
  }
}

/** customUI > backstage を必要なら作って返す（ribbon の後ろ、contextMenus の前に置く）。 */
export function ensureBackstage(doc: Document): Element {
  return ensureChild(doc.documentElement, 'backstage');
}

/** customUI > contextMenus を必要なら作って返す（backstage の後ろ、末尾に置く）。 */
export function ensureContextMenus(doc: Document): Element {
  return ensureChild(doc.documentElement, 'contextMenus');
}

export function insertAt(parent: Element, child: Element, index: number): void {
  const ref = parent.children[index] ?? null;
  if (ref !== child) parent.insertBefore(child, ref);
}

// ---- 子要素の順序と個数 ----

/**
 * parent の desired 番目（今の子要素の並びでの位置）に tag を差し込むとき、スキーマの順序で許される位置に収めて返す。
 * 個数の上限に達していて置けなければ null。順序の決まりがない親では、0〜子の数に収めるだけ。
 * ignore には移動中の要素を渡す（同じ親の中での並べ替えで、自分を数えないため）。
 */
export function allowedInsertIndex(parent: Element, tag: string, desired: number, ignore?: Element): number | null {
  const kids = Array.from(parent.children);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const def = defFor(parent);
  const slot = slotIndex(def, tag);
  if (!def?.childOrder || slot < 0) return clamp(desired, 0, kids.length);
  const max = def.childOrder[slot]!.max;
  if (max !== undefined) {
    const count = kids.filter((c) => c !== ignore && slotIndex(def, c.localName) === slot).length;
    if (count >= max) return null;
  }
  let lo = 0;
  let hi = kids.length;
  kids.forEach((c, i) => {
    if (c === ignore) return;
    const s = slotIndex(def, c.localName);
    if (s < 0) return;
    if (s < slot) lo = Math.max(lo, i + 1);
    else if (s > slot && hi === kids.length) hi = Math.min(hi, i);
  });
  // 前の枠の要素が後ろの枠の要素より後ろにある（すでに順序が崩れている）ときは、後ろ寄りの方を優先する
  if (hi < lo) hi = lo;
  return clamp(desired, lo, hi);
}

/** ファイルに1つしか置けない、または親の中で個数の上限に達しているものは複製できない。 */
const SINGLETONS = new Set([
  'customUI', 'ribbon', 'tabs', 'qat', 'backstage', 'contextMenus', 'commands', 'officeMenu', 'contextualTabs',
  'sharedControls', 'documentControls', 'firstColumn', 'secondColumn', 'primaryItem', 'topItems', 'bottomItems',
]);

export function canDuplicate(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent || SINGLETONS.has(el.localName)) return false;
  // 組み込みのタブ・グループ（idMso）を複製すると、同じ組み込みを2回指すことになる
  if ((el.localName === 'tab' || el.localName === 'group' || el.localName === 'tabSet') && el.hasAttribute('idMso')) return false;
  const index = Array.prototype.indexOf.call(parent.children, el) as number;
  return allowedInsertIndex(parent, el.localName, index + 1) !== null;
}

/** 要素を移動する。移動先が自分の子孫か、置けない場所なら何もしない。位置はスキーマの順序に収める。 */
export function moveElement(el: Element, newParent: Element, index: number): boolean {
  if (el === newParent || el.contains(newParent)) return false;
  if (!canContainEl(newParent, el.localName)) return false;
  // index は移動前の子要素の並びでの位置。その位置の要素の前に差し込む
  const at = allowedInsertIndex(newParent, el.localName, index, el);
  if (at === null) return false;
  insertAt(newParent, el, at);
  return true;
}

/** 重なる id に数字を付けて振り直す（btnRun → btnRun2）。振り直した組（元 → 新）を返す。 */
export function renameDuplicateIds(root: Element, used: Set<string>): Map<string, string> {
  const renamed = new Map<string, string>();
  const walk = (x: Element) => {
    const id = x.getAttribute('id');
    if (id) {
      if (used.has(id)) {
        const base = id.replace(/\d+$/, '') || id;
        let n = 2;
        while (used.has(`${base}${n}`)) n++;
        const next = `${base}${n}`;
        x.setAttribute('id', next);
        renamed.set(id, next);
        used.add(next);
      } else {
        used.add(id);
      }
    }
    for (const c of childElements(x)) walk(c);
  };
  walk(root);
  return renamed;
}

/**
 * 複製して、元の要素のすぐ後ろ（並び順の決まりで置ける位置）に置く。id は重ならないよう振り直す
 * （貼り付けと同じく btn1 → btn2 のように番号を進める）。複製できないもの（canDuplicate が false）は例外にする。
 * 編集メニューの「複製」（clipboard.duplicate）もこれを使う。
 */
export function duplicateElement(el: Element): Element {
  if (!canDuplicate(el)) throw new Error(tr('<{tag}> はこれ以上複製できません', { tag: el.localName }));
  const copy = el.cloneNode(true) as Element;
  renameDuplicateIds(copy, usedIds(el.ownerDocument));
  const parent = el.parentElement!;
  const index = Array.prototype.indexOf.call(parent.children, el) as number;
  insertAt(parent, copy, allowedInsertIndex(parent, el.localName, index + 1) ?? index + 1);
  return copy;
}

// ---- 選択に応じた挿入 ----

/** リボンのグループに置けるコントロールか（グループがなければ作って入れる対象）。 */
function isGroupControl(tag: string): boolean {
  return canContain('group', tag);
}

function placeIn(parent: Element, el: Element, desired: number): Element | null {
  const at = allowedInsertIndex(parent, el.localName, desired);
  if (at === null) return null;
  insertAt(parent, el, at);
  return el;
}

/** 新しいタブ（ラベル付き）をタブ一覧の末尾に作る。 */
function newTab(doc: Document): Element {
  const tab = createElement(doc, 'tab');
  ensureTabs(doc).append(tab);
  return tab;
}

/** 自分で作ったタブ（id を持つもの）のうち最初のもの。 */
function firstCustomTab(doc: Document): Element | null {
  const ribbon = childElements(doc.documentElement).find((c) => c.localName === 'ribbon');
  const tabs = ribbon && childElements(ribbon).find((c) => c.localName === 'tabs');
  return (tabs && childElements(tabs).find((c) => c.localName === 'tab' && c.hasAttribute('id'))) ?? null;
}

/** 何も選んでいないか、customUI・ribbon・tabs のような「全体」を選んでいるか。 */
function isRibbonTop(el: Element | null): boolean {
  return el === null || el === el.ownerDocument.documentElement || el.localName === 'ribbon' || el.localName === 'tabs';
}

/** リボンのタブ（Backstage のタブではない）。 */
function ribbonTabOf(el: Element | null): Element | null {
  for (let cur = el; cur; cur = cur.parentElement) {
    if (cur.localName === 'tab' && !inBackstage(cur)) return cur;
  }
  return null;
}

/**
 * パレットなどから tag の要素を作り、選択中の要素の近くに置く。
 * 選択中の要素かその祖先のうち、置けるところで最も近いものに入れる（選択中の要素の後ろ、またはその中の末尾）。
 * 置ける場所がなければ、無理のない範囲で親を作る（コントロールならグループ、グループならタブなど）。
 * store.edit の中で呼ぶこと。置けないときは理由を返す。
 */
export function insertSmart(doc: Document, selected: Element | null, tag: string): { el: Element } | { error: string } {
  const root = doc.documentElement;
  const is2007 = root.namespaceURI === NAMESPACES.office2007;
  const ribbonDef = elements.get(tag);
  if (ribbonDef?.since2010 && is2007 && !inBackstage(selected)) {
    return { error: tr('{name} は2010以降の形式（customUI14）でのみ使えます', { name: titleOf(tag) }) };
  }

  if (tag === 'backstage') {
    if (childElements(root).some((c) => c.localName === 'backstage')) return { error: tr('Backstage はすでにあります（1つのファイルに1つだけです）') };
    const bs = createElement(doc, 'backstage');
    return placeIn(root, bs, root.children.length) ? { el: bs } : { error: tr('Backstage はすでにあります（1つのファイルに1つだけです）') };
  }

  // 1. 選択中の要素から上にたどり、置ける場所を探す
  let full: Element | null = null;
  let after: Element | null = null;
  for (let cur = selected; cur; after = cur, cur = cur.parentElement) {
    if (!canContainEl(cur, tag)) continue;
    const desired = after ? Array.prototype.indexOf.call(cur.children, after) + 1 : cur.children.length;
    // 置く場所に合った定義で作る（Backstage の中かどうかで中身が変わるため）
    const el = placeIn(cur, createElement(doc, tag, cur), desired);
    if (el) return { el };
    full ??= cur;
  }
  if (full) return { error: tr('<{parent}> の中に {name} はこれ以上置けません', { parent: full.localName, name: titleOf(tag) }) };
  if (inBackstage(selected)) return { error: tr('選んでいる場所には {name} を置けません。置ける場所を選んでください', { name: titleOf(tag) }) };

  // 2. 置ける場所がないので、必要な親を作る
  if (tag === 'tab') {
    const el = createElement(doc, 'tab');
    ensureTabs(doc).append(el);
    return { el };
  }
  if (tag === 'contextMenu') {
    const el = createElement(doc, 'contextMenu');
    ensureContextMenus(doc).append(el);
    return { el };
  }
  if (tag === 'group') {
    // 何も選んでいない（またはタブの外を選んでいる）ときは、最初の自作タブ、なければ新しいタブに入れる
    if (!isRibbonTop(selected)) return { error: tr('グループはタブの中に置きます。タブを選んでください') };
    const tab = firstCustomTab(doc) ?? newTab(doc);
    const el = createElement(doc, 'group', tab);
    tab.append(el);
    return { el };
  }
  if (isGroupControl(tag)) {
    // タブを選んでいれば、そのタブに新しいグループを作って入れる。何も選んでいなければ最初の自作タブ（なければ新しいタブ）に作る
    const selectedTab = ribbonTabOf(selected);
    if (!selectedTab && !isRibbonTop(selected)) {
      return { error: tr('{name}はグループの中に置きます。グループかタブを選んでください', { name: titleOf(tag) }) };
    }
    const tab = selectedTab ?? firstCustomTab(doc) ?? newTab(doc);
    const group = createElement(doc, 'group', tab);
    tab.append(group);
    const el = placeIn(group, createElement(doc, tag, group), group.children.length);
    return el ? { el } : { error: tr('{name}はグループの中に置きます。グループかタブを選んでください', { name: titleOf(tag) }) };
  }
  // customUI や ribbon の直下に置くもの（qat、commands、contextMenus など）
  for (const parent of [root, ...(canContain('ribbon', tag) ? [ensureChild(root, 'ribbon')] : [])]) {
    if (!canContainEl(parent, tag)) continue;
    const el = placeIn(parent, createElement(doc, tag, parent), parent.children.length);
    return el ? { el } : { error: tr('<{parent}> の中に {name} はこれ以上置けません', { parent: parent.localName, name: titleOf(tag) }) };
  }
  return { error: tr('選んでいる場所には {name} を置けません。置ける場所を選んでください', { name: titleOf(tag) }) };
}

/** 属性を設定する。null または空文字なら削除する。 */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null || value === '') el.removeAttribute(name);
  else el.setAttribute(name, value);
}
