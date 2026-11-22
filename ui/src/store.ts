// 編集中の customUI パーツ 1 つ分の状態。キャンバス・ツリー・XML のどこから変更しても、
// ここを通して一つの Undo / Redo 履歴に記録する（仕様書 §5）。

import { elementAt, parseXml, serialize, type Path } from './model';
import type { CustomUIVersion } from './bridge';
import { NAMESPACES } from './lint';

export interface ImageEntry {
  id: string;
  /** 表示用の data URL。 */
  dataUrl: string;
  /** ファイルにまだ書き込んでいない画像か。 */
  isNew: boolean;
  /** アイコンエディタで作ったときの元画像と加工設定。あれば同じ設定からやり直せる（このセッションの間だけ）。 */
  edit?: { source: Blob; sourceName: string; options: unknown };
}

interface Snapshot {
  text: string;
  selection: Path | null;
  images: Map<string, ImageEntry>;
}

export type ChangeKind = 'doc' | 'selection' | 'images' | 'saved';

/** 変更の発生元。発生元のビューは自分を描き直さない（XML エディタのカーソルを飛ばさないため）。 */
export type Source = 'canvas' | 'tree' | 'xml' | 'inspector' | 'history' | 'other';

export interface Change {
  kinds: ReadonlySet<ChangeKind>;
  source: Source;
}

const TEXT_COALESCE_MS = 800;
const HISTORY_LIMIT = 200;

export class PartStore {
  readonly version: CustomUIVersion;
  doc: Document;
  /** XML エディタの中身。構文エラーの間は doc と一致しない。 */
  text: string;
  syncError: { message: string; line?: number } | null = null;
  selection: Path | null = null;
  images: Map<string, ImageEntry>;
  /** 元のファイルにあって、保存時に消す画像。 */
  readonly removedImages = new Set<string>();

  private savedText: string;
  private savedImageKey: string;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private lastTextEditAt = 0;
  private readonly listeners = new Set<(c: Change) => void>();

  constructor(version: CustomUIVersion, xml: string, images: ImageEntry[]) {
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
    this.savedText = xml;
    this.savedImageKey = this.imageKey();
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
    return this.savedText;
  }

  /** 最後に保存したときから、追加・削除された画像。 */
  imageChanges(): { added: string[]; removed: string[] } {
    return { added: [...this.images.values()].filter((i) => i.isNew).map((i) => i.id), removed: [...this.removedImages] };
  }

  /** XML と画像をまとめて置き換える（.sash.json の読み込み）。一つの履歴にする。 */
  replaceAll(xml: string, images: ImageEntry[]): void {
    this.pushHistory();
    this.lastTextEditAt = 0;
    for (const id of this.images.keys()) {
      const img = this.images.get(id)!;
      if (!img.isNew) this.removedImages.add(id);
    }
    this.images = new Map(images.map((i) => [i.id, i]));
    for (const i of images) this.removedImages.delete(i.id);
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

  get dirty(): boolean {
    return this.text !== this.savedText || this.imageKey() !== this.savedImageKey;
  }

  get selectedElement(): Element | null {
    return this.selection ? elementAt(this.doc, this.selection) : null;
  }

  private imageKey(): string {
    return [...this.images.values()].map((i) => `${i.id}:${i.isNew ? i.dataUrl.length : 0}`).sort().join('|');
  }

  private snapshot(): Snapshot {
    return { text: this.text, selection: this.selection, images: new Map(this.images) };
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * DOM を直接変更する編集。fn が返したパスを新しい選択にする（undefined なら選択はそのまま）。
   * XML が壊れている間は、最後に正しかった状態に対して編集する。
   */
  edit(source: Source, fn: (doc: Document) => Path | null | void): void {
    this.pushHistory();
    this.lastTextEditAt = 0;
    const result = fn(this.doc);
    if (result !== undefined) this.selection = result;
    this.text = serialize(this.doc);
    this.syncError = null;
    this.emit(['doc', 'selection'], source);
  }

  /** XML エディタでの変更。短い間隔の入力は一つの履歴にまとめる。 */
  setText(text: string): void {
    if (text === this.text) return;
    const now = Date.now();
    if (now - this.lastTextEditAt > TEXT_COALESCE_MS) this.pushHistory();
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

  /** XML を整形する。 */
  format(): void {
    if (this.syncError) return;
    this.edit('other', () => undefined);
  }

  select(path: Path | null, source: Source): void {
    this.selection = path;
    this.emit(['selection'], source);
  }

  addImage(entry: ImageEntry): void {
    this.pushHistory();
    this.images.set(entry.id, entry);
    this.removedImages.delete(entry.id);
    this.emit(['images'], 'other');
  }

  /** 複数の画像を一つの履歴でまとめて追加する（フォルダの一括取り込み）。 */
  addImages(entries: readonly ImageEntry[]): void {
    if (entries.length === 0) return;
    this.pushHistory();
    for (const e of entries) {
      this.images.set(e.id, e);
      this.removedImages.delete(e.id);
    }
    this.emit(['images'], 'other');
  }

  removeImages(ids: readonly string[]): void {
    this.pushHistory();
    for (const id of ids) {
      const img = this.images.get(id);
      if (!img) continue;
      this.images.delete(id);
      if (!img.isNew) this.removedImages.add(id);
    }
    this.emit(['images'], 'other');
  }

  /** 画像の追加と、その画像のコントロールへの設定を、一つの履歴にまとめて行う。 */
  addImageAndApply(entry: ImageEntry, fn: (doc: Document) => Path | null | void): void {
    this.pushHistory();
    this.images.set(entry.id, entry);
    this.removedImages.delete(entry.id);
    const result = fn(this.doc);
    if (result !== undefined) this.selection = result;
    this.text = serialize(this.doc);
    this.syncError = null;
    this.emit(['doc', 'selection', 'images'], 'other');
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
    this.redoStack.push(this.snapshot());
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  private restore(s: Snapshot): void {
    this.lastTextEditAt = 0;
    this.text = s.text;
    this.images = new Map(s.images);
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

  /** 保存が終わったら、今の状態を保存済みとして記録する。 */
  markSaved(): void {
    for (const [id, img] of this.images) if (img.isNew) this.images.set(id, { ...img, isNew: false });
    this.removedImages.clear();
    this.savedText = this.text;
    this.savedImageKey = this.imageKey();
    this.emit(['saved'], 'other');
  }
}
