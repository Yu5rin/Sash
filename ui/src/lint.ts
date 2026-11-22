// 検証（Lint）。スキーマ定義に基づく構造チェックと、仕様書 §5.6 の独自ルールを行う。

import { allElements, pathOf, type Path } from './model';
import { attributes, defFor, ID_PATTERN } from './schema';

export type Severity = 'error' | 'warning' | 'info';

export interface Problem {
  severity: Severity;
  message: string;
  path: Path;
  /** 問題のある属性（あれば XML エディタでその属性に波線を引く）。 */
  attr?: string;
}

export interface LintContext {
  version: 'office2007' | 'office2010';
  /** ファイル内にある画像の Id。 */
  imageIds: ReadonlySet<string>;
  /** 既知の idMso（カタログ）。空なら idMso の存在チェックをしない。 */
  knownIdMso: ReadonlySet<string>;
  /** Excel で存在しないと確認できた imageMso。 */
  missingImageMso: ReadonlySet<string>;
}

export const NAMESPACES = {
  office2007: 'http://schemas.microsoft.com/office/2006/01/customui',
  office2010: 'http://schemas.microsoft.com/office/2009/07/customui',
} as const;

/** グループ内のコントロールがこれを超えると、狭い画面で畳まれやすい。 */
const MANY_CONTROLS = 12;

