// ファイルを開く・保存・Excel へ反映・閉じる・終了。
// - 保存と反映は一度に 1 つだけ走らせる（連打や F5 と Ctrl+S の同時押しで、同じファイルに二重に書き込まないように）
// - 保存の前に saveSnapshot() を取り、書き込みが終わったら markSaved(snapshot) を呼ぶ。保存中に加えた編集は未保存のまま残る
// - 未保存の変更があるときは、閉じる・別のファイルを開く・終了の前に「保存する／保存しない／キャンセル」を聞く

import { app } from '../app';
import { invoke, type ApplyResult, type Fingerprint, type PartToSave } from '../bridge';
import { ask } from '../dialogs/modal';
import { askExternalChange } from '../dialogs/externalChangeDialog';
import { askRecovery } from '../dialogs/recoveryDialog';
import { checkExternalChange, isWatchable, refreshBaseline } from '../externalChange';
import { applyRecovery, discardCurrentRecovery, discardRecovery, readRecovery } from '../recovery';
import { t } from '../i18n';
import { exportSash, parseSash, partXml } from '../sashJson';
import { isSampleSession } from '../sample';
import type { PartStore, SaveSnapshot } from '../store';
import { focus as focusCanvas, tabIdToActivate } from '../views/canvas';
import { imagesToSend } from './compat';
import { splitPath } from './text';
import { slowMessage, STOPPED_WAITING, waitStoppable } from './slowCall';
import { toast, type ToastHandle } from './toast';

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
  toast({ kind: 'info', message: busy === 'apply' ? t('Excel への反映が終わるまでお待ちください') : busy === 'save' ? t('保存が終わるまでお待ちください') : t('ファイルを開いています。終わるまでお待ちください') });
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
/** 入力中でまだ確定していない欄を確定する（窓に戻ったときの検知など、外から編集の有無を見る前に呼ぶ）。 */
export function flushEdits(): void {
  flushPendingEdits();
}

export function setPendingEditFlusher(fn: () => void): void {
  flushPendingEdits = fn;
}

/** 未保存の変更を捨ててよいか。保存を選んだら保存し、成功したら true。 */
export async function confirmDiscard(): Promise<boolean> {
  flushPendingEdits();
  if (!app.dirty || !app.session) return true;
  if (refuseWhileBusy()) return false;
  // サンプルは保存できないので、「保存する」は出さずに捨ててよいかだけを聞く（「保存しない」では、保存できるように読めるため）
  if (isSampleSession()) {
    const d = await ask(t('未保存の変更があります'), t('サンプルへの変更は保存できません。破棄しますか？'), [
      { value: 'discard', label: t('破棄する'), danger: true },
      { value: 'cancel', label: t('キャンセル'), primary: true },
    ]);
    return d === 'discard';
  }
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
  else if (s.parts.size >= 2) toast({ kind: 'info', message: t('customUI と customUI14 の両方があります。2010以降の Excel は customUI14 を優先します') });
  await offerRecovery(s);
  return true;
}

