// 検証（Lint）。スキーマ定義に基づく構造チェックと、仕様書 §5.6 の独自ルールを行う。

import { allElements, pathOf, type Path } from './model';
import { attributes, defFor, inBackstage, isVbaIdentifier, isXmlId, NAMESPACES, slotIndex, type ElementDef } from './schema';
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

// 名前空間の定義は model.ts からも使うので schema.ts に置き、ここからも従来どおり取り出せるようにする
export { NAMESPACES };

/** グループ内のコントロールがこれを超えると、狭い画面で畳まれやすい。 */
const MANY_CONTROLS = 12;

/**
 * 大きいボタン（size="large"）のラベルの幅の目安。全角を 2、半角を 1 と数え、これを超えたら警告する（全角 8 文字 / 半角 16 文字）。
 * 大きいボタンのラベルは2行までで、2行目の後ろにはメニューの印（▼）が入ることもあるため、長いと切れて「…」になる。
 * ※この値は見た目からの目安で、実機の Excel（表示倍率・フォント・ボタンの種類ごとの違い）ではまだ確かめていない。
 */
export const LARGE_LABEL_MAX_WIDTH = 16;

/**
 * 小さいボタンのラベルの文字数の目安。これを超えると、グループの幅が広がって狭い画面で畳まれやすくなる。
 * ※大きいボタンと同じく見た目からの目安で、実機の Excel ではまだ確かめていない。
 */
export const SMALL_LABEL_MAX_CHARS = 20;

/** ラベルの長さを調べるコントロール（グループに直接置くボタンの類）。 */
const LABELED_CONTROLS: ReadonlySet<string> = new Set(['button', 'toggleButton', 'menu', 'gallery', 'dynamicMenu', 'checkBox']);

/** 表示幅（全角を 2、半角を 1）。半角カナ（U+FF61〜FF9F）は 1 と数える。 */
export function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    w += c <= 0x7e || (c >= 0xff61 && c <= 0xff9f) ? 1 : 2;
  }
  return w;
}

