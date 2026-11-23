// コントロール一覧の書き出し（仕様書 §18.3）。リボンに置いたコントロールを表にして、CSV ファイルかクリップボード（TSV）に出す。
// 配る前のレビューや、利用者向けの説明書・社内の申請書に貼る用途を想定する。DOM の文書だけから決まる純粋な処理にしておく。

import { t } from './i18n';
import { defFor, attributes, titleOf } from './schema';

export interface ControlRow {
  tab: string;
  group: string;
  kind: string;
  label: string;
  id: string;
  macro: string;
  screentip: string;
  keytip: string;
  image: string;
}

/** 列の並び。見出しは日本語（英語 UI では英語）。 */
export const CONTROL_COLUMNS: readonly (keyof ControlRow)[] = ['tab', 'group', 'kind', 'label', 'id', 'macro', 'screentip', 'keytip', 'image'];

export function controlHeaders(): string[] {
  return [t('タブ'), t('グループ'), t('種類'), t('ラベル'), 'id', t('マクロ'), t('ヒント'), t('キーヒント'), t('画像')];
}

/** 表に出さない入れ物（中のコントロールは出す）。dropDown などの item は選択肢なので行にしない。 */
const CONTAINERS: ReadonlySet<string> = new Set(['box', 'buttonGroup', 'separator', 'menuSeparator', 'dialogBoxLauncher', 'item', 'groupBox', 'layoutContainer']);

/** VBA で決める値の表記。 */
const vbaValue = (name: string) => t('（VBA：{name}）', { name });

/** 固定の値（label）か、VBA で決める値（getLabel）かを見て、表に出す文字にする。 */
function staticOrDynamic(el: Element, attr: string, dynamicAttr: string): string {
  const v = el.getAttribute(attr);
  if (v !== null) return v;
  const d = el.getAttribute(dynamicAttr);
  return d !== null ? vbaValue(d) : '';
}

function identifier(el: Element): string {
  return el.getAttribute('id') ?? el.getAttribute('idQ') ?? el.getAttribute('idMso') ?? '';
}

function imageOf(el: Element): string {
  const image = el.getAttribute('image');
  if (image) return image;
  const mso = el.getAttribute('imageMso');
  if (mso) return `imageMso:${mso}`;
  const get = el.getAttribute('getImage');
  return get ? vbaValue(get) : '';
}

/** 動的な表示の属性（getLabel など）を除いた、マクロ（onAction・onChange・getContent など）の一覧。 */
function macrosOf(el: Element): string {
  const DISPLAY = new Set(['getLabel', 'getScreentip', 'getSupertip', 'getKeytip', 'getImage', 'getDescription']);
  return Array.from(el.attributes)
    .filter((a) => attributes.get(a.name)?.kind === 'callback' && !DISPLAY.has(a.name) && a.value)
    .map((a) => (a.name === 'onAction' ? a.value : `${a.value} (${a.name})`))
    .join(', ');
}

/** 要素が置かれているタブ（右クリックメニュー・Backstage ならその名前）とグループ。 */
function placeOf(el: Element): { tab: string; group: string } {
  let tab = '';
  let group = '';
  for (let p = el.parentElement; p; p = p.parentElement) {
    const name = p.getAttribute('label') ?? identifier(p);
    if (p.localName === 'group' && !group) group = name;
    else if (p.localName === 'tab' && !tab) tab = name;
    else if (p.localName === 'contextMenu' && !tab) tab = t('右クリック：{name}', { name: identifier(p) });
    else if (p.localName === 'qat' && !tab) tab = t('クイックアクセス');
    else if (p.localName === 'backstage' && !tab) tab = 'Backstage';
  }
  return { tab, group };
}

/** 文書の中のコントロールを、文書の順に表の行にする。 */
export function controlRows(doc: Document): ControlRow[] {
  const rows: ControlRow[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      const def = defFor(c);
      if (def?.isControl && !CONTAINERS.has(c.localName)) {
        const { tab, group } = placeOf(c);
        rows.push({
          tab,
          group,
          kind: titleOf(c.localName),
          label: staticOrDynamic(c, 'label', 'getLabel'),
          id: identifier(c),
          macro: macrosOf(c),
          screentip: staticOrDynamic(c, 'screentip', 'getScreentip'),
          keytip: staticOrDynamic(c, 'keytip', 'getKeytip'),
          image: imageOf(c),
        });
      }
      walk(c);
    }
  };
  if (doc.documentElement) walk(doc.documentElement);
  return rows;
}

/** CSV の 1 つの値（RFC 4180）。, " 改行 と前後の空白を含むものは "" で囲み、" は "" にする。 */
export function csvCell(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * CSV にする。Excel でダブルクリックして開いたときに文字化けしないよう、先頭に BOM を付ける
 * （BOM がないと、日本語版の Excel は Shift_JIS として読む）。改行は CRLF（Excel と Windows の既定）。
 */
export function toCsv(rows: readonly ControlRow[], headers: readonly string[] = controlHeaders()): string {
  const lines = [headers, ...rows.map((r) => CONTROL_COLUMNS.map((c) => r[c]))].map((cells) => cells.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * TSV にする（クリップボードから Excel のセルに貼り付ける用）。値の中のタブと改行は空白にする
 * （Excel の貼り付けは " で囲んだ改行を正しく扱わないことがあり、表が崩れるため）。
 */
export function toTsv(rows: readonly ControlRow[], headers: readonly string[] = controlHeaders()): string {
  const clean = (v: string) => v.replace(/[\t\r\n]+/g, ' ');
  return [headers, ...rows.map((r) => CONTROL_COLUMNS.map((c) => r[c]))].map((cells) => cells.map(clean).join('\t')).join('\r\n') + '\r\n';
}
