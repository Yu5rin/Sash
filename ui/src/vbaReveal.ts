// VBE の該当の Sub へ移る（仕様書 §18.5）と、選んだコントロールのマクロを Excel で実行する「試しに押す」（§18.4）。
// コールバック一覧（views/bottom.ts）・キャンバスの右クリックメニュー・コマンドパレットから呼ぶ。
// 「マクロを Excel で試す」の実行中は、ホストが Excel を使うほかの要求をすぐに断る（COM のスレッドがふさがるため。§18.4）。

import { app } from './app';
import { invoke } from './bridge';
import { notifyIfSlow } from './shell/slowCall';
import { vba } from './callbacks';
import { t } from './i18n';
import { ask } from './dialogs/modal';
import { callbackSignature } from './schema';
import { DEFAULT_TIMEOUT, toast } from './shell/toast';
import { bareCallbackName, isCallbackName, parseParams } from './vba';

/** VBA の読み書きは、Excel が応答しないと返らない。15 秒を超えたら知らせる（総点検 W-5）。 */
const vbaInvoke: typeof invoke = (type, payload) => notifyIfSlow(invoke(type, payload));

/** VBE で表示できるか（Excel があり、VBA と照合できていて、そのコールバックの Sub が VBA にある）。 */
export function canRevealInVbe(name: string): boolean {
  if (!app.session || vba.status !== 'ok') return false;
  const bare = bareCallbackName(name).toLowerCase();
  return vba.statuses().some((s) => s.procedure && s.procedure.name.toLowerCase() === bare);
}

/**
 * コールバック名（"Module1.Name" などの書き方も可）の Sub を VBE で表示する。
 * どのモジュールにあるかは、照合のときに読んだ VBA（vba.statuses()）から決める。読めていなければ理由を知らせる。
 */
export async function revealInVbe(name: string): Promise<boolean> {
  const s = app.session;
  if (!s) return false;
  if (vba.status !== 'ok') {
    toast({ kind: 'warning', message: vba.statusMessage() || t('VBA を読み込んでから、もう一度やり直してください') });
    return false;
  }
  const bare = bareCallbackName(name).toLowerCase();
  const proc = vba.statuses().find((x) => x.procedure && x.procedure.name.toLowerCase() === bare)?.procedure;
  if (!proc) {
    toast({ kind: 'warning', message: t('{name} は VBA にありません。先に雛形を挿入してください', { name }) });
    return false;
  }
  try {
    await vbaInvoke('vba.reveal', { path: s.path, module: proc.module, procedure: proc.name });
    return true;
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
    return false;
  }
}

/** Application.Run での呼び方。none は引数なし、control は control 引数に Nothing を渡す。 */
export type MacroArgument = 'none' | 'control';

/** 実行できるか確かめた結果。ok でなければ reason に理由。 */
export type RunCheck = { ok: true; macro: string; argument: MacroArgument } | { ok: false; reason: string };

/** 引数リストから呼び方を決める（ホストの VbaProcedureLookup.Classify と同じ決まり）。呼べなければ理由。 */
export function macroArgument(params: string): { ok: true; argument: MacroArgument } | { ok: false; reason: string } {
  const list = parseParams(params);
  if (list.length === 0) return { ok: true, argument: 'none' };
  if (list.length > 1) return { ok: false, reason: t('引数が {n} つ（{params}）あるため、Sash からは実行できません。', { n: list.length, params: params.trim() }) };
  const p = list[0]!;
  if (!p.array && (p.type === 'iribboncontrol' || p.type === 'object' || p.type === 'variant')) return { ok: true, argument: 'control' };
  return { ok: false, reason: t('引数の形（{params}）が IRibbonControl ではないため、Sash からは実行できません。', { params: params.trim() }) };
}

/**
 * 選んだ要素の onAction を Sash から実行できるかを判断する（仕様書 §18.4）。
 * 引数のない Sub はそのまま、IRibbonControl を 1 つ受け取る Sub は control に Nothing を渡して実行する。それ以外の形は断る。
 * 照合済みの VBA があれば宣言から、なければ XML のコールバックの形（toggleButton の onAction は 2 つの引数、など）から決める。
 * ホストも VBA を読めれば宣言から決め直す（こちらは押す前に理由を見せるためのもの）。
 */
export function checkRunnable(el: Element | null): RunCheck {
  const macro = el?.getAttribute('onAction');
  if (!el || !macro) return { ok: false, reason: t('選択中のコントロールに onAction がありません') };
  if (!isCallbackName(macro)) return { ok: false, reason: t('{name} は VBA の名前として正しくないため、実行できません。', { name: macro }) };
  const params = vba.status === 'ok'
    ? vba.statuses().find((x) => x.procedure && x.procedure.name.toLowerCase() === bareCallbackName(macro).toLowerCase())?.procedure?.params
    : callbackSignature('onAction', el.localName);
  if (params === undefined) return { ok: false, reason: t('{name} は VBA にありません。先に雛形を挿入してください', { name: macro }) };
  const shape = macroArgument(params);
  if (!shape.ok) return { ok: false, reason: `${shape.reason} ${t('Excel のリボンから押して試してください。')}` };
  return { ok: true, macro, argument: shape.argument };
}

/** マクロを使えない理由（Excel がない・ファイルがない・形が合わない）。使えるなら ''。メニューの無効の理由に使う。 */
export function runMacroDisabledReason(el: Element | null): string {
  if (!app.info.excelInstalled) return t('Excel が見つからないため使えません');
  if (!app.session?.path) return t('保存したファイルを Excel で開いているときだけ使えます（サンプルでは使えません）');
  const c = checkRunnable(el);
  return c.ok ? '' : c.reason;
}

/** 選んだコントロールのマクロを Excel で試す。 */
export function runSelectedMacro(): Promise<void> {
  const el = app.store?.selectedElement ?? null;
  return el ? runMacroFor(el) : Promise.resolve();
}

/** 実行中に出したままにする通知。マクロが MsgBox やエラーで止まると、閉じるまで戻ってこないため。 */
const RUNNING_MESSAGE = () => t('Excel でマクロを実行中です（Excel 側でメッセージやエラーを閉じると戻ります）');

/** 要素の onAction を Excel で実行する。右クリックメニューからは、選択を待たずに要素を渡す。 */
export async function runMacroFor(el: Element): Promise<void> {
  const s = app.session;
  if (!s) return;
  const reason = runMacroDisabledReason(el);
  const check = checkRunnable(el);
  if (reason || !check.ok) {
    toast({ kind: 'warning', message: reason || (check.ok ? '' : check.reason) });
    return;
  }
  if (check.argument === 'control') {
    // IRibbonControl は Sash から作れないので Nothing を渡す。Sub の中で control を使うと止まるので、押す前に知らせる
    const go = await ask(
      t('マクロを Excel で試す'),
      t('{name} を実行します。control 引数には Nothing を渡します。Sub の中で control.Id などを使うと実行時エラーになります。', { name: check.macro }),
      [{ value: 'run', label: t('実行する'), primary: true }, { value: 'cancel', label: t('キャンセル') }],
    );
    if (go !== 'run') return;
  }
  const running = toast({ kind: 'info', message: RUNNING_MESSAGE(), timeout: 0 });
  try {
    await invoke('excel.runMacro', { path: s.path, macro: check.macro, controlId: el.getAttribute('id') ?? undefined, argument: check.argument });
    running.update({ kind: 'success', message: t('{name} を実行しました', { name: check.macro }), timeout: DEFAULT_TIMEOUT.success });
  } catch (e) {
    running.update({ kind: 'error', message: (e as Error).message, timeout: 0 });
  }
}
