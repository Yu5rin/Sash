// 編集中の customUI パーツ 1 つ分の状態。キャンバス・ツリー・XML のどこから変更しても、
// ここを通して一つの Undo / Redo 履歴に記録する（仕様書 §5）。

import { allElements, comparePaths, elementAt, isAncestorPath, parseXml, pathOf, samePath, serialize, type Path } from './model';
import type { CustomUIVersion } from './bridge';
import { NAMESPACES } from './schema';
import { t } from './i18n';

export interface ImageEntry {
  id: string;
  /** 表示用の data URL。 */
  dataUrl: string;
  /**
   * ファイルにまだ書き込んでいない画像か（表示用の目印）。
   * ストアが「最後に保存した画像」との差分から付け直すので、何を書き込むかの判断には使わない（pendingImageChanges を使う）。
   */
  isNew: boolean;
  /** アイコンエディタで作ったときの元画像と加工設定。あれば同じ設定からやり直せる（このセッションの間だけ）。 */
  edit?: { source: Blob; sourceName: string; options: unknown };
}

interface Snapshot {
  text: string;
  selection: Path | null;
  /** 複数選択（仕様書 §19）。元に戻すと、選んでいた組も戻す。 */
  selections: Path[];
  images: Map<string, ImageEntry>;
  /** この状態から次の状態へ進めた操作の説明（元に戻す・やり直しのツールチップに出す）。 */
  label: string;
}

/**
 * 保存した（または保存しようとしている）時点の内容。保存の前に saveSnapshot() で取り、
 * 書き込みが終わったら markSaved(snapshot) に渡す。保存中に行った編集は未保存のまま残る。
 */
export interface SaveSnapshot {
  readonly text: string;
  /** 画像の Id → 中身（data URL）。 */
  readonly images: ReadonlyMap<string, string>;
}

export type ChangeKind = 'doc' | 'selection' | 'images' | 'saved';

/** 変更の発生元。発生元のビューは自分を描き直さない（XML エディタのカーソルを飛ばさないため）。 */
export type Source = 'canvas' | 'tree' | 'xml' | 'inspector' | 'history' | 'other';

export interface Change {
  kinds: ReadonlySet<ChangeKind>;
  source: Source;
}

/** edit の fn がこれを返すと、編集を取り消す（履歴にも残さない）。 */
export const ABORT: unique symbol = Symbol('sash.abort');

/**
 * edit の fn が、編集のあとに選ぶ要素を複数返すときの入れ物（まとめて複製・貼り付けなど。仕様書 §19）。
 * Path の配列をそのまま返せるようにすると、空の配列が「customUI（ルート）を選ぶ」と区別できないため、包んで返す。
 */
export class SelectionSet {
  constructor(readonly paths: readonly Path[], readonly primary: Path | null = paths.at(-1) ?? null) {}
}

/** 編集のあとに paths をまとめて選ぶ（primary を省くと最後のものを主な選択にする）。 */
export function selectMany(paths: readonly Path[], primary?: Path | null): SelectionSet {
  return new SelectionSet(paths, primary === undefined ? paths.at(-1) ?? null : primary);
}

export type EditResult = Path | SelectionSet | null | void | typeof ABORT;

type EditFn = (doc: Document) => EditResult;

/** 同じパスを取り除き、文書の順に並べる。 */
function uniqueSorted(paths: readonly Path[]): Path[] {
  const out: Path[] = [];
  for (const p of [...paths].sort(comparePaths)) if (!out.some((q) => samePath(p, q))) out.push(p);
  return out;
}

/**
 * 選択の組を整える。祖先と子孫を一緒に選ばない（祖先を残し、子孫を外す）。
 * ただし主な選択（primary）が子孫のときは、primary を残して祖先を外す（いま選んだものを優先するため）。
 * 祖先ごと消す・移すと子孫も一緒に動くので、両方を選ぶと同じ要素を二重に扱ってしまうため。
 */
export function normalizeSelections(paths: readonly Path[], primary: Path | null): Path[] {
  let list = uniqueSorted(primary ? [...paths, primary] : paths);
  if (primary) list = list.filter((p) => !isAncestorPath(p, primary));
  return list.filter((p) => !list.some((q) => isAncestorPath(q, p)));
}

/** 範囲の中で、ほかの要素の祖先になっているものを外す（範囲選択では、葉の側を選んだとみなす）。 */
function dropAncestorsOfOthers(paths: readonly Path[]): Path[] {
  return paths.filter((p) => p.length > 0 && !paths.some((q) => isAncestorPath(p, q)));
}

