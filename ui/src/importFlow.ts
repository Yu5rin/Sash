// 別のブックのリボンを取り込む・見比べる・customUI の XML を書き出す（仕様書 §23.3）の、ダイアログの手前までの流れ。
// ホストの file.read で別のブック（.xlsm など）・customUI の .xml・.sash.json を、開かずに読む。

import { app } from './app';
import { invoke, type CustomUIVersion, type ReadDocument } from './bridge';
import { openDiffViews, type DiffView } from './dialogs/diffDialog';
import { openImportDialog } from './dialogs/importDialog';
import { t } from './i18n';
import { parseXml, serialize } from './model';
import { parseSash, partXml } from './sashJson';
import { splitPath } from './shell/text';
import { toast } from './shell/toast';

export interface SourceImage {
  id: string;
  contentType: string;
  base64: string;
}

/** 取り込み・比較の元になる、別のリボン（ブック・XML・.sash.json のどれから読んでも同じ形にする）。 */
export interface SourceBook {
  /** 表示名（ファイル名）。 */
  name: string;
  path: string;
  kind: ReadDocument['kind'];
  parts: { version: CustomUIVersion; xml: string; images: SourceImage[] }[];
}

/** file.read の応答を、取り込み・比較の元にする。.sash.json はここで解析する（形式が違えば理由つきで例外）。 */
export function sourceFromRead(doc: ReadDocument): SourceBook {
  const name = splitPath(doc.path).name;
  if (doc.kind === 'sashJson') {
    const data = parseSash(doc.json ?? '');
    return { name, path: doc.path, kind: doc.kind, parts: data.parts.map((p) => ({ version: p.version, xml: partXml(p), images: p.images.map((i) => ({ id: i.id, contentType: i.contentType, base64: i.base64 })) })) };
  }
  return { name, path: doc.path, kind: doc.kind, parts: doc.parts.map((p) => ({ version: p.version, xml: p.xml, images: p.images.map((i) => ({ id: i.id, contentType: i.contentType, base64: i.base64 })) })) };
}

/** 別のリボンを選んで読む。選ばなかったら null。リボン定義がなければ知らせて null。 */
export async function readSourceBook(): Promise<SourceBook | null> {
  try {
    const doc = await invoke('file.read');
    if (!doc) return null;
    const book = sourceFromRead(doc);
    if (book.parts.length === 0) {
      toast({ kind: 'warning', message: t('「{file}」には、リボン定義（customUI）がありません', { file: book.name }) });
      return null;
    }
    return book;
  } catch (e) {
    toast({ kind: 'error', message: t('読み込めませんでした：{message}', { message: (e as Error).message }) });
    return null;
  }
}

/** ファイル メニューの［別のブックから取り込む…］。 */
export async function importFromOtherBook(): Promise<void> {
  if (!app.store) return;
  const book = await readSourceBook();
  if (book && app.store) openImportDialog(book);
}

/** XML を Sash の整形（字下げ）にそろえる。読めなければそのまま。別のツールで書いた XML と比べても、書き方の差で全行が違って見えないように。 */
export function formatXmlText(text: string): string {
  const parsed = parseXml(text);
  return parsed.ok ? serialize(parsed.doc) : text;
}

/** 画像を「中身」で比べて、片方にだけあるものの id を返す（id の付け方は違っても、同じ画像なら同じとみなす）。 */
function imageDiff(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): { added: string[]; removed: string[] } {
  const leftContents = new Set(left.values());
  const rightContents = new Set(right.values());
  return {
    added: [...right].filter(([, v]) => !leftContents.has(v)).map(([id]) => id),
    removed: [...left].filter(([, v]) => !rightContents.has(v)).map(([id]) => id),
  };
}

/** 別のリボン（左）と、いま編集中のリボン（右）を、パーツごとに比べる組にする。 */
export function buildCompareViews(book: SourceBook, current: { version: CustomUIVersion; text: string; images: ReadonlyMap<string, string> }[]): DiffView[] {
  const versions = [...new Set([...book.parts.map((p) => p.version), ...current.map((c) => c.version)])];
  return versions.map((version) => {
    const other = book.parts.find((p) => p.version === version);
    const mine = current.find((c) => c.version === version);
    const otherImages = new Map((other?.images ?? []).map((i) => [i.id, `data:${i.contentType};base64,${i.base64}`]));
    const { added, removed } = imageDiff(otherImages, mine?.images ?? new Map());
    return {
      version,
      left: other ? formatXmlText(other.xml) : '',
      right: mine ? formatXmlText(mine.text) : '',
      addedImages: added,
      removedImages: removed,
    };
  });
}

/** ツール メニューの［別のブックと比べる…］。左が選んだブック、右がいま編集中の内容。 */
export async function compareWithOtherBook(): Promise<void> {
  const s = app.session;
  if (!s) return;
  const book = await readSourceBook();
  if (!book || app.session !== s) return;
  const current = [...s.parts.values()].map((p) => ({ version: p.version, text: p.text, images: new Map([...p.images.values()].map((i): [string, string] => [i.id, i.dataUrl])) }));
  openDiffViews({
    title: t('別のブックとの差分（{file}）', { file: book.name }),
    key: 'compareBook',
    legend: t('赤：{file} にあって、いまの編集にない行　緑：いまの編集にあって、{file} にない行', { file: book.name }),
    sameText: t('{file} と同じです', { file: book.name }),
    imageLabels: { added: t('いまの編集にだけある画像：{list}'), removed: t('{file} にだけある画像：{list}').replace('{file}', book.name) },
    views: buildCompareViews(book, current),
  });
}

/** ファイル メニューの［customUI の XML を書き出す…］。いま編集している 1 パーツを .xml で書き出す（他ツール・Git・質問サイトへ貼る用）。画像は含まない。 */
export async function exportCustomUiXml(): Promise<void> {
  const s = app.session;
  const store = app.store;
  if (!s || !store) return;
  const base = (s.path ? splitPath(s.path).name : 'ribbon').replace(/\.[^.]+$/, '');
  const part = store.version === 'office2010' ? 'customUI14' : 'customUI';
  try {
    const saved = await invoke('file.exportText', { defaultName: `${base}_${part}.xml`, filter: `${t('customUI の XML (*.xml)')}|*.xml`, content: store.text });
    if (saved) toast({ kind: 'success', message: t('{part} の XML を書き出しました（画像は含まれません）：{path}', { part, path: saved }) });
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
}
