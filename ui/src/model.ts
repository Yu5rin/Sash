// customUI の内部モデル。XML の DOM（Document）をそのまま唯一の正とする。
// DOM を直接持つので、キャンバスで編集してもコメントと属性の並び順は保たれる（仕様書 §5.5）。
// 要素の位置は「ルートからの子要素の番号の並び」（パス）で表し、XML を読み直しても選択を保てるようにする。

import { backstageElements, canContainEl, elements, ID_PATTERN, ID_PREFIX, inBackstage } from './schema';

export type Path = readonly number[];

export type ParseResult = { ok: true; doc: Document } | { ok: false; message: string; line?: number };

export function parseXml(xml: string): ParseResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    // Chromium のエラー文（"error on line 3 at column 5: ..."）から、行・列・内容だけを取り出す
    const text = (error.textContent ?? '').replace(/\s+/g, ' ');
    const m = /line (\d+) at column (\d+):\s*(.*?)(?:\s*Below is a rendering.*)?$/i.exec(text);
    if (m) return { ok: false, message: `${m[1]}行目 ${m[2]}列：${m[3]}`, line: Number(m[1]) };
    const line = /line (\d+)/i.exec(text);
    return { ok: false, message: text.trim() || 'XMLの構文エラー', line: line ? Number(line[1]) : undefined };
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

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}

function escapeText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ---- id の提案 ----

/** ファイル内の id / idQ をすべて集める。 */
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
    if (ID_PATTERN.test(base) && !used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(base + n)) return base + n;
  }
  for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

// ---- 編集操作 ----

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
  const ns = doc.documentElement.namespaceURI;
  const used = usedIds(doc);
  const bs = tag === 'backstage' || inBackstage(parent);
  const make = (t: string): Element => {
    const el = doc.createElementNS(ns, t);
    const def = bs ? backstageElements.get(t) : elements.get(t);
    const label = DEFAULT_LABEL[t] ?? null;
    if (def?.idRequired || t === 'separator' || t === 'box' || t === 'buttonGroup') {
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
  const ns = doc.documentElement.namespaceURI;
  const root = doc.documentElement;
  let ribbon = childElements(root).find((c) => c.localName === 'ribbon');
  if (!ribbon) {
    ribbon = doc.createElementNS(ns, 'ribbon');
    // commands の後ろ、backstage の前に置く（スキーマの順序）
    const after = childElements(root).find((c) => c.localName === 'backstage' || c.localName === 'contextMenus');
    root.insertBefore(ribbon, after ?? null);
  }
  let tabs = childElements(ribbon).find((c) => c.localName === 'tabs');
  if (!tabs) {
    tabs = doc.createElementNS(ns, 'tabs');
    const ctx = childElements(ribbon).find((c) => c.localName === 'contextualTabs');
    ribbon.insertBefore(tabs, ctx ?? null);
  }
  return tabs;
}

/** Backstage の要素に、最低限の中身を足す。 */
function buildBackstage(el: Element, make: (t: string) => Element): void {
  const doc = el.ownerDocument;
  const group = (): Element => {
    const g = make('group');
    const top = doc.createElementNS(doc.documentElement.namespaceURI, 'topItems');
    top.append(make('button'));
    g.append(top);
    return g;
  };
  const column = (name: string, ...kids: Element[]) => {
    const c = doc.createElementNS(doc.documentElement.namespaceURI, name);
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
      const top = doc.createElementNS(doc.documentElement.namespaceURI, 'topItems');
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
    case 'menu':
      el.append(make('button'));
      break;
  }
}

/** customUI > backstage を必要なら作って返す（ribbon の後ろ、contextMenus の前に置く）。 */
export function ensureBackstage(doc: Document): Element {
  const root = doc.documentElement;
  let bs = childElements(root).find((c) => c.localName === 'backstage');
  if (!bs) {
    bs = doc.createElementNS(root.namespaceURI, 'backstage');
    root.insertBefore(bs, childElements(root).find((c) => c.localName === 'contextMenus') ?? null);
  }
  return bs;
}

/** customUI > contextMenus を必要なら作って返す（backstage の後ろ、末尾に置く）。 */
export function ensureContextMenus(doc: Document): Element {
  const root = doc.documentElement;
  let cm = childElements(root).find((c) => c.localName === 'contextMenus');
  if (!cm) {
    cm = doc.createElementNS(root.namespaceURI, 'contextMenus');
    root.append(cm);
  }
  return cm;
}

export function insertAt(parent: Element, child: Element, index: number): void {
  const ref = parent.children[index] ?? null;
  parent.insertBefore(child, ref);
}

/** 要素を移動する。移動先が自分の子孫なら何もしない。 */
export function moveElement(el: Element, newParent: Element, index: number): boolean {
  if (el === newParent || el.contains(newParent)) return false;
  if (!canContainEl(newParent, el.localName)) return false;
  // index は移動前の子要素の並びでの位置。その位置の要素の前に差し込む
  const ref = newParent.children[index] ?? null;
  if (ref !== el) newParent.insertBefore(el, ref);
  return true;
}

/** 複製する。id は重ならないよう振り直す。 */
export function duplicateElement(el: Element): Element {
  const doc = el.ownerDocument;
  const copy = el.cloneNode(true) as Element;
  const used = usedIds(doc);
  const reassign = (x: Element) => {
    const id = x.getAttribute('id');
    if (id) {
      const next = suggestId(x.localName, null, used);
      used.add(next);
      x.setAttribute('id', next);
    }
    for (const c of Array.from(x.children)) reassign(c);
  };
  reassign(copy);
  el.parentElement!.insertBefore(copy, el.nextElementSibling);
  return copy;
}

/** 属性を設定する。null または空文字なら削除する。 */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null || value === '') el.removeAttribute(name);
  else el.setAttribute(name, value);
}