let refusedHandler: ((message: string) => void) | null = null;

/** 編集を断ったときの知らせ方（画面ではトースト）を登録する。 */
export function setEditRefusedHandler(fn: (message: string) => void): void {
  refusedHandler = fn;
}

/** 編集できなかった理由を利用者に知らせる（登録された知らせ方がなければ何もしない）。 */
export function reportRefusal(message: string): void {
  refusedHandler?.(message);
}

const TEXT_COALESCE_MS = 800;
const HISTORY_LIMIT = 200;

/** 画像の一覧を「Id → 中身」にする（保存済みかどうかの比較に使う）。 */
function contentMap(images: ReadonlyMap<string, ImageEntry>): Map<string, string> {
  return new Map([...images.values()].map((i) => [i.id, i.dataUrl]));
}

export class PartStore {
  readonly version: CustomUIVersion;
  doc: Document;
  /** XML エディタの中身。構文エラーの間は doc と一致しない。 */
  text: string;
  syncError: { message: string; line?: number } | null = null;
  /** 主な選択（フォーカスのある要素）。インスペクタ・XML の強調・挿入の位置はこれで決める。 */
  selection: Path | null = null;
  /**
   * 選んでいる要素の全部（文書の順、主な選択を含む。仕様書 §19）。主な選択がなければ空。
   * 祖先と子孫を一緒には含まない（normalizeSelections）。
   */
  selections: Path[] = [];
  /** Shift+クリックの範囲の起点。最後に単独で選んだか、Ctrl+クリックで足した要素。 */
  private anchor: Path | null = null;
  images: Map<string, ImageEntry>;

  /** 最後に保存した（または読み込んだ）ときの内容。新規に作ったパーツは null（何を書いても未保存）。 */
  private saved: SaveSnapshot | null;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private lastTextEditAt = 0;
  private readonly listeners = new Set<(c: Change) => void>();

  /**
   * images は、いまファイルに入っている画像として扱う。
   * options.unsaved を付けると、読み込んだ内容そのものを未保存として扱う（customUI を新しく作ったとき）。
   */
  constructor(version: CustomUIVersion, xml: string, images: ImageEntry[], options: { unsaved?: boolean } = {}) {
    this.version = version;
    this.text = xml;
    const parsed = parseXml(xml);
    if (parsed.ok) {
      this.doc = parsed.doc;
    } else {
      // 読み込んだ XML が壊れていても編集を始められるよう、空の文書を正しかった状態として持つ
      this.doc = new DOMParser().parseFromString(`<customUI xmlns="${NAMESPACES[version]}" />`, 'application/xml');
      this.syncError = { message: parsed.message, line: parsed.line };
    }
    this.images = new Map(images.map((i) => [i.id, i]));
    this.saved = options.unsaved ? null : { text: xml, images: contentMap(this.images) };
    this.refreshIsNew();
  }