export function lint(doc: Document, ctx: LintContext): Problem[] {
  const problems: Problem[] = [];
  const add = (severity: Severity, el: Element, message: string, attr?: string) =>
    problems.push({ severity, message, path: pathOf(el), attr });

  const root = doc.documentElement;
  if (root.localName !== 'customUI') {
    add('error', root, 'ルート要素は customUI にしてください');
    return problems;
  }
  const expectedNs = NAMESPACES[ctx.version];
  if (root.namespaceURI !== expectedNs) {
    add('error', root, `名前空間が ${ctx.version === 'office2010' ? 'customUI14（2010以降）' : 'customUI（2007）'} 用ではありません。xmlns="${expectedNs}" にしてください`, 'xmlns');
  }

  const ids = new Map<string, Element[]>();
  const idQs = new Map<string, Element[]>();
  const builtInContainers = new Map<string, Element[]>();

  const visit = (el: Element, opaque: boolean) => {
    const def = defFor(el);
    if (opaque) return;
    if (!def) {
      add('error', el, `不明な要素 <${el.localName}> です`);
      return;
    }
    if (def.since2010 && ctx.version === 'office2007') add('error', el, `<${el.localName}> は2010以降の形式でのみ使えます`);

    const parent = el.parentElement;
    if (parent) {
      const pdef = defFor(parent);
      if (pdef && !pdef.opaque && !pdef.children.includes(el.localName)) {
        add('error', el, `<${parent.localName}> の中に <${el.localName}> は置けません`);
      }
    }

    // 属性の種類と値
    for (const at of Array.from(el.attributes)) {
      const name = at.name;
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const adef = attributes.get(name);
      if (!adef || !def.attrs.includes(name)) {
        add('error', el, `<${el.localName}> に ${name} 属性は使えません`, name);
        continue;
      }
      if (adef.since2010 && ctx.version === 'office2007') add('error', el, `${name} は2010以降の形式でのみ使えます`, name);
      const v = at.value;
      switch (adef.kind) {
        case 'bool':
          if (!/^(true|false|1|0)$/.test(v)) add('error', el, `${name} は true か false で指定してください`, name);
          break;
        case 'enum':
          if (!adef.values!.includes(v)) add('error', el, `${name} は ${adef.values!.join(' / ')} のいずれかです`, name);
          break;
        case 'int':
          if (!/^\d+$/.test(v)) add('error', el, `${name} は整数で指定してください`, name);
          break;
        case 'id':
          if (!ID_PATTERN.test(v)) add('error', el, `id「${v}」は英字かアンダースコアで始め、英数字と _ . - だけを使ってください`, name);
          break;
        case 'callback':
          if (!/^[A-Za-z_][A-Za-z0-9_.!]*$/.test(v)) add('error', el, `コールバック名「${v}」はVBAのSub名として使えません`, name);
          break;
        case 'idMso':
          if (ctx.knownIdMso.size > 0 && v && !ctx.knownIdMso.has(v)) add('warning', el, `idMso「${v}」はExcelのコマンド一覧にありません`, name);
          break;
        case 'imageMso':
          if (ctx.missingImageMso.has(v)) add('warning', el, `imageMso「${v}」はExcelに存在しません`, name);
          break;
        case 'image':
          if (!ctx.imageIds.has(v)) add('error', el, `画像「${v}」がファイル内にありません`, name);
          break;
        case 'string':
          break;
      }
    }

    // 識別子
    const idAttrs = ['id', 'idMso', 'idQ'].filter((n) => el.hasAttribute(n));
    if (def.idRequired && idAttrs.length === 0 && def.attrs.some((n) => n === 'id' || n === 'idMso')) {
      add('error', el, `<${el.localName}> には id（または idMso / idQ）が必要です`);
    }
    if (idAttrs.length > 1) add('error', el, `${idAttrs.join(' と ')} は同時に指定できません`, idAttrs[1]);
    const id = el.getAttribute('id');
    if (id) ids.set(id, [...(ids.get(id) ?? []), el]);
    const idQ = el.getAttribute('idQ');
    if (idQ) idQs.set(idQ, [...(idQs.get(idQ) ?? []), el]);
    const idMso = el.getAttribute('idMso');
    if (idMso && (el.localName === 'tab' || el.localName === 'group' || el.localName === 'tabSet')) {
      const key = `${el.localName}:${idMso}`;
      builtInContainers.set(key, [...(builtInContainers.get(key) ?? []), el]);
    }

    // 静的属性と get 系コールバックの同時指定
    for (const at of Array.from(el.attributes)) {
      const adef = attributes.get(at.name);
      if (adef?.dynamic && el.hasAttribute(adef.dynamic) && at.name !== 'imageMso') {
        add('error', el, `${at.name} と ${adef.dynamic} は同時に指定できません`, adef.dynamic);
      }
    }
    if (el.hasAttribute('image') && el.hasAttribute('imageMso')) add('error', el, 'image と imageMso は同時に指定できません', 'imageMso');
    if (el.hasAttribute('imageMso') && el.hasAttribute('getImage')) add('error', el, 'imageMso と getImage は同時に指定できません', 'getImage');

    // グループ内のコントロール数
    if (el.localName === 'group' && el.children.length > MANY_CONTROLS) {
      add('info', el, `コントロールが ${el.children.length} 個あります。狭い画面ではグループが畳まれます`);
    }

    for (const c of Array.from(el.children)) visit(c, def.opaque === true);
  };
  visit(root, false);

  const dup = (map: Map<string, Element[]>, attr: string, label: string) => {
    for (const [value, els] of map) {
      if (els.length < 2) continue;
      for (const el of els) add('error', el, `${label}「${value}」が ${els.length} か所で重複しています`, attr);
    }
  };
  dup(ids, 'id', 'id');
  dup(idQs, 'idQ', 'idQ');
  dup(builtInContainers, 'idMso', 'idMso');

  lintKeytips(doc, add);

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return problems.sort((x, y) => order[x.severity] - order[y.severity]);
}

/** keytip の重複。タブ同士と、同じタブの中のコントロール同士で調べる。 */
function lintKeytips(doc: Document, add: (s: Severity, el: Element, m: string, attr?: string) => void): void {
  const check = (els: Element[]) => {
    const seen = new Map<string, Element[]>();
    for (const el of els) {
      const k = el.getAttribute('keytip')?.toUpperCase();
      if (k) seen.set(k, [...(seen.get(k) ?? []), el]);
    }
    for (const [k, list] of seen) {
      if (list.length > 1) for (const el of list) add('warning', el, `keytip「${k}」が重複しています`, 'keytip');
    }
  };
  const tabs = allElements(doc).filter((el) => el.localName === 'tab');
  check(tabs);
  for (const tab of tabs) {
    const inner = allElements(doc).filter((el) => el !== tab && tab.contains(el));
    check(inner);
  }
}
