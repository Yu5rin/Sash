import './styles.css';
import { invoke, isHosted, type CustomUIPartDto, type OpenedDocument } from './bridge';
import { parseCustomUI } from './model';
import { renderCanvas, renderPalette, renderTree } from './render';
import { createXmlEditor } from './xmlEditor';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const editor = createXmlEditor($('xml-editor'));
let current: { doc: OpenedDocument; part: CustomUIPartDto } | null = null;

renderPalette($('palette-list'));

function setStatus(message: string): void {
  $('status-message').textContent = message;
}

/** XML から他のビューを描き直す。構文エラーの間は最後に正しかった表示のまま止める（仕様書 §5.5）。 */
function syncFromXml(xml: string): void {
  const result = parseCustomUI(xml);
  $('xml-status').hidden = result.ok;
  if (!result.ok) return;
  renderTree($('tree'), result.root);
  renderCanvas($('canvas'), result.root);
}

function show(doc: OpenedDocument): void {
  const part = doc.parts.find((p) => p.version === 'office2010') ?? doc.parts[0];
  if (!part) {
    setStatus('このブックにはリボン定義がありません');
    return;
  }
  current = { doc, part };
  $('file-name').textContent = doc.path;
  $<HTMLButtonElement>('btn-save').disabled = false;
  $('status-images').textContent = `アイコン ${part.images.length}`;
  if (doc.hasBothVersions) setStatus('customUI と customUI14 の両方があります。2010以降のExcelは14を優先します');
  editor.setValue(part.xml);
  syncFromXml(part.xml);
}

async function open(path?: string): Promise<void> {
  try {
    const doc = await invoke('file.open', path ? { path } : undefined);
    if (doc) show(doc);
  } catch (e) {
    setStatus((e as Error).message);
  }
}

async function save(): Promise<void> {
  if (!current) return;
  try {
    const res = await invoke('file.save', { path: current.doc.path, version: current.part.version, xml: editor.getValue() });
    setStatus(`保存しました（バックアップ：${res.backup}）`);
  } catch (e) {
    setStatus((e as Error).message);
  }
}

editor.onChange(syncFromXml);
$('btn-open').addEventListener('click', () => void open());
$('btn-save').addEventListener('click', () => void save());
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    void open();
  }
});

const ready = await invoke('app.ready');
const info = await invoke('app.info');
$<HTMLButtonElement>('btn-apply').title = info.excelInstalled ? 'Excelへ反映 (F5)' : 'Excelが見つからないため使えません';
setStatus(isHosted ? `Sash ${info.version}` : 'ブラウザで実行中（ホストなし）');
if (ready.initialFile) await open(ready.initialFile);
else if (!isHosted) await open();
