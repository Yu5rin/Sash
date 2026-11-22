import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// XML は言語サーバーを持たないので、エディタ本体のワーカーだけを使う
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export interface XmlEditor {
  getValue(): string;
  setValue(xml: string): void;
  onChange(listener: (xml: string) => void): void;
}

export function createXmlEditor(host: HTMLElement): XmlEditor {
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const editor = monaco.editor.create(host, {
    language: 'xml',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    scrollBeyondLastLine: false,
    theme: dark.matches ? 'vs-dark' : 'vs',
  });
  dark.addEventListener('change', (e) => monaco.editor.setTheme(e.matches ? 'vs-dark' : 'vs'));

  let suppress = false;
  return {
    getValue: () => editor.getValue(),
    setValue: (xml) => {
      suppress = true;
      editor.setValue(xml);
      suppress = false;
    },
    onChange: (listener) => {
      editor.onDidChangeModelContent(() => {
        if (!suppress) listener(editor.getValue());
      });
    },
  };
}
