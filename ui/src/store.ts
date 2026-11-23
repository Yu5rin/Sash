// 編集中の customUI パーツ 1 つ分の状態。キャンバス・ツリー・XML のどこから変更しても、
// ここを通して一つの Undo / Redo 履歴に記録する（仕様書 §5）。

import { elementAt, parseXml, samePath, serialize, type Path } from './model';
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

type EditFn = (doc: Document) => Path | null | void | typeof ABORT;

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
  selection: Path | null = null;
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

  // ---- 履歴 ----

  private snapshot(label: string): Snapshot {
    return { text: this.text, selection: this.selection, images: new Map(this.images), label };
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
    this.selection = null;
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
      reportRefusal(t('XMLに構文エラーがあるため、この操作はできません。先にXMLエディタでエラーを直してください'));
      return false;
    }
    const before = this.snapshot(label);
    const beforeXml = serialize(this.doc);
    const rollback = () => {
      this.images = before.images;
      this.selection = before.selection;
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
    const selection = result !== undefined ? result : this.selection;
    const xml = serialize(this.doc);
    if (!image && xml === beforeXml && samePath(selection, before.selection)) {
      rollback();
      return false;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.lastTextEditAt = 0;
    this.selection = selection;
    this.text = xml;
    if (image) this.refreshIsNew();
    this.emit(image ? ['doc', 'selection', 'images'] : ['doc', 'selection'], source);
    return true;
  }

  /** XML エディタでの変更。短い間隔の入力は一つの履歴にまとめる。 */
  setText(text: string): void {
    if (text === this.text) return;
    const now = Date.now();
    if (now - this.lastTextEditAt > TEXT_COALESCE_MS) this.pushHistory(t('XMLの編集'));
    this.lastTextEditAt = now;
    this.text = text;
    const parsed = parseXml(text);
    if (parsed.ok) {
      this.doc = parsed.doc;
      this.syncError = null;
      if (this.selection && !elementAt(this.doc, this.selection)) this.selection = null;
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
    this.pushHistory(t('XMLの整形'));
    this.lastTextEditAt = 0;
    this.text = xml;
    this.emit(['doc'], 'other');
  }

  select(path: Path | null, source: Source): void {
    this.selection = path;
    this.emit(['selection'], source);
  }

  addImage(entry: ImageEntry, label: string = t('画像「{id}」の追加', { id: entry.id })): void {
    this.pushHistory(label);
    this.images = new Map(this.images);
    this.images.set(entry.id, entry);
    this.refreshIsNew();
    this.emit(['images'], 'other');
  }

  /** 複数の画像を一つの履歴でまとめて追加する（フォルダの一括取り込み）。 */
  addImages(entries: readonly ImageEntry[], label: string = t('画像 {n} 個の追加', { n: entries.length })): void {
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
    this.restore({ text: this.text, images: this.images, selection: this.selection, label: '' });
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
    this.emit(['doc', 'selection', 'images'], 'history');
  }
}
