// XML エディタ（仕様書 §5.5）。Monaco を使い、スキーマに基づく補完、エラーの波線、選択の同期を行う。

import type * as MonacoTypes from 'monaco-editor/esm/vs/editor/editor.api';
import { editorScrollbar, editorThemeName, ensureEditorThemes, monaco } from './monacoApi';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { app } from '../app';
import { h } from '../dom';
import { allElements, pathOf, serialize } from '../model';
import { attributes, backstageElements, callbackSignature, elements } from '../schema';
import { attrRange, elementIndexAt, scanElements, type ElementSpan } from '../xmlpos';
import { lang, t } from '../i18n';
import { describeXmlError } from '../xmlError';
import { minimalEdit } from './textDiff';
import { setElementMenuHooks } from './contextMenu';
import { ask } from '../dialogs/modal';

/** 分類名。「表示」はメニューの［表示］と同じ文言なので、英語はここで決める。 */
function categoryName(cat: string): string {
  return lang === 'en' && cat === '表示' ? 'Appearance' : t(cat);
}

/**
 * 構文エラーで同期が止まっている間、見た目だけほかの画面を暗くする（styles-w3.css が #app.xml-sync-error で決める）。
 * 左右の枠に aria-disabled は付けない：ツリーでの選択などは止まっていないので、「操作できない」と読み上げると実態と合わない。
 * 止まっていることは、XML エディタの帯（role="status"）が伝える。
 */
