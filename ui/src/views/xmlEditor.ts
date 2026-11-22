// XML エディタ（仕様書 §5.5）。Monaco を使い、スキーマに基づく補完、エラーの波線、選択の同期を行う。

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { app } from '../app';
import { allElements, pathOf } from '../model';
import { attributes, backstageElements, callbackSignature, elements } from '../schema';
import { attrRange, elementIndexAt, scanElements, type ElementSpan } from '../xmlpos';
import { lang, t } from '../i18n';

/** 分類名。「表示」はメニューの［表示］と同じ文言なので、英語はここで決める。 */
function categoryName(cat: string): string {
  return lang === 'en' && cat === '表示' ? 'Appearance' : t(cat);
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

let editor: monaco.editor.IStandaloneCodeEditor;
let applying = false;
let spans: ElementSpan[] = [];
let spansFor = '';

export interface XmlEditorHandle {
  focus(): void;
  setTheme(dark: boolean): void;
}

export function mountXmlEditor(host: HTMLElement, statusEl: HTMLElement, handlers: { undo: () => void; redo: () => void }): XmlEditorHandle {
  editor = monaco.editor.create(host, {
    language: 'xml',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    folding: true,
    renderWhitespace: 'none',
    quickSuggestions: { other: true, strings: true, comments: false },
    suggestOnTriggerCharacters: true,
  });

  // Undo / Redo はアプリ全体の履歴に任せる（キャンバスやツリーの操作と一つの履歴にするため）
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, handlers.undo);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, handlers.redo);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, handlers.redo);
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => app.store?.format());

  editor.onDidChangeModelContent(() => {
    if (applying) return;
    app.store?.setText(editor.getValue());
  });

  // カーソル位置の要素を、キャンバスとツリーでも選択する
  editor.onDidChangeCursorPosition((e) => {
    if (applying || e.source === 'api') return;
    const store = app.store;
    if (!store || store.syncError) return;
    const offset = editor.getModel()!.getOffsetAt(e.position);
    const idx = elementIndexAt(currentSpans(), offset);
    const el = allElements(store.doc)[idx];
    if (el) store.select(pathOf(el), 'xml');
  });

  const sync = (fromSelf: boolean) => {
    const store = app.store;
    if (!store) return;
    if (!fromSelf && editor.getValue() !== store.text) {
      applying = true;
      const model = editor.getModel()!;
      // setValue だと Monaco 側の履歴が残るので、全体の置き換えとして流し込む
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: store.text }], () => null);
      applying = false;
    }
    statusEl.hidden = store.syncError === null;
    statusEl.textContent = store.syncError ? t('同期停止中：XMLの構文を直すと再開します（{message}）', { message: store.syncError.message }) : '';
  };

  app.on('session', () => {
    sync(false);
    revealSelection();
  });
  app.on('store', (c) => {
    if (!c) return;
    if (c.kinds.has('doc')) sync(c.source === 'xml');
    if (c.kinds.has('selection') && c.source !== 'xml') revealSelection();
  });
  app.on('problems', updateMarkers);

  registerLanguageFeatures();

  return {
    focus: () => editor.focus(),
    setTheme: (dark) => monaco.editor.setTheme(dark ? 'vs-dark' : 'vs'),
  };
}

function currentSpans(): ElementSpan[] {
  const text = editor.getValue();
  if (text !== spansFor) {
    spans = scanElements(text);
    spansFor = text;
  }
  return spans;
}

function elementIndexOfPath(path: readonly number[]): number {
  const store = app.store;
  if (!store) return -1;
  const all = allElements(store.doc);
  return all.findIndex((el) => {
    const p = pathOf(el);
    return p.length === path.length && p.every((v, i) => v === path[i]);
  });
}

function revealSelection(): void {
  const store = app.store;
  if (!store?.selection || store.syncError) return;
  const span = currentSpans()[elementIndexOfPath(store.selection)];
  if (!span) return;
  const model = editor.getModel()!;
  const start = model.getPositionAt(span.start);
  const end = model.getPositionAt(span.startTagEnd);
  applying = true;
  editor.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column));
  // 横方向には動かさず、行だけを見える位置に出す
  editor.revealLineInCenterIfOutsideViewport(start.lineNumber, monaco.editor.ScrollType.Smooth);
  editor.setScrollLeft(0);
  applying = false;
}

function updateMarkers(): void {
  const model = editor.getModel();
  const store = app.store;
  if (!model || !store) return;
  const markers: monaco.editor.IMarkerData[] = [];
  if (store.syncError) {
    const line = store.syncError.line ?? 1;
    markers.push({ severity: monaco.MarkerSeverity.Error, message: store.syncError.message, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(Math.min(line, model.getLineCount())) });
  } else {
    const text = model.getValue();
    const all = currentSpans();
    for (const p of app.problems) {
      const span = all[elementIndexOfPath(p.path)];
      if (!span) continue;
      const range = (p.attr ? attrRange(text, span, p.attr) : null) ?? { start: span.start, end: span.startTagEnd };
      const s = model.getPositionAt(range.start);
      const e = model.getPositionAt(range.end);
      markers.push({
        severity: p.severity === 'error' ? monaco.MarkerSeverity.Error : p.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: p.message,
        startLineNumber: s.lineNumber,
        startColumn: s.column,
        endLineNumber: e.lineNumber,
        endColumn: e.column,
      });
    }
  }
  monaco.editor.setModelMarkers(model, 'sash', markers);
}