  subscribe(listener: (c: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kinds: ChangeKind[], source: Source): void {
    const change = { kinds: new Set(kinds), source };
    for (const l of this.listeners) l(change);
  }

  /** 最後に保存した（または読み込んだ）ときの XML。差分表示に使う。 */
  get savedXml(): string {
    return this.saved?.text ?? '';
  }

  // ---- 保存の管理 ----

  /**
   * 保存のときに書き込む画像の変更。最後に保存した画像の一覧と、今の一覧との差分から求める。
   * add は新しく足した画像と、同じ Id で中身が変わった画像（ホストは同じ Id を上書きする）。
   * remove は保存済みの画像のうち、今の一覧にないもの。
   * 元に戻す・やり直し・.sash.json の読み込みを経ても、差分から求めるので食い違わない。
   */
  pendingImageChanges(): { add: ImageEntry[]; remove: string[] } {
    const disk = this.saved?.images ?? new Map<string, string>();
    const add = [...this.images.values()].filter((i) => disk.get(i.id) !== i.dataUrl);
    const remove = [...disk.keys()].filter((id) => !this.images.has(id));
    return { add, remove };
  }

  /** 最後に保存したときから、追加（または中身の差し替え）・削除された画像の Id。 */
  imageChanges(): { added: string[]; removed: string[] } {
    const { add, remove } = this.pendingImageChanges();
    return { added: add.map((i) => i.id), removed: remove };
  }

  /** 保存のときに消す画像（互換のため残している。pendingImageChanges().remove と同じ）。 */
  get removedImages(): ReadonlySet<string> {
    return new Set(this.pendingImageChanges().remove);
  }

  /** 今の内容を、保存する内容として控える。書き込みが終わったら markSaved に渡す。 */
  saveSnapshot(): SaveSnapshot {
    return { text: this.text, images: contentMap(this.images) };
  }

  /**
   * 保存が終わったら呼ぶ。snapshot を渡すと、その時点の内容を保存済みとして記録する
   * （保存の待ち時間に行った編集は未保存のまま残る）。省略すると今の内容を保存済みにする。
   */
  markSaved(snapshot?: SaveSnapshot): void {
    this.saved = snapshot ?? this.saveSnapshot();
    this.refreshIsNew();
    this.emit(['saved'], 'other');
  }

  get dirty(): boolean {
    if (!this.saved || this.text !== this.saved.text) return true;
    const { add, remove } = this.pendingImageChanges();
    return add.length > 0 || remove.length > 0;
  }

  /** 表示用の isNew を、保存済みの画像との差分に合わせて付け直す（中身は変えずに、違うものだけ作り直す）。 */
  private refreshIsNew(): void {
    const disk = this.saved?.images;
    for (const [id, img] of this.images) {
      const isNew = disk?.get(id) !== img.dataUrl;
      if (img.isNew !== isNew) this.images.set(id, { ...img, isNew });
    }
  }

  get selectedElement(): Element | null {
    return this.selection ? elementAt(this.doc, this.selection) : null;
  }

  /** 選んでいる要素（文書の順）。 */
  get selectedElements(): Element[] {
    return this.selections.map((p) => elementAt(this.doc, p)).filter((e): e is Element => e !== null);
  }

  /** 2つ以上を選んでいるか。 */
  get isMulti(): boolean {
    return this.selections.length > 1;
  }

  /** path を選んでいるか（主な選択か、そのほかの選択か）。 */
  isSelected(path: Path): boolean {
    return this.selections.some((p) => samePath(p, path));
  }

  /** 主な選択と選択の組を置き換える（組は整えてから入れる）。 */
  private setSelection(primary: Path | null, list: readonly Path[]): void {
    this.selection = primary;
    this.selections = primary ? normalizeSelections(list, primary) : [];
  }

  /** 今の文書で指せないパスを外す（XML の書き換え・元に戻すのあと）。主な選択が消えたら、残りの最後を主にする。 */
  private dropInvalidSelections(): void {
    const valid = this.selections.filter((p) => elementAt(this.doc, p) !== null);
    const primary = this.selection && elementAt(this.doc, this.selection) ? this.selection : valid.at(-1) ?? null;
    this.setSelection(primary, valid);
    if (this.anchor && !elementAt(this.doc, this.anchor)) this.anchor = this.selection;
  }

  // ---- 履歴 ----

  private snapshot(label: string): Snapshot {
    return { text: this.text, selection: this.selection, selections: [...this.selections], images: new Map(this.images), label };
  }

  private pushHistory(label: string): void {
    this.undoStack.push(this.snapshot(label));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** 元に戻すと取り消される操作の説明。 */
  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  /** やり直すと再び行われる操作の説明。 */
  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /** XML と画像をまとめて置き換える（.sash.json の読み込み）。一つの履歴にする。 */
  replaceAll(xml: string, images: ImageEntry[], label = t('リボン定義の読み込み')): void {
    this.pushHistory(label);
    this.lastTextEditAt = 0;
    this.images = new Map(images.map((i) => [i.id, i]));
    this.refreshIsNew();
    this.text = xml;
    const parsed = parseXml(xml);
    if (parsed.ok) {
      this.doc = parsed.doc;
      this.syncError = null;
    } else {
      this.syncError = { message: parsed.message, line: parsed.line };
    }
    this.setSelection(null, []);
    this.anchor = null;
    this.emit(['doc', 'selection', 'images'], 'other');
  }

  /**
   * DOM を直接変更する編集。fn が返したパスを新しい選択にする（undefined なら選択はそのまま）。
   * 次のときは何もしなかったことにして false を返す（履歴に残さず、通知もせず、文書を編集前に戻す）。
   * - fn が ABORT を返したとき
   * - 書き出した XML と選択が編集前と変わらないとき（整形だけの差で履歴を増やさない）
   * - fn が例外を投げたとき（戻したうえで例外を投げ直す）
   * XML エディタに構文エラーがある間は、書きかけの XML を捨ててしまわないよう、編集を断る。
   */
  edit(source: Source, fn: EditFn, label: string = t('編集')): boolean {
    return this.transact(source, fn, label, null);
  }

  /** 画像の追加と、その画像のコントロールへの設定を、一つの履歴にまとめて行う。edit と同じ規則で断る・取り消す。 */
  addImageAndApply(entry: ImageEntry, fn: EditFn, label: string = t('画像「{id}」の設定', { id: entry.id })): boolean {
    return this.transact('other', fn, label, entry);
  }

  private transact(source: Source, fn: EditFn, label: string, image: ImageEntry | null): boolean {
    if (this.syncError) {
      reportRefusal(t('XML に構文エラーがあるため、この操作はできません。先に XML エディタでエラーを直してください'));
      return false;
    }
    const before = this.snapshot(label);
    const beforeXml = serialize(this.doc);
    // 選んでいた要素を、パスではなく要素そのもので覚えておく。編集で前に挿入・削除・移動があっても、
    // 編集のあとに同じ要素を選び直せる（パスのままだと、別の要素を指してしまうため）
    const tracked = this.selections.map((p) => elementAt(this.doc, p));
    const trackedPrimary = this.selection ? elementAt(this.doc, this.selection) : null;
    const rollback = () => {
      this.images = before.images;
      this.selection = before.selection;
      this.selections = before.selections;
      // 文書が書き換わっていれば、編集前の XML から作り直す（変わっていなければ、ビューが持つ要素をそのまま使えるよう残す）
      if (serialize(this.doc) !== beforeXml) {
        const parsed = parseXml(before.text);
        if (parsed.ok) this.doc = parsed.doc;
      }
    };
    if (image) {
      this.images = new Map(this.images);
      this.images.set(image.id, image);
    }
    let result: ReturnType<EditFn>;
    try {
      result = fn(this.doc);
    } catch (e) {
      rollback();
      throw e;
    }
    if (result === ABORT) {
      rollback();
      return false;
    }
    const root = this.doc.documentElement;
    const alive = (e: Element | null): e is Element => e !== null && (e === root || root.contains(e));
    let selection: Path | null;
    let selections: Path[];
    if (result instanceof SelectionSet) {
      selection = result.primary;
      selections = [...result.paths];
    } else if (result !== undefined) {
      selection = result;
      selections = result ? [result] : [];
    } else {
      // 選択は変えない編集。選んでいた要素を、編集のあとの位置で選び直す（消えた要素は外す）
      // 主な選択の要素が消えたときは、これまでどおりパスのまま残す（要素を作り直す編集で選択を保つため）
      selection = alive(trackedPrimary) ? pathOf(trackedPrimary) : this.selection;
      selections = tracked.filter(alive).map((e) => pathOf(e));
    }
    // 編集のあとで指せなくなったパスは外す（selections に無効なパスを残すと、まとめての操作が空振りしたり、
    // 数の表示がずれたりするため）。主な選択が指せなければ、残りの最後を主にする（dropInvalidSelections と同じ決まり）
    selections = selections.filter((p) => elementAt(this.doc, p) !== null);
    if (selection && !elementAt(this.doc, selection)) selection = selections.at(-1) ?? null;
    selections = selection ? normalizeSelections(selections, selection) : [];
    const xml = serialize(this.doc);
    const sameSelections = selections.length === before.selections.length && selections.every((p, i) => samePath(p, before.selections[i]!));
    if (!image && xml === beforeXml && samePath(selection, before.selection) && sameSelections) {
      rollback();
      return false;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.lastTextEditAt = 0;
    this.selection = selection;
    this.selections = selections;
    this.anchor = selection;
    this.text = xml;
    if (image) this.refreshIsNew();
    this.emit(image ? ['doc', 'selection', 'images'] : ['doc', 'selection'], source);
    return true;
  }

  /** XML エディタでの変更。短い間隔の入力は一つの履歴にまとめる。 */
  setText(text: string): void {
    if (text === this.text) return;
    const now = Date.now();
    if (now - this.lastTextEditAt > TEXT_COALESCE_MS) this.pushHistory(t('XML の編集'));
    this.lastTextEditAt = now;
    this.text = text;
    const parsed = parseXml(text);
    if (parsed.ok) {
      this.doc = parsed.doc;
      this.syncError = null;
      if (this.selection && !elementAt(this.doc, this.selection)) this.selection = null;
      this.dropInvalidSelections();
    } else {
      this.syncError = { message: parsed.message, line: parsed.line };
    }
    this.emit(['doc'], 'xml');
  }

  /** XML を整形する。すでに整形済みなら何もしない。 */
  format(): void {
    if (this.syncError) return;
    const xml = serialize(this.doc);
    if (xml === this.text) return;
    this.pushHistory(t('XML の整形'));
    this.lastTextEditAt = 0;
    this.text = xml;
    this.emit(['doc'], 'other');
  }

  /** 1つだけを選ぶ（ほかの選択は外す）。null で何も選ばない。 */
  select(path: Path | null, source: Source): void {
    this.setSelection(path, path ? [path] : []);
    this.anchor = path;
    this.emit(['selection'], source);
  }

  /**
   * Ctrl+クリック：選んでいなければ足して主な選択にし、選んでいれば外す（仕様書 §19）。
   * 足した要素の祖先・子孫は外す（normalizeSelections）。最後の1つを外すと、何も選ばない。
   */
  toggleSelect(path: Path, source: Source): void {
    if (this.isSelected(path)) {
      const rest = this.selections.filter((p) => !samePath(p, path));
      const primary = this.selection && !samePath(this.selection, path) ? this.selection : rest.at(-1) ?? null;
      this.setSelection(primary, rest);
      this.anchor = primary;
    } else {
      // 新しく足したものを優先する（祖先を選んでいたら祖先を外し、子孫を選んでいたら子孫を外す）
      const rest = this.selections.filter((p) => !isAncestorPath(path, p) && !isAncestorPath(p, path));
      this.setSelection(path, [...rest, path]);
      this.anchor = path;
    }
    this.emit(['selection'], source);
  }

  /**
   * Shift+クリック：起点（anchor）から path までを選ぶ。起点は変えない。
   * 同じ親の兄弟なら、その間の兄弟を文書の順に選ぶ。親が違うときは order（ツリーに見えている行の順。
   * 省けば文書の順）での範囲から、範囲の中のほかの要素の祖先になっているもの（間にある親のグループなど）を外して選ぶ。
   * order を渡したときは、同じ親でも order にある（見えている）要素だけを選ぶ。絞り込みや畳んだ行で隠れている兄弟まで
   * 選ぶと、続けて Delete を押したときに見えていない要素まで消えてしまうため。
   */
  selectRange(path: Path, source: Source, order?: readonly Path[]): void {
    const anchor = this.anchor && elementAt(this.doc, this.anchor) ? this.anchor : this.selection;
    if (!anchor || path.length === 0 || anchor.length === 0) {
      this.select(path, source);
      return;
    }
    let range: Path[];
    if (samePath(anchor.slice(0, -1), path.slice(0, -1))) {
      const parent = path.slice(0, -1);
      const lo = Math.min(anchor.at(-1)!, path.at(-1)!);
      const hi = Math.max(anchor.at(-1)!, path.at(-1)!);
      range = [];
      for (let i = lo; i <= hi; i++) range.push([...parent, i]);
      if (order) {
        const shown = new Set(order.map((p) => p.join('.')));
        range = range.filter((p) => samePath(p, path) || shown.has(p.join('.')));
      }
    } else {
      const rows = order ?? allElements(this.doc).map((e) => pathOf(e));
      const a = rows.findIndex((p) => samePath(p, anchor));
      const b = rows.findIndex((p) => samePath(p, path));
      if (a < 0 || b < 0) {
        this.select(path, source);
        return;
      }
      range = dropAncestorsOfOthers(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
    this.setSelection(path, range);
    this.anchor = anchor;
    this.emit(['selection'], source);
  }

  /**
   * Ctrl+A：主な選択の兄弟（同じ親の子）をすべて選ぶ。主な選択は変えない。
   * order（ツリーに見えている行・キャンバスに描かれている要素）を渡したときは、その中にある兄弟だけを選ぶ
   * （絞り込みや畳んだ行で隠れている兄弟を選ぶと、続けて Delete を押したときに見えない要素まで消えるため）。
   */
  selectAll(source: Source, order?: readonly Path[]): void {
    const sel = this.selection;
    if (!sel || sel.length === 0) return;
    const parent = elementAt(this.doc, sel.slice(0, -1));
    if (!parent) return;
    let all = Array.from(parent.children, (_, i) => [...sel.slice(0, -1), i]);
    if (order) {
      const shown = new Set(order.map((p) => p.join('.')));
      all = all.filter((p) => samePath(p, sel) || shown.has(p.join('.')));
    }
    this.setSelection(sel, all);
    this.emit(['selection'], source);
  }

  /** Esc：複数選択をやめ、主な選択だけを残す。複数でなければ何もしない（false）。 */
  clearMulti(source: Source = 'other'): boolean {
    if (!this.isMulti) return false;
    this.setSelection(this.selection, this.selection ? [this.selection] : []);
    this.anchor = this.selection;
    this.emit(['selection'], source);
    return true;
  }

  addImage(entry: ImageEntry, label: string = t('画像「{id}」を追加', { id: entry.id })): void {
    this.pushHistory(label);
    this.images = new Map(this.images);
    this.images.set(entry.id, entry);
    this.refreshIsNew();
    this.emit(['images'], 'other');
  }

  /** 複数の画像を一つの履歴でまとめて追加する（フォルダの一括取り込み）。 */
  addImages(entries: readonly ImageEntry[], label: string = t('画像 {n} 個を追加', { n: entries.length })): void {
    if (entries.length === 0) return;
    this.pushHistory(label);
    this.images = new Map(this.images);
    for (const e of entries) this.images.set(e.id, e);
    this.refreshIsNew();
    this.emit(['images'], 'other');
  }

  removeImages(ids: readonly string[], label?: string): void {
    const present = ids.filter((id) => this.images.has(id));
    if (present.length === 0) return;
    this.pushHistory(label ?? (present.length === 1 ? t('画像「{id}」の削除', { id: present[0]! }) : t('画像 {n} 個の削除', { n: present.length })));
    this.images = new Map(this.images);
    for (const id of present) this.images.delete(id);
    this.emit(['images'], 'other');
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot(prev.label));
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot(next.label));
    this.restore(next);
  }

  /**
   * 操作の履歴（編集メニューの「操作の履歴…」。仕様書 §18.6）。
   * labels は古い順に並べた操作の名前（元に戻せるもの → やり直せるもの）、index は今いる位置（適用済みの操作の数）。
   * index が 0 なら、記録の始まり（開いたとき、または履歴の上限 200 件でそれより前が消えたところ）にいる。
   */
  history(): { labels: string[]; index: number } {
    return {
      labels: [...this.undoStack.map((s) => s.label), ...[...this.redoStack].reverse().map((s) => s.label)],
      index: this.undoStack.length,
    };
  }

  /**
   * 履歴の index の位置へ移る。元に戻す・やり直しを続けて行うのと同じ結果になるが、
   * 途中の状態では XML を読み直さず、ビューへの通知も最後の 1 回だけにする（何十件も戻るときに描き直しを繰り返さないため）。
   * 動いたら true。範囲の外は端に丸める。
   */
  goTo(index: number): boolean {
    const target = Math.max(0, Math.min(Math.trunc(index), this.undoStack.length + this.redoStack.length));
    if (target === this.undoStack.length) return false;
    const take = (s: Snapshot) => {
      this.text = s.text;
      this.images = s.images;
      this.selection = s.selection;
      this.selections = s.selections;
    };
    while (this.undoStack.length > target) {
      const prev = this.undoStack.pop()!;
      this.redoStack.push(this.snapshot(prev.label));
      take(prev);
    }
    while (this.undoStack.length < target) {
      const next = this.redoStack.pop()!;
      this.undoStack.push(this.snapshot(next.label));
      take(next);
    }
    this.restore({ text: this.text, images: this.images, selection: this.selection, selections: this.selections, label: '' });
    return true;
  }

  private restore(s: Snapshot): void {
    this.lastTextEditAt = 0;
    this.text = s.text;
    this.images = new Map(s.images);
    this.refreshIsNew();
    const parsed = parseXml(s.text);
    if (parsed.ok) {
      this.doc = parsed.doc;
      this.syncError = null;
    } else {
      this.syncError = { message: parsed.message, line: parsed.line };
    }
    this.selection = s.selection && elementAt(this.doc, s.selection) ? s.selection : null;
    this.selections = s.selections;
    this.dropInvalidSelections();
    this.anchor = this.selection;
    this.emit(['doc', 'selection', 'images'], 'history');
  }
}
