// 保存済みの状態との差分（仕様書 §9.3、第3弾）。XML を左右に並べて比べる。

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { app } from '../app';
import { h } from '../dom';
import { t } from '../i18n';
import { openModal } from './modal';

export function openDiff(): void {
  const s = app.session;
  if (!s) return;
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

  const show = () => {
    const { added, removed } = current.imageChanges();
    const same = current.savedXml === current.text && added.length === 0 && removed.length === 0;
    summary.replaceChildren(h('span', null, same ? t('保存済みの状態から変更はありません') : t('赤：保存済みから消えた行　緑：追加・変更した行')));
    if (added.length) summary.append(h('span', { class: 'tag' }, t('追加する画像：{list}', { list: added.join(t('、')) })));
    if (removed.length) summary.append(h('span', { class: 'tag removed' }, t('削除する画像：{list}', { list: removed.join(t('、')) })));
    for (const m of models) m.dispose();
    models = [monaco.editor.createModel(current.savedXml, 'xml'), monaco.editor.createModel(current.text, 'xml')];
    editor?.setModel({ original: models[0]!, modified: models[1]! });
  };

  const modal = openModal(t('保存済みとの差分'), h('div', { class: 'diff' }, h('div', { class: 'diff-bar' }, summary, select), host), {
    wide: true,
    onClose: () => {
      editor?.dispose();
      for (const m of models) m.dispose();
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
  show();
  void modal;
}