/** 分割ボタンが中のボタンから受け継ぐ属性（XSD の CT_SplitButtonRestricted で prohibited）。 */
const SPLIT_INHERITED: ReadonlySet<string> = new Set(['label', 'getLabel', 'screentip', 'getScreentip', 'supertip', 'getSupertip', 'image', 'imageMso', 'getImage', 'showImage', 'getShowImage']);

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
  // loadImage があると、image の値は VBA に渡す任意の文字列になる（ファイル内の画像とは限らない）
  const imageIsFreeText = root.hasAttribute('loadImage');

  const visit = (el: Element, opaque: boolean) => {
    const def = defFor(el);
    if (opaque) return;
    // 接頭辞つき（<mso:tab>）でも名前空間が同じなら正しい。違う名前空間の要素は Office が無視するか、読み込みに失敗する
    if (el !== root && el.namespaceURI !== root.namespaceURI) {
      add('error', el, t('<{tag}> の名前空間が customUI と違います（xmlns="{ns}"）', { tag: el.localName, ns: el.namespaceURI ?? '' }));
      return;
    }
    if (!def) {
      add('error', el, t('不明な要素 <{tag}> です', { tag: el.localName }));
      return;
    }
    if (def.since2010 && ctx.version === 'office2007') add('error', el, t('<{tag}> は2010以降の形式でのみ使えます', { tag: el.localName }));
    if (def.only2007 && ctx.version === 'office2010') add('error', el, t('<{tag}> は2007形式（customUI）でのみ使えます', { tag: el.localName }));
    lintChildOrder(el, def, add);

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
        // 分割ボタンのラベル・ヒント・アイコンは、中のボタンが持つ（スキーマでは分割ボタンに付けられない）。直し方を添える
        const hint = el.localName === 'splitButton' && SPLIT_INHERITED.has(name) ? ` ${t('分割ボタンのラベル・ヒント・アイコンは、中の button / toggleButton に付けます')}` : '';
        // Backstage の項目（dropDown・comboBox の item と radioButton）は image を持てない（以前の版は許していたので、古いファイルで出る）
        const bsHint = inBackstage(el) && (el.localName === 'item' || el.localName === 'radioButton') && (name === 'image' || name === 'imageMso')
          ? ` ${t('Backstage の項目はアイコンを持てません。XML エディタで image / imageMso を消してください')}`
          : '';
        add('error', el, `${t('<{tag}> に {attr} 属性は使えません', { tag: el.localName, attr: name })}${hint}${bsHint}`, name);
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
          // maxLength は 1〜1024（XSD の ST_StringLength）
          else if (name === 'maxLength' && (Number(v) < 1 || Number(v) > 1024)) add('error', el, t('{attr} は {min}〜{max} の整数で指定してください', { attr: name, min: 1, max: 1024 }), name);
          break;
        case 'id':
          if (!isXmlId(v)) add('error', el, t('id「{value}」は文字かアンダースコアで始め、文字・数字と _ . - だけを使ってください', { value: v }), name);
          break;
        case 'callback':
          if (!isCallbackValue(v)) add('error', el, t('コールバック名「{value}」は VBA の Sub 名として使えません', { value: v }), name);
          break;
        case 'idMso':
          if (ctx.knownIdMso.size > 0 && v && !ctx.knownIdMso.has(v)) add('warning', el, t('idMso「{value}」は Excel のコマンド一覧にありません', { value: v }), name);
          break;
        case 'imageMso':
          if (ctx.missingImageMso.has(v)) add('warning', el, t('imageMso「{value}」は Excel に存在しません', { value: v }), name);
          break;
        case 'image':
          if (!imageIsFreeText && !ctx.imageIds.has(v)) add('error', el, t('画像「{value}」がファイル内にありません', { value: v }), name);
          break;
        case 'string':
          // keytip は 1〜3 文字（XSD の ST_Keytip）。4文字以上だと読み込みに失敗する
          if (name === 'keytip' && [...v].length > 3) add('error', el, t('keytip は3文字以内で指定してください'), name);
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

    lintLabelLength(el, add);

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

/**
 * ラベルの長さ。リボンのグループの中のボタンだけを見る（メニューの中の項目は横に伸びるだけで切れないため）。
 * splitButton の中のボタンは、splitButton の size に従う。
 */
function lintLabelLength(el: Element, add: (s: Severity, el: Element, m: string, attr?: string) => void): void {
  const label = el.getAttribute('label');
  if (!label || !LABELED_CONTROLS.has(el.localName)) return;
  const parent = el.parentElement;
  const holder = parent?.localName === 'splitButton' ? parent : el;
  const container = holder.parentElement?.localName;
  // グループ・box・buttonGroup に直接置いたものだけ（menu・Backstage の中は対象外）
  if (container !== 'group' && container !== 'box' && container !== 'buttonGroup') return;
  // ラベルを出さないもの（showLabel="false"）と、出すかを VBA で決めるもの（getShowLabel）は、長さで幅も行も変わらないので見ない
  if ([el, holder].some((x) => x.getAttribute('showLabel') === 'false' || x.getAttribute('showLabel') === '0' || x.hasAttribute('getShowLabel'))) return;
  const large = holder.getAttribute('size') === 'large';
  if (large) {
    if (labelWidth(label) > LARGE_LABEL_MAX_WIDTH) add('warning', el, t('大きいボタンのラベルが長いため、Excel では2行目で切れる可能性があります'), 'label');
  } else if ([...label].length > SMALL_LABEL_MAX_CHARS) {
    add('warning', el, t('ラベルが {n} 文字あります。小さいボタンでは横に伸びてグループの幅が広がり、狭い画面で畳まれやすくなります', { n: [...label].length }), 'label');
  }
}

/** 子要素の並び順と個数（XSD の sequence と maxOccurs / minOccurs）。 */
function lintChildOrder(el: Element, def: ElementDef, add: (s: Severity, el: Element, m: string, attr?: string) => void): void {
  const slots = def.childOrder;
  if (!slots) return;
  const counts = slots.map(() => 0);
  let maxSlot = -1;
  let maxSlotEl: Element | null = null;
  for (const c of Array.from(el.children)) {
    const i = slotIndex(def, c.localName);
    if (i < 0) continue;
    counts[i]!++;
    const max = slots[i]!.max;
    if (max !== undefined && counts[i] === max + 1) {
      add('error', c, t('<{parent}> の中に置ける <{child}> は {n} 個までです', { parent: el.localName, child: slots[i]!.tags.join(' / '), n: max }));
    }
    if (i < maxSlot && maxSlotEl) {
      add('error', c, t('<{child}> は <{other}> より前に置いてください', { child: c.localName, other: maxSlotEl.localName }));
    } else if (i > maxSlot) {
      maxSlot = i;
      maxSlotEl = c;
    }
  }
  slots.forEach((slot, i) => {
    if ((slot.min ?? 0) > counts[i]!) add('error', el, t('<{parent}> には <{child}> が必要です', { parent: el.localName, child: slot.tags.join(' / ') }));
  });
}

/** コールバック名として使えるか。"Module1.Name" や "Book.xlsm!Name" は、最後の名前が VBA の識別子ならよい。 */
function isCallbackValue(v: string): boolean {
  const m = /^(.*[.!])?([^.!]*)$/.exec(v);
  if (!m || !isVbaIdentifier(m[2]!)) return false;
  // 修飾部分（モジュール名・ブック名）は空白を含むブック名もあるので、空でないことと引用符がないことだけを見る
  return m[1] === undefined || (m[1].length > 1 && !/["\r\n]/.test(m[1]));
}

/**
 * keytip の重複。Alt キーを押したときに同時に出るもの同士だけで調べる。
 * リボンのタブ同士、タブごとの中身、メニューごとの中身、Backstage のタブ同士と、Backstage のタブごとの中身を、それぞれ別に扱う。
 */
const KEYTIP_SCOPES = new Set(['tab', 'menu', 'contextMenu', 'qat', 'backstage', 'officeMenu', 'dynamicMenu']);

function keytipScope(el: Element): Element | null {
  // タブ自身は、タブの一覧（リボンなら ribbon、Backstage なら backstage）の中で重ならなければよい
  if (el.localName === 'tab') {
    for (let cur = el.parentElement; cur; cur = cur.parentElement) if (cur.localName === 'ribbon' || cur.localName === 'backstage') return cur;
    return null;
  }
  for (let cur = el.parentElement; cur; cur = cur.parentElement) if (KEYTIP_SCOPES.has(cur.localName)) return cur;
  return null;
}

function lintKeytips(doc: Document, add: (s: Severity, el: Element, m: string, attr?: string) => void): void {
  const scopes = new Map<Element | null, Map<string, Element[]>>();
  for (const el of allElements(doc)) {
    const k = el.getAttribute('keytip')?.toUpperCase();
    if (!k) continue;
    const scope = keytipScope(el);
    let seen = scopes.get(scope);
    if (!seen) scopes.set(scope, (seen = new Map()));
    seen.set(k, [...(seen.get(k) ?? []), el]);
  }
  for (const seen of scopes.values()) {
    for (const [k, list] of seen) {
      if (list.length > 1) for (const el of list) add('warning', el, t('keytip「{value}」が重複しています', { value: k }), 'keytip');
    }
  }
}
