// ファイルを開く・保存・Excel へ反映・閉じる・終了。
// - 保存と反映は一度に 1 つだけ走らせる（連打や F5 と Ctrl+S の同時押しで、同じファイルに二重に書き込まないように）
// - 保存の前に saveSnapshot() を取り、書き込みが終わったら markSaved(snapshot) を呼ぶ。保存中に加えた編集は未保存のまま残る
// - 未保存の変更があるときは、閉じる・別のファイルを開く・終了の前に「保存する／保存しない／キャンセル」を聞く

import { app } from '../app';
import { invoke, type PartToSave } from '../bridge';
import { ask } from '../dialogs/modal';
import { t } from '../i18n';
import { exportSash, parseSash, partXml } from '../sashJson';
import type { PartStore, SaveSnapshot } from '../store';
import { focus as focusCanvas, tabIdToActivate } from '../views/canvas';
import { imagesToSend } from './compat';
import { splitPath } from './text';
import { toast } from './toast';

export type BusyKind = 'save' | 'apply' | 'open' | null;

let busy: BusyKind = null;
const busyListeners = new Set<() => void>();

export function busyState(): BusyKind {
  return busy;
}

export function onBusyChange(fn: () => void): void {
  busyListeners.add(fn);
}

function setBusy(next: BusyKind): void {
  busy = next;
  for (const l of busyListeners) l();
}

/** 保存・反映の途中なら知らせて true を返す。 */
function refuseWhileBusy(): boolean {
  if (busy === null) return false;
  toast({ kind: 'info', message: busy === 'apply' ? t('Excelへの反映が終わるまでお待ちください') : busy === 'save' ? t('保存が終わるまでお待ちください') : t('ファイルを開いています。終わるまでお待ちください') });
  return true;
}

function fileNameOf(path: string): string {
  return splitPath(path).name;
}

/** 入力中でまだ確定していない欄を確定する処理（インスペクタ）。main.ts で登録する。 */
let flushPendingEdits: () => void = () => undefined;

/**
 * 書き込む前・閉じる前に、入力中の欄を確定させる処理を登録する。
 * インスペクタの欄は change か Enter で確定するので、入力したまま Ctrl+S / F5 / × を押すと、
 * その値が書き込む内容にも「未保存の変更」にも入らない。ビューを直接読み込まずに済むよう、外から渡す。
 */
export function setPendingEditFlusher(fn: () => void): void {
  flushPendingEdits = fn;
}

/** 未保存の変更を捨ててよいか。保存を選んだら保存し、成功したら true。 */
export async function confirmDiscard(): Promise<boolean> {
  flushPendingEdits();
  if (!app.dirty || !app.session) return true;
  if (refuseWhileBusy()) return false;
  const r = await ask(t('未保存の変更があります'), t('「{file}」への変更を保存しますか？保存しないと、変更は失われます。', { file: fileNameOf(app.session.path) }), [
    { value: 'discard', label: t('保存しない') },
    { value: 'cancel', label: t('キャンセル') },
    { value: 'save', label: t('保存する'), primary: true },
  ]);
  if (r === 'save') return save();
  return r === 'discard';
}

/** ファイルを開く。path がなければファイルの選択を出す。force なら未保存の確認をしない（復元のあとなど）。 */
export async function openFile(path?: string, opts: { force?: boolean } = {}): Promise<boolean> {
  if (refuseWhileBusy()) return false;
  // 選ぶ前に聞くと、選ぶのをやめたときに確認だけが無駄になるので、ファイルを選んだあとで聞く。
  // ただしパスが決まっているとき（最近使ったファイルなど）は、読む前に聞く
  if (path && !opts.force && !(await confirmDiscard())) return false;
  setBusy('open');
  let doc;
  try {
    doc = await invoke('file.open', path ? { path } : undefined);
  } catch (e) {
    toast({ kind: 'error', message: t('開けませんでした：{message}', { message: (e as Error).message }) });
    return false;
  } finally {
    setBusy(null);
  }
  if (!doc) return false;
  if (!path && !opts.force && !(await confirmDiscard())) return false;
  app.open(doc);
  // 開いたらキャンバスにフォーカスを移す（ホームのボタンやファイルの選択にフォーカスが残ったままだと、
  // 矢印キーで要素を選べず、まずキャンバスをクリックしなければならないため）
  focusCanvas();
  const s = app.session!;
  if (s.created) toast({ kind: 'info', message: t('このブックにはリボン定義がないので、customUI14 を新しく作りました') });
  else if (s.parts.size >= 2) toast({ kind: 'info', message: t('customUI と customUI14 の両方があります。2010以降のExcelは customUI14 を優先します') });
  return true;
}