/** カーソル位置の XML の文脈（どの要素の中か、タグの中か）を調べる。 */
function contextAt(text: string, offset: number): { inTag: string | null; attrName: string | null; parentTag: string | null; inBackstage: boolean } {
  const before = text.slice(0, offset);
  const lt = before.lastIndexOf('<');
  const gt = before.lastIndexOf('>');
  if (lt > gt) {
    const inside = before.slice(lt + 1);
    const tag = /^([A-Za-z][\w]*)/.exec(inside)?.[1] ?? null;
    const attrMatch = /([A-Za-z]\w*)\s*=\s*"[^"]*$/.exec(inside);
    const enclosing = openAt(text, lt);
    return { inTag: tag, attrName: attrMatch?.[1] ?? null, parentTag: null, inBackstage: tag === 'backstage' || enclosing.includes('backstage') };
  }
  // カーソルを囲んでいる要素のうち、最も内側のものを親とする
  const open = openAt(text, offset);
  return { inTag: null, attrName: null, parentTag: open.at(-1) ?? null, inBackstage: open.includes('backstage') };
}

/** 位置を囲んでいる（開いたままの）要素名を、外側から順に返す。 */
function openAt(text: string, offset: number): string[] {
  return scanElements(text)
    .filter((s) => {
      const selfClosing = text[s.startTagEnd - 2] === '/';
      const unclosed = s.end === s.startTagEnd;
      return !selfClosing && s.startTagEnd <= offset && (unclosed || s.end > offset);
    })
    .map((s) => s.tag);
}

let registered = false;

function registerLanguageFeatures(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('xml', {
    triggerCharacters: ['<', ' ', '"'],
    provideCompletionItems(model, position) {
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const ctx = contextAt(text, offset);
      const suggestions: monaco.languages.CompletionItem[] = [];

      if (ctx.inTag && ctx.attrName) {
        // 属性値：列挙値と真偽値
        const def = attributes.get(ctx.attrName);
        const values = def?.kind === 'bool' ? ['true', 'false'] : def?.kind === 'enum' ? def.values ?? [] : [];
        for (const v of values) suggestions.push({ label: v, kind: monaco.languages.CompletionItemKind.EnumMember, insertText: v, range });
        return { suggestions };
      }
      if (ctx.inTag) {
        // 属性名：まだ書いていないものだけ
        const lt = text.lastIndexOf('<', offset);
        const tagText = text.slice(lt, offset);
        const present = new Set([...tagText.matchAll(/\s([A-Za-z]\w*)\s*=/g)].map((m) => m[1]));
        const tagDef = (ctx.inBackstage && ctx.inTag !== 'backstage' ? backstageElements : elements).get(ctx.inTag);
        for (const d of (tagDef?.attrs ?? []).map((n) => attributes.get(n)).filter((x): x is NonNullable<typeof x> => x !== undefined)) {
          if (present.has(d.name)) continue;
          suggestions.push({
            label: d.name,
            kind: d.kind === 'callback' ? monaco.languages.CompletionItemKind.Event : monaco.languages.CompletionItemKind.Property,
            detail: categoryName(d.category),
            documentation: t(d.desc),
            insertText: `${d.name}="$1"`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          });
        }
        return { suggestions };
      }
      // 要素名：親に置けるものだけ
      const table = (tag: string) => (ctx.inBackstage && tag !== 'backstage' ? backstageElements : elements);
      const parent = ctx.parentTag ? table(ctx.parentTag).get(ctx.parentTag) : null;
      const candidates = parent ? parent.children : ['customUI'];
      const afterLt = text[offset - word.word.length - 1] === '<';
      for (const tag of candidates) {
        const def = (ctx.inBackstage || ctx.parentTag === 'backstage' ? backstageElements : elements).get(tag);
        const needsId = def?.idRequired && def.attrs.includes('id');
        suggestions.push({
          label: tag,
          kind: monaco.languages.CompletionItemKind.Class,
          detail: def ? t(def.title) : undefined,
          insertText: `${afterLt ? '' : '<'}${tag}${needsId ? ' id="$1"' : ''}${def && def.children.length > 0 ? `>\n\t$0\n</${tag}>` : ' />'}`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }
      return { suggestions };
    },
  });

  // 属性名にホバーすると、日本語の説明と指定例を出す（仕様書 §5.4）
  monaco.languages.registerHoverProvider('xml', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const def = attributes.get(word.word);
      const el = elements.get(word.word);
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const ctx = contextAt(text, offset);
      if (def && ctx.inTag) {
        const lines = [t('**{name}**（{category}）', { name: def.name, category: categoryName(def.category) }), t(def.desc)];
        if (def.example) lines.push(`${t('例：')}\`${def.name}="${t(def.example)}"\``);
        if (def.kind === 'callback') lines.push(`\`${t('Sub 名前({signature})', { signature: callbackSignature(def.name, ctx.inTag) })}\``);
        if (def.values) lines.push(`${t('値：')}${def.values.join(' / ')}`);
        return { contents: lines.map((value) => ({ value })) };
      }
      if (el) return { contents: [{ value: `**<${el.tag}>** ${t(el.title)}` }] };
      return null;
    },
  });
}
