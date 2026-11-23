// 保存済みの状態との差分（仕様書 §9.3、第3弾）。XML を左右に並べて比べる。

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { app } from '../app';
import { h } from '../dom';
import { t } from '../i18n';
import { openModal } from './modal';

/** 計算が終わらないときに、エディタとモデルを捨てるまでの待ち時間の上限。 */
const CLEANUP_TIMEOUT_MS = 5000;

export function openDiff(): void {
  const s = app.session;
  if (!s) return;
  // 二重に開くと Monaco の差分エディタが2つ作られ、閉じても片方が残る
  if (document.querySelector('.modal .diff-editor')) return;
  const parts = [...s.parts.values()];
  let current = s.active;
  const host = h('div', { class: 'diff-editor' });
  const summary = h('div', { class: 'diff-summary' });
  const select = parts.length > 1
    ? h('select', { onchange: (e: Event) => { current = parts.find((p) => p.version === (e.target as HTMLSelectElement).value) ?? current; show(); } },
        parts.map((p) => h('option', { value: p.version, selected: p === current }, p.version === 'office2010' ? 'customUI14.xml' : 'customUI.xml')))
    : null;

  const dark = document.documentElement.dataset['theme'] === 'dark' || (document.documentElement.dataset['theme'] !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  let editor: monaco.editor.IStandaloneDiffEditor | null = null;
  let models: monaco.editor.ITextModel[] = [];
  /** 最後に渡したモデルの差分の計算が終わったか。 */
  let diffReady = false;
  let disposed = false;
  let pendingCleanup: (() => void) | null = null;

  const show = () => {
    const { added, removed } = current.imageChanges();
    const same = current.savedXml === current.text && added.length === 0 && removed.length === 0;
    summary.replaceChildren(h('span', null, same ? t('保存済みの状態から変更はありません') : t('赤：保存済みから消えた行　緑：追加・変更した行')));
    if (added.length) summary.append(h('span', { class: 'tag' }, t('追加する画像：{list}', { list: added.join(t('、')) })));
    if (removed.length) summary.append(h('span', { class: 'tag removed' }, t('削除する画像：{list}', { list: removed.join(t('、')) })));
    diffReady = false;
    const old = models;
    models = [monaco.editor.createModel(current.savedXml, 'xml'), monaco.editor.createModel(current.text, 'xml')];
    editor?.setModel({ original: models[0]!, modified: models[1]! });
    // 古いモデルは、差し替えてから捨てる
    for (const m of old) m.dispose();
  };

  const modal = openModal(t('保存済みとの差分'), h('div', { class: 'diff' }, h('div', { class: 'diff-bar' }, summary, select), host), {
    wide: true,
    key: 'diff',
    onClose: () => {
      // 差分の計算中に閉じると、Monaco は先にモデルを捨てられた計算結果を受け取って
      // 「no diff result available」を投げる（dispose は計算を取り消さないため）。
      // 計算が終わるまで（長くても数秒）エディタとモデルを捨てるのを待つ。画面（ダイアログ）はすぐ閉じる
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        // エディタを先に捨ててからモデルを捨てる（逆だと Monaco が捨てたモデルを参照して警告を出す）
        editor?.dispose();
        editor = null;
        for (const m of models) m.dispose();
        models = [];
      };
      if (diffReady) cleanup();
      else {
        pendingCleanup = cleanup;
        window.setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
      }
    },
  });
  editor = monaco.editor.createDiffEditor(host, {
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    renderSideBySide: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    theme: dark ? 'vs-dark' : 'vs',
  });
  editor.onDidUpdateDiff(() => {
    diffReady = true;
    pendingCleanup?.();
  });
  show();
  void modal;
}
