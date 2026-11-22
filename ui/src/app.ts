// アプリ全体の状態。開いているファイル（セッション）と、編集中のパーツ、Lint の結果を持つ。

import type { AppInfo, CustomUIVersion, OpenedDocument, Settings } from './bridge';
import { knownIdMso } from './catalog/catalog';
import { lint, NAMESPACES, type Problem } from './lint';
import { missingImageMso, onMsoIconsLoaded } from './msoIcons';
import { PartStore, type Change, type ImageEntry } from './store';

export interface Session {
  path: string;
  parts: Map<CustomUIVersion, PartStore>;
  active: PartStore;
  /** 元のファイルに customUI がなく、新規に作ったパーツか。 */
  created: boolean;
}

type AppEvent = 'session' | 'problems' | 'store' | 'settings';

class App {
  info: AppInfo = { version: '', excelInstalled: false };
  settings: Settings = { theme: 'system', xmlOnTop: false, iconSize: 32, ribbonErrorsHintShown: false };
  session: Session | null = null;
  problems: Problem[] = [];

  private readonly listeners = new Map<AppEvent, Set<(detail?: Change) => void>>();
  private unsubscribeStore: (() => void) | null = null;
  private lintTimer: number | undefined;

  on(event: AppEvent, listener: (detail?: Change) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  emit(event: AppEvent, detail?: Change): void {
    for (const l of this.listeners.get(event) ?? []) l(detail);
  }

  get store(): PartStore | null {
    return this.session?.active ?? null;
  }

  get dirty(): boolean {
    return [...(this.session?.parts.values() ?? [])].some((p) => p.dirty);
  }

  /** ホストから受け取ったファイルを開く。customUI がなければ customUI14 を新規に作る。 */
  open(doc: OpenedDocument): void {
    const parts = new Map<CustomUIVersion, PartStore>();
    for (const p of doc.parts) {
      const images: ImageEntry[] = p.images.map((i) => ({ id: i.id, dataUrl: `data:${i.contentType};base64,${i.base64}`, isNew: false }));
      parts.set(p.version, new PartStore(p.version, p.xml, images));
    }
    let created = false;
    if (parts.size === 0) {
      created = true;
      const xml = `<customUI xmlns="${NAMESPACES.office2010}">\n  <ribbon>\n    <tabs>\n    </tabs>\n  </ribbon>\n</customUI>\n`;
      const store = new PartStore('office2010', xml, []);
      parts.set('office2010', store);
    }
    const active = parts.get('office2010') ?? parts.get('office2007')!;
    this.session = { path: doc.path, parts, active, created };
    this.attach(active);
    this.emit('session');
    // 新規に作ったパーツは、保存するまで未保存として扱う
    if (created) active.edit('other', () => undefined);
  }

  close(): void {
    this.unsubscribeStore?.();
    this.session = null;
    this.problems = [];
    this.emit('session');
    this.emit('problems');
  }

  /** customUI と customUI14 の両方があるとき、編集する方を切り替える。 */
  switchPart(version: CustomUIVersion): void {
    const s = this.session;
    const store = s?.parts.get(version);
    if (!s || !store || s.active === store) return;
    s.active = store;
    this.attach(store);
    this.emit('session');
  }

  private attach(store: PartStore): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = store.subscribe((c) => {
      this.emit('store', c);
      if (c.kinds.has('doc') || c.kinds.has('images')) this.scheduleLint();
    });
    this.runLint();
  }

  scheduleLint(): void {
    window.clearTimeout(this.lintTimer);
    this.lintTimer = window.setTimeout(() => this.runLint(), 150);
  }

  runLint(): void {
    const store = this.store;
    if (!store) return;
    this.problems = lint(store.doc, {
      version: store.version,
      imageIds: new Set(store.images.keys()),
      knownIdMso,
      missingImageMso: missingImageMso(),
    });
    this.emit('problems');
  }
}

export const app = new App();

onMsoIconsLoaded(() => app.scheduleLint());
