// 検証（Lint）。スキーマ定義に基づく構造チェックと、仕様書 §5.6 の独自ルールを行う。

import { allElements, pathOf, type Path } from './model';
import { attributes, defFor, ID_PATTERN } from './schema';
import { t } from './i18n';

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
    add('error', root, t('ルート要素は customUI にしてください'));
    return problems;
  }
  const expectedNs = NAMESPACES[ctx.version];
  if (root.namespaceURI !== expectedNs) {
    add('error', root, t('名前空間が {format} 用ではありません。xmlns="{ns}" にしてください', { format: ctx.version === 'office2010' ? t('customUI14（2010以降）') : t('customUI（2007）'), ns: expectedNs }), 'xmlns');
  }

  const ids = new Map<string, Element[]>();
  const idQs = new Map<string, Element[]>();
  const builtInContainers = new Map<string, Element[]>();

  const visit = (el: Element, opaque: boolean) => {
    const def = defFor(el);
    if (opaque) return;
    if (!def) {
      add('error', el, t('不明な要素 <{tag}> です', { tag: el.localName }));
      return;
    }
    if (def.since2010 && ctx.version === 'office2007') add('error', el, t('<{tag}> は2010以降の形式でのみ使えます', { tag: el.localName }));

    const parent = el.parentElement;
    if (parent) {
      const pdef = defFor(parent);
      if (pdef && !pdef.opaque && !pdef.children.includes(el.localName)) {
        add('error', el, t('<{parent}> の中に <{child}> は置けません', { parent: parent.localName, child: el.localName }));
      }
    }

    // 属性の種類と値
    for (const at of Array.from(el.attributes)) {
      const name = at.name;
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const adef = attributes.get(name);
      if (!adef || !def.attrs.includes(name)) {
        add('error', el, t('<{tag}> に {attr} 属性は使えません', { tag: el.localName, attr: name }), name);
        continue;
      }
      if (adef.since2010 && ctx.version === 'office2007') add('error', el, t('{attr} は2010以降の形式でのみ使えます', { attr: name }), name);
      const v = at.value;
      switch (adef.kind) {
        case 'bool':
          if (!/^(true|false|1|0)$/.test(v)) add('error', el, t('{attr} は true か false で指定してください', { attr: name }), name);
          break;
        case 'enum':
          if (!adef.values!.includes(v)) add('error', el, t('{attr} は {values} のいずれかです', { attr: name, values: adef.values!.join(' / ') }), name);
          break;
        case 'int':
          if (!/^\d+$/.test(v)) add('error', el, t('{attr} は整数で指定してください', { attr: name }), name);
          break;
        case 'id':
          if (!ID_PATTERN.test(v)) add('error', el, t('id「{value}」は英字かアンダースコアで始め、英数字と _ . - だけを使ってください', { value: v }), name);
          break;
        case 'callback':
          if (!/^[A-Za-z_][A-Za-z0-9_.!]*$/.test(v)) add('error', el, t('コールバック名「{value}」はVBAのSub名として使えません', { value: v }), name);
          break;
        case 'idMso':
          if (ctx.knownIdMso.size > 0 && v && !ctx.knownIdMso.has(v)) add('warning', el, t('idMso「{value}」はExcelのコマンド一覧にありません', { value: v }), name);
          break;
        case 'imageMso':
          if (ctx.missingImageMso.has(v)) add('warning', el, t('imageMso「{value}」はExcelに存在しません', { value: v }), name);
          break;
        case 'image':
          if (!ctx.imageIds.has(v)) add('error', el, t('画像「{value}」がファイル内にありません', { value: v }), name);
          break;
        case 'string':
          break;
      }
    }

    // 識別子
    const idAttrs = ['id', 'idMso', 'idQ'].filter((n) => el.hasAttribute(n));
    if (def.idRequired && idAttrs.length === 0 && def.attrs.some((n) => n === 'id' || n === 'idMso')) {
      add('error', el, t('<{tag}> には id（または idMso / idQ）が必要です', { tag: el.localName }));
    }
    if (idAttrs.length > 1) add('error', el, t('{attrs} は同時に指定できません', { attrs: idAttrs.join(t(' と ')) }), idAttrs[1]);
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
        add('error', el, t('{a} と {b} は同時に指定できません', { a: at.name, b: adef.dynamic }), adef.dynamic);
      }
    }
    if (el.hasAttribute('image') && el.hasAttribute('imageMso')) add('error', el, t('{a} と {b} は同時に指定できません', { a: 'image', b: 'imageMso' }), 'imageMso');
    if (el.hasAttribute('imageMso') && el.hasAttribute('getImage')) add('error', el, t('{a} と {b} は同時に指定できません', { a: 'imageMso', b: 'getImage' }), 'getImage');

    // グループ内のコントロール数
    if (el.localName === 'group' && el.children.length > MANY_CONTROLS) {
      add('info', el, t('コントロールが {n} 個あります。狭い画面ではグループが畳まれます', { n: el.children.length }));
    }

    for (const c of Array.from(el.children)) visit(c, def.opaque === true);
  };
  visit(root, false);

  const dup = (map: Map<string, Element[]>, attr: string, label: string) => {
    for (const [value, els] of map) {
      if (els.length < 2) continue;
      for (const el of els) add('error', el, t('{label}「{value}」が {n} か所で重複しています', { label, value, n: els.length }), attr);
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
      if (list.length > 1) for (const el of list) add('warning', el, t('keytip「{value}」が重複しています', { value: k }), 'keytip');
    }
  };
  const tabs = allElements(doc).filter((el) => el.localName === 'tab');
  check(tabs);
  for (const tab of tabs) {
    const inner = allElements(doc).filter((el) => el !== tab && tab.contains(el));
    check(inner);
  }
}