/** 開いているファイルを閉じてホームに戻る。 */
export async function closeFile(): Promise<boolean> {
  if (!app.session) return true;
  if (refuseWhileBusy()) return false;
  if (!(await confirmDiscard())) return false;
  app.close();
  return true;
}

let quitting = false;

/**
 * Sash を終わる。閉じる手続きに進んだら true、やめた（キャンセル・保存の失敗・実行中）なら false。
 * 確認の途中でもう一度呼ばれたら（× を続けて押したなど）、同じ確認を二重に出さずに false を返す。
 */
export async function quit(): Promise<boolean> {
  if (quitting) return false;
  if (busy !== null) {
    refuseWhileBusy();
    return false;
  }
  quitting = true;
  try {
    if (!(await confirmDiscard())) return false;
    await invoke('app.close');
    return true;
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
    return false;
  } finally {
    quitting = false;
  }
}

/** 終わるのを確かめている途中か（ウィンドウの × で、確認の答えを待っている間）。 */
export function isQuitting(): boolean {
  return quitting;
}

interface Prepared {
  parts: PartToSave[];
  snapshots: Map<PartStore, SaveSnapshot>;
}

/** 書き込む内容と、その時点の控えを取る。ホストを待つ前に呼ぶこと。 */
function prepare(): Prepared {
  const s = app.session!;
  const snapshots = new Map<PartStore, SaveSnapshot>();
  const parts: PartToSave[] = [];
  for (const p of s.parts.values()) {
    if (!p.dirty && !s.created) continue;
    const snap = p.saveSnapshot();
    const ch = p.pendingImageChanges();
    snapshots.set(p, snap);
    parts.push({ version: p.version, xml: snap.text, addImages: imagesToSend(ch.add), removeImages: ch.remove });
  }
  return { parts, snapshots };
}

function markAllSaved(prepared: Prepared, path: string): void {
  // 書き込んでいる間に別のファイルを開いていたら、そちらには触らない
  if (app.session?.path !== path) return;
  for (const [p, snap] of prepared.snapshots) p.markSaved(snap);
  app.session.created = false;
}

/** 構文エラーや Lint のエラーがあるときは、本当に書き込むかを確認する。 */
async function confirmErrors(action: 'save' | 'apply'): Promise<boolean> {
  const s = app.session!;
  const broken = [...s.parts.values()].some((p) => p.syncError);
  const errors = app.problems.filter((p) => p.severity === 'error').length;
  if (!broken && errors === 0) return true;
  const msg = broken ? t('XMLの構文が壊れています。このまま書き込むと、Excelでリボンが表示されません。') : t('エラーが {n} 件あります。このまま書き込むと、Excelでリボンが表示されない可能性があります。', { n: errors });
  const title = action === 'save' ? t('保存の前に確認') : t('反映の前に確認');
  const go = action === 'save' ? t('このまま保存') : t('このまま反映');
  // 危ないほうを主ボタンにしない（Enter で書き込んでしまわないように）
  return (await ask(title, msg, [{ value: 'go', label: go, danger: true }, { value: 'cancel', label: t('キャンセル'), primary: true }])) === 'go';
}

export async function save(): Promise<boolean> {
  flushPendingEdits();
  const s = app.session;
  if (!s) return false;
  if (refuseWhileBusy()) return false;
  if (!(await confirmErrors('save'))) return false;
  if (busy !== null) return false;
  const prepared = prepare();
  if (prepared.parts.length === 0) {
    toast({ kind: 'info', message: t('変更はありません') });
    return true;
  }
  setBusy('save');
  try {
    const res = await invoke('file.save', { path: s.path, parts: prepared.parts });
    markAllSaved(prepared, s.path);
    toast({ kind: 'success', message: t('保存しました'), action: res.backup && /[\\/]/.test(res.backup) ? { label: t('バックアップの場所'), run: () => void invoke('update.openPage', { url: res.backup.replace(/[\\/][^\\/]+$/, '') }).catch((e: Error) => toast({ kind: 'error', message: e.message })) } : undefined });
    return true;
  } catch (e) {
    toast({ kind: 'error', message: t('保存できませんでした：{message}', { message: (e as Error).message }) });
    return false;
  } finally {
    setBusy(null);
  }
}

let hintShown = false;