function setSyncStopped(stopped: boolean): void {
  document.getElementById('app')?.classList.toggle('xml-sync-error', stopped);
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

let editor: MonacoTypes.editor.IStandaloneCodeEditor;
let applying = false;
/** 「最後の正しい状態に戻す」の最中。文字を入れ替えるときにカーソルが動いても、選択を customUI に飛ばさない（総点検 X-2）。 */
let restoring = false;
let spans: ElementSpan[] = [];
let spansFor = '';
/** 選択中の要素の開始タグを示す飾り（範囲選択の代わり。選択してしまうと Undo のたびにタグ全体が選ばれるため）。 */
let selectionDecorations: MonacoTypes.editor.IEditorDecorationsCollection | null = null;

/** XML エディタにフォーカスを移す（Ctrl+3 / F6）。 */
export function focus(): void {
  editor?.focus();
}

/** XML エディタでその要素を表示し、フォーカスを移す（右クリックメニューの「XML で表示」）。 */
export function revealInXml(path: readonly number[]): void {
  const store = app.store;
  if (!store || !editor) return;
  if (!store.selection || store.selection.join('.') !== path.join('.')) store.select(path, 'other');
  revealSelection(true);
  editor.focus();
}

/** 行を表示する（XML の構文エラーなど、要素に結びつかない問題のとき）。 */
export function revealLine(line: number): void {
  if (!editor) return;
  const model = editor.getModel();
  if (!model) return;
  const ln = Math.max(1, Math.min(line, model.getLineCount()));
  editor.setPosition({ lineNumber: ln, column: 1 });
  editor.revealLineInCenterIfOutsideViewport(ln, monaco.editor.ScrollType.Smooth);
  editor.focus();
}

/** Esc で XML エディタから出るときの行き先（main.ts が登録する。パネルの切り替えを xmlEditor が知らなくて済むように）。 */
let cyclePaneHook: (() => void) | null = null;

/** Esc で XML エディタを出たときに、フォーカスを移す先を登録する。 */
export function setXmlEscapeHandler(fn: () => void): void {
  cyclePaneHook = fn;
}

export interface XmlEditorHandle {
  focus(): void;
  setTheme(dark: boolean): void;
}

export function mountXmlEditor(host: HTMLElement, statusEl: HTMLElement, handlers: { undo: () => void; redo: () => void }): XmlEditorHandle {
  ensureEditorThemes();
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
    scrollbar: editorScrollbar,
    overviewRulerBorder: false,
  });

  // Undo / Redo はアプリ全体の履歴に任せる（キャンバスやツリーの操作と一つの履歴にするため）。
  // addCommand はすべてのエディタに効くキー割り当てとして登録されるので、差分ダイアログの中の Ctrl+Z まで
  // アプリの Undo になってしまう（不具合 7）。このエディタにだけある文脈キーを条件にした操作として登録する。
  editor.createContextKey('sashMainXml', true);
  // 右クリックメニューにも出す（製品版は WebView2 の既定のメニューを切っているので、Monaco のメニューが唯一の入口。総点検 G-3）。
  // 切り取り・コピー・貼り付け・すべて選択は Monaco 自身の項目が出る
  const action = (id: string, label: string, keybindings: number[], run: () => void, menuOrder: number) =>
    editor.addAction({ id: `sash.${id}`, label, keybindings, precondition: 'sashMainXml', keybindingContext: 'sashMainXml', contextMenuGroupId: '1_modification', contextMenuOrder: menuOrder, run });
  action('undo', t('元に戻す'), [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ], handlers.undo, 1);
  action('redo', t('やり直し'), [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ], handlers.redo, 2);
  action('format', t('XML を整形'), [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF], () => app.store?.format(), 3);
  // 右クリックメニューの「すべて選択」（Monaco のメニュー部品には含まれないので足す）
  editor.addAction({
    id: 'sash.selectAll',
    label: t('すべて選択'),
    contextMenuGroupId: '9_cutcopypaste',
    contextMenuOrder: 4,
    run: (ed) => {
      const model = ed.getModel();
      if (model) ed.setSelection(model.getFullModelRange());
    },
  });
  // Esc でキャンバスへ戻る（Tab は字下げに使うので、キーボードだけでは出られない。F6 でも出られる。総点検 X-3 の入口）。
  // 補完・検索・ヒントが開いているときは、そちらを閉じるのが先
  editor.addAction({
    id: 'sash.leave',
    label: t('キャンバスへ戻る'),
    keybindings: [monaco.KeyCode.Escape],
    precondition: 'sashMainXml && !suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !editorHasSelection && !inSnippetMode && !hasMultipleSelections',
    keybindingContext: 'sashMainXml',
    run: () => cyclePaneHook?.(),
  });
  selectionDecorations = editor.createDecorationsCollection();

  editor.onDidChangeModelContent(() => {
    if (applying) return;
    app.store?.setText(editor.getValue());
  });

  // カーソル位置の要素を、キャンバスとツリーでも選択する
  editor.onDidChangeCursorPosition((e) => {
    if (applying || restoring || e.source === 'api') return;
    const store = app.store;
    if (!store || store.syncError) return;
    const offset = editor.getModel()!.getOffsetAt(e.position);
    const idx = elementIndexAt(currentSpans(), offset);
    const el = allElements(store.doc)[idx];
    if (el) store.select(pathOf(el), 'xml');
  });

  // 帯の中身は一度だけ作る。同期のたびに作り直すと、ボタンにフォーカスがあるとき失われるため
  const statusMsg = h('span', { class: 'xml-status-msg' });
  const jumpBtn = h('button', { type: 'button', class: 'small', onclick: () => { const ln = app.store?.syncError?.line; if (ln) revealLine(ln); } }, t('エラーの行へ移る'));
  const restoreBtn = h('button', { type: 'button', class: 'small', onclick: () => void restoreLastValid() }, t('最後の正しい状態に戻す'));
  statusEl.replaceChildren(statusMsg, h('span', { class: 'xml-status-actions' }, jumpBtn, restoreBtn));
  statusEl.setAttribute('role', 'status');

  /** 壊れた XML を捨てて、同期が止まる前の（最後に正しく読めた）文書に戻す。入力中の XML は失われるので確認する。 */
  const restoreLastValid = async () => {
    const store = app.store;
    if (!store?.syncError) return;
    const r = await ask(t('最後の正しい状態に戻しますか？'), t('構文エラーになる前の内容に戻します。元に戻す（Ctrl+Z）で、いまの内容に戻せます。'), [
      { value: 'ok', label: t('戻す'), primary: true },
      { value: 'cancel', label: t('キャンセル') },
    ]);
    if (r !== 'ok' || !app.store?.syncError) return;
    // エディタの文字を置き換えれば、変更通知でストアにも伝わる（ストアだけを書き換えると、エディタの壊れた文字が残る）。
    // 全文の setValue ではカーソルが 1 行 1 列に飛び、選択が customUI に移ってしまうので、同期と同じく変わった所だけを置き換える
    const model = editor.getModel()!;
    const diff = minimalEdit(model.getValue(), serialize(app.store.doc));
    if (diff) {
      restoring = true;
      try {
        const range = monaco.Range.fromPositions(model.getPositionAt(diff.start), model.getPositionAt(diff.end));
        editor.executeEdits('sash-restore', [{ range, text: diff.text, forceMoveMarkers: false }]);
      } finally {
        restoring = false;
      }
    }
    editor.focus();
  };

  const sync = (fromSelf: boolean) => {
    const store = app.store;
    if (!store) {
      statusEl.hidden = true;
      setSyncStopped(false);
      return;
    }
    const model = editor.getModel()!;
    const current = model.getValue();
    if (!fromSelf && current !== store.text) {
      const diff = minimalEdit(current, store.text);
      if (diff) {
        applying = true;
        const scrollTop = editor.getScrollTop();
        const scrollLeft = editor.getScrollLeft();
        const range = monaco.Range.fromPositions(model.getPositionAt(diff.start), model.getPositionAt(diff.end));
        // 変わった部分だけを置き換え、カーソルと選択は Monaco の追従に任せる（範囲を選択しない）
        model.applyEdits([{ range, text: diff.text, forceMoveMarkers: false }]);
        editor.setScrollTop(scrollTop);
        editor.setScrollLeft(scrollLeft);
        applying = false;
      }
    }
    const err = store.syncError;
    statusEl.hidden = err === null;
    // 何が止まっているか（キャンバスとツリーへの反映）と、どうすれば再開するかを書く。長いときは 1 行で省略し、全文はツールチップに出す（総点検 X-5）
    const text = err ? t('XML に誤りがあるため、キャンバスとツリーへの反映を止めています（{message}）。直すと自動で再開します', { message: describeXmlError(err.message) }) : '';
    statusMsg.textContent = text;
    statusMsg.title = text;
    jumpBtn.hidden = !err?.line;
    setSyncStopped(err !== null);
  };

  let lastSession = app.session;
  app.on('session', () => {
    sync(false);
    // 別のファイルを開いたときは、前のファイルの表示位置（スクロールとカーソル）を引き継がない（総点検 L-3）
    if (app.session !== lastSession) {
      editor.setScrollTop(0);
      editor.setScrollLeft(0);
      editor.setPosition({ lineNumber: 1, column: 1 });
    }
    lastSession = app.session;
    revealSelection();
  });
  app.on('store', (c) => {
    if (!c) return;
    if (c.kinds.has('doc')) sync(c.source === 'xml');
    if (c.kinds.has('selection') && c.source !== 'xml') revealSelection();
    else if (c.kinds.has('doc') && c.source !== 'xml') revealSelection();
  });
  app.on('problems', updateMarkers);

  registerLanguageFeatures();
  // 右クリックメニューの「XML で表示」をこのエディタにつなぐ（メニュー側から Monaco を読み込まないため、ここで登録する）
  setElementMenuHooks({ revealInXml });

  return {
    focus: () => editor.focus(),
    setTheme: (dark) => monaco.editor.setTheme(editorThemeName(dark)),
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

function revealSelection(moveCursor = false): void {
  const store = app.store;
  if (!store?.selection || store.syncError) {
    selectionDecorations?.clear();
    return;
  }
  const span = currentSpans()[elementIndexOfPath(store.selection)];
  if (!span) {
    selectionDecorations?.clear();
    return;
  }
  const model = editor.getModel()!;
  const start = model.getPositionAt(span.start);
  const end = model.getPositionAt(span.startTagEnd);
  // 範囲は選択せず、開始タグに飾りを付けて示す。入力中の人のカーソルは動かさない
  // 複数選択のほかの要素は、開始タグに薄い飾りだけを付ける（カーソルとスクロールは主な選択に合わせる。仕様書 §19）
  const all = allElements(store.doc);
  const index = new Map(all.map((el, i) => [pathOf(el).join('.'), i]));
  const secondary = store.selections
    .filter((p) => p.join('.') !== store.selection!.join('.'))
    .map((p) => currentSpans()[index.get(p.join('.')) ?? -1])
    .filter((x): x is ElementSpan => x !== undefined)
    .map((sp) => {
      const a = model.getPositionAt(sp.start);
      const b = model.getPositionAt(sp.startTagEnd);
      return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { className: 'sash-secondary-tag', isWholeLine: false, overviewRuler: { color: '#2b7de940', position: monaco.editor.OverviewRulerLane.Center } } };
    });
  selectionDecorations?.set([
    { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), options: { className: 'sash-selected-tag', isWholeLine: false, overviewRuler: { color: '#2b7de980', position: monaco.editor.OverviewRulerLane.Center } } },
    { range: new monaco.Range(start.lineNumber, 1, start.lineNumber, 1), options: { isWholeLine: true, className: 'sash-selected-line' } },
    ...secondary,
  ]);
  applying = true;
  if (moveCursor || !editor.hasTextFocus()) editor.setPosition(start);
  // 横方向には動かさず、行だけを見える位置に出す
  editor.revealLineInCenterIfOutsideViewport(start.lineNumber, monaco.editor.ScrollType.Smooth);
  if (moveCursor) editor.setScrollLeft(0);
  applying = false;
}

function updateMarkers(): void {
  const model = editor.getModel();
  const store = app.store;
  if (!model || !store) return;
  const markers: MonacoTypes.editor.IMarkerData[] = [];
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
      const suggestions: MonacoTypes.languages.CompletionItem[] = [];

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