/** 前回、保存されなかった編集の退避が残っていれば、復旧するか捨てるかを聞く（§23.2）。退避を読めなくても、開くことは止めない。 */
async function offerRecovery(s: NonNullable<typeof app.session>): Promise<void> {
  if (!s.path || isSampleSession()) return;
  let entry;
  try {
    // 書く・消すと同じ待ち行列で読む（開き直した直後に、捨てたはずの退避を読んで復旧を聞かないように）
    entry = await readRecovery(s.path);
  } catch {
    return;
  }
  // 読んでいる間に別のファイルへ替わっていたら、聞かない
  if (!entry || app.session !== s) return;
  if (entry.parts.length === 0) {
    await discardRecovery(s.path);
    return;
  }
  const choice = await askRecovery(entry);
  if (app.session !== s) return;
  if (choice === 'discard') {
    await discardRecovery(s.path);
    toast({ kind: 'info', message: t('保存されなかった編集を捨てました') });
    return;
  }
  const r = applyRecovery(entry);
  if (r.missing.length) toast({ kind: 'warning', message: t('ファイルにないパーツがあったため、一部は復旧できませんでした') });
  if (r.applied.length) toast({ kind: 'success', message: t('保存されなかった編集を復旧しました。内容を確かめて保存してください'), action: { label: t('元に戻す'), run: () => { for (const store of r.stores) store.undo(); } } });
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
    // 保存した・「保存しない」を選んだ。残す編集はないので退避を消してから終わる
    await discardCurrentRecovery();
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

/**
 * 書き込みが終わったときの記録。fingerprint はホストが書いたあとに読み直した照合値（保存のとき）。
 * 渡されなければ（Excel 経由の反映など）、ファイルを読み直して基準にする（自分が書いた内容を「ほかの変更」と取り違えないため。§23.4）。
 */
function markAllSaved(prepared: Prepared, path: string, fingerprint?: Fingerprint | null): void {
  // 書き込んでいる間に別のファイルを開いていたら、そちらには触らない
  if (app.session?.path !== path) return;
  for (const [p, snap] of prepared.snapshots) p.markSaved(snap);
  app.session.created = false;
  if (fingerprint !== undefined) app.session.fingerprint = fingerprint;
  // 自分が書き込んだときだけ基準を取り直す。書き込むものがなかったとき（編集なしの反映）に取り直すと、
  // ほかの変更を照合しないまま「基準」にしてしまい、次の保存で黙って上書きする
  else if (prepared.parts.length > 0) void refreshBaseline(app.session);
}

/**
 * 書き込む前に、開いたあとにほかでリボンが変更されていないかを確かめる（§23.4）。
 * 変わっていれば確認を出し、上書きを選んだときだけ 'go'（書き込みを続ける）。ほかの変更を読み込んだときは、読み直して 'stop'。
 */
async function guardExternalChange(s: NonNullable<typeof app.session>, context: 'save' | 'apply'): Promise<'go' | 'stop'> {
  if (!isWatchable(s)) return 'go';
  const { state } = await checkExternalChange(s);
  if (state !== 'changed' || app.session !== s) return 'go';
  const choice = await askExternalChange(s, context);
  if (choice === 'overwrite') return 'go';
  if (choice === 'reload') await reloadFromDisk(s);
  return 'stop';
}

/** 自分の編集を捨てて、ファイルの今の内容を読み直す（ほかで変更されたとき）。 */
export async function reloadFromDisk(s: NonNullable<typeof app.session>): Promise<boolean> {
  if (app.session !== s) return false;
  const ok = await openFile(s.path, { force: true });
  if (ok) toast({ kind: 'success', message: t('ほかで変更された内容を読み込みました') });
  return ok;
}

/** 構文エラーや Lint のエラーがあるときは、本当に書き込むかを確認する。 */
async function confirmErrors(action: 'save' | 'apply'): Promise<boolean> {
  const s = app.session!;
  const broken = [...s.parts.values()].some((p) => p.syncError);
  const errors = app.problems.filter((p) => p.severity === 'error').length;
  if (!broken && errors === 0) return true;
  const msg = broken ? t('XML の構文が壊れています。このまま書き込むと、Excel でリボンが表示されません。') : t('エラーが {n} 件あります。このまま書き込むと、Excel でリボンが表示されない可能性があります。', { n: errors });
  const title = action === 'save' ? t('保存の前に確認') : t('反映の前に確認');
  const go = action === 'save' ? t('このまま保存') : t('このまま反映');
  // 危ないほうを主ボタンにしない（Enter で書き込んでしまわないように）
  return (await ask(title, msg, [{ value: 'go', label: go, danger: true }, { value: 'cancel', label: t('キャンセル'), primary: true }])) === 'go';
}

export async function save(): Promise<boolean> {
  flushPendingEdits();
  const s = app.session;
  // 同梱のサンプルはファイルがないので保存できない（パスが空のまま書き込もうとしない）
  if (isSampleSession()) { toast({ kind: 'info', message: t('サンプルは保存できません。自分のブックで作るときは、Excel で保存した .xlsm / .xlam を開いてください') }); return false; }
  if (!s) return false;
  if (refuseWhileBusy()) return false;
  if (!(await confirmErrors('save'))) return false;
  if (busy !== null) return false;
  const prepared = prepare();
  if (prepared.parts.length === 0) {
    toast({ kind: 'info', message: t('変更はありません') });
    return true;
  }
  // ほかで書き換えられていたら、書く前に知らせる（確認の間は、ほかの保存・反映が始まらないよう、終わってからもう一度確かめる）
  if ((await guardExternalChange(s, 'save')) === 'stop') return false;
  if (busy !== null || app.session !== s) return false;
  setBusy('save');
  try {
    const res = await invoke('file.save', { path: s.path, parts: prepared.parts });
    markAllSaved(prepared, s.path, res.fingerprint ?? null);
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

/**
 * 待つのをやめたあとで届いた反映の結果を知らせる。成功（applied・written）だけ緑にする。
 * needsSave は反映されていないので、緑にせず、「保存して反映」のやり直しを案内する（確認の画面は、別の操作中かもしれないここでは出さない）。
 */
export function reportLateApply(res: ApplyResult): void {
  if (res.status === 'needsSave') {
    toast({ kind: 'warning', timeout: 0, message: t('反映されていません。Excel 側に未保存の変更があります。もう一度［Excel へ反映］を押して、「保存して反映」を選んでください') });
    return;
  }
  toast({ kind: res.status === 'applied' || res.status === 'written' ? 'success' : 'warning', message: res.message });
}

/**
 * Excel への反映の呼び出し。15 秒を超えたら「Excel の応答を待っています」に変えて［待つのをやめる］を出す（総点検 W-5）。
 * やめても、ホストの処理は続く。結果が届いたら、そのときに知らせ、成功なら保存済みの印も付ける
 * （結果が届くまでは付けない。反映できたか分からないため）。
 */
async function callApply(s: NonNullable<typeof app.session>, prepared: Prepared, saveIfDirty: boolean, progress: ToastHandle): Promise<ApplyResult | typeof STOPPED_WAITING> {
  const call = invoke('excel.apply', { path: s.path, parts: prepared.parts, saveIfDirty, activateTab: tabIdToActivate() ?? undefined });
  return waitStoppable(call, {
    onSlow: (stop) => progress.update({ kind: 'warning', timeout: 0, message: slowMessage(), action: { label: t('待つのをやめる'), run: stop } }),
    onLate: (outcome) => {
      if ('error' in outcome) {
        toast({ kind: 'error', message: t('反映できませんでした：{message}', { message: (outcome.error as Error).message }) });
        return;
      }
      const res = outcome.value;
      if ((res.status === 'applied' || res.status === 'written' || res.status === 'blocked') && app.session === s) markAllSaved(prepared, s.path);
      reportLateApply(res);
    },
  });
}

export async function applyToExcel(): Promise<void> {
  flushPendingEdits();
  const s = app.session;
  // 同梱のサンプルは Excel で開かれたファイルがないので反映できない
  if (isSampleSession()) { toast({ kind: 'info', message: t('サンプルは保存できません。自分のブックで作るときは、Excel で保存した .xlsm / .xlam を開いてください') }); return; }
  if (!s) return;
  if (refuseWhileBusy()) return;
  if (!(await confirmErrors('apply'))) return;
  if (app.info.excelInstalled && !app.settings.ribbonErrorsHintShown && !hintShown) {
    hintShown = true;
    await ask(
      t('リボンのエラーを表示する設定'),
      t('リボンの XML に誤りがあると、Excel は何も言わずにリボンを表示しません。原因を確認できるよう、Excel の［ファイル］→［オプション］→［詳細設定］→［全般］にある「アドインのユーザー インターフェイス エラーを表示する」をオンにすることをおすすめします（Sashはこの設定を変更しません）。'),
      [{ value: 'ok', label: t('わかりました'), primary: true }],
    );
    app.settings = await invoke('settings.set', { ribbonErrorsHintShown: true }).catch(() => app.settings);
  }
  if (busy !== null || app.session !== s) return;
  // 反映は、自分の編集があるときだけ、ファイルのリボンを書き換える。ほかで変更されていたら、上書きする前に知らせる
  if (app.dirty && (await guardExternalChange(s, 'apply')) === 'stop') return;
  if (busy !== null || app.session !== s) return;

  setBusy('apply');
  const progress = toast({ kind: 'info', message: app.info.excelInstalled ? t('Excel へ反映しています…') : t('ファイルに書き込んでいます…'), timeout: 0 });
  try {
    let prepared = prepare();
    let res = await callApply(s, prepared, false, progress);
    if (res === STOPPED_WAITING) {
      progress.close();
      toast({ kind: 'info', message: t('待つのをやめました。反映の結果は、Excel の応答が戻ったあとで知らせます') });
      return;
    }
    if (res.status === 'needsSave') {
      progress.close();
      const r = await ask(t('Excel 側に未保存の変更があります'), t('{file} は Excel で開かれていて、未保存の変更があります。Excel で保存してから反映しますか？', { file: fileNameOf(s.path) }), [
        { value: 'cancel', label: t('中止') },
        { value: 'go', label: t('保存して反映'), primary: true },
      ]);
      if (r !== 'go') {
        toast({ kind: 'info', message: t('反映を中止しました') });
        return;
      }
      prepared = prepare();
      const second = await callApply(s, prepared, true, progress);
      if (second === STOPPED_WAITING) {
        progress.close();
        toast({ kind: 'info', message: t('待つのをやめました。反映の結果は、Excel の応答が戻ったあとで知らせます') });
        return;
      }
      res = second;
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