export async function applyToExcel(): Promise<void> {
  flushPendingEdits();
  const s = app.session;
  if (!s) return;
  if (refuseWhileBusy()) return;
  if (!(await confirmErrors('apply'))) return;
  if (app.info.excelInstalled && !app.settings.ribbonErrorsHintShown && !hintShown) {
    hintShown = true;
    await ask(
      t('リボンのエラーを表示する設定'),
      t('リボンのXMLに誤りがあると、Excelは何も言わずにリボンを表示しません。原因を確認できるよう、Excelの［ファイル］→［オプション］→［詳細設定］→［全般］にある「アドインのユーザー インターフェイス エラーを表示する」をオンにすることをおすすめします（Sashはこの設定を変更しません）。'),
      [{ value: 'ok', label: t('わかりました'), primary: true }],
    );
    app.settings = await invoke('settings.set', { ribbonErrorsHintShown: true }).catch(() => app.settings);
  }
  if (busy !== null || app.session !== s) return;

  setBusy('apply');
  const progress = toast({ kind: 'info', message: app.info.excelInstalled ? t('Excelへ反映しています…') : t('ファイルに書き込んでいます…'), timeout: 0 });
  try {
    let prepared = prepare();
    let res = await invoke('excel.apply', { path: s.path, parts: prepared.parts, saveIfDirty: false, activateTab: tabIdToActivate() ?? undefined });
    if (res.status === 'needsSave') {
      progress.close();
      const r = await ask(t('Excel側に未保存の変更があります'), t('{file} はExcelで開かれていて、未保存の変更があります。Excelで保存してから反映しますか？', { file: fileNameOf(s.path) }), [
        { value: 'cancel', label: t('中止') },
        { value: 'go', label: t('保存して反映'), primary: true },
      ]);
      if (r !== 'go') {
        toast({ kind: 'info', message: t('反映を中止しました') });
        return;
      }
      prepared = prepare();
      res = await invoke('excel.apply', { path: s.path, parts: prepared.parts, saveIfDirty: true, activateTab: tabIdToActivate() ?? undefined });
    }
    if (res.status === 'applied' || res.status === 'written' || res.status === 'blocked') markAllSaved(prepared, s.path);
    progress.update({ kind: res.status === 'blocked' ? 'warning' : 'success', message: res.message });
  } catch (e) {
    progress.update({ kind: 'error', message: t('反映できませんでした：{message}', { message: (e as Error).message }) });
  } finally {
    setBusy(null);
  }
}

// ---- バックアップから戻す ----

/** バックアップの内容でファイルを置き換え、開き直す。 */
export async function restoreBackup(backupPath: string): Promise<boolean> {
  const s = app.session;
  if (!s) return false;
  if (refuseWhileBusy()) return false;
  const path = s.path;
  setBusy('save');
  try {
    const res = await invoke('backup.restore', { path, backupPath });
    setBusy(null);
    await openFile(path, { force: true });
    toast({ kind: 'success', message: res?.backup ? t('バックアップから戻しました。戻す前のファイルもバックアップしてあります') : t('バックアップから戻しました') });
    return true;
  } catch (e) {
    toast({ kind: 'error', message: t('戻せませんでした：{message}', { message: (e as Error).message }) });
    return false;
  } finally {
    setBusy(null);
  }
}

// ---- .sash.json の書き出し・読み込み ----

export async function exportSashFile(): Promise<void> {
  flushPendingEdits();
  const s = app.session;
  if (!s) return;
  const name = fileNameOf(s.path);
  const base = name.replace(/\.[^.]+$/, '');
  try {
    const saved = await invoke('file.exportText', { defaultName: `${base}.sash.json`, filter: `${t('Sash のリボン定義 (*.sash.json)')}|*.sash.json`, content: exportSash([...s.parts.values()], name) });
    if (saved) toast({ kind: 'success', message: t('リボン定義を書き出しました：{path}', { path: saved }) });
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
}

export function importSashFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.sash.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void file.text().then(applySash).catch((e: Error) => toast({ kind: 'error', message: t('読み込めませんでした：{message}', { message: e.message }) }));
  });
  input.click();
}

async function applySash(text: string): Promise<void> {
  const s = app.session;
  if (!s) return;
  const data = parseSash(text);
  const target = s.active;
  const part = data.parts.find((p) => p.version === target.version) ?? data.parts[0]!;
  const r = await ask(t('リボン定義を読み込む'), t('編集中の {part} を、{source} のリボン定義（画像 {n} 個を含む）で置き換えます。元に戻す（Ctrl+Z）で取り消せます。', { part: target.version === 'office2010' ? 'customUI14' : 'customUI', source: data.source ?? t('ファイル'), n: part.images.length }), [
    { value: 'cancel', label: t('キャンセル') },
    { value: 'ok', label: t('置き換える'), primary: true },
  ]);
  if (r !== 'ok') return;
  target.replaceAll(partXml(part), part.images.map((i) => ({ id: i.id, dataUrl: `data:${i.contentType};base64,${i.base64}`, isNew: true })));
  toast({
    kind: part.version !== target.version ? 'warning' : 'success',
    message: part.version !== target.version ? t('形式（2007 / 2010以降）が違うリボン定義を読み込みました。名前空間を確認してください') : t('リボン定義を読み込みました'),
    action: { label: t('元に戻す'), run: () => target.undo() },
  });
}
