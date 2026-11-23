// VBE の該当の Sub へ移る（仕様書 §18.5）と、選んだコントロールのマクロを Excel で実行する「試しに押す」（§18.4）。
// コールバック一覧（views/bottom.ts）・キャンバスの右クリックメニュー・コマンドパレットから呼ぶ。

import { app } from './app';
import { invoke } from './bridge';
import { vba } from './callbacks';
import { t } from './i18n';
import { toast } from './shell/toast';
import { bareCallbackName } from './vba';

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
    await invoke('vba.reveal', { path: s.path, module: proc.module, procedure: proc.name });
    return true;
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
    return false;
  }
}

/** 実行できるか確かめた結果。ok でなければ reason に理由。 */
export type RunCheck = { ok: true; macro: string } | { ok: false; reason: string };

/**
 * 選んだ要素の onAction を Sash から実行できるかを、照合済みの VBA から判断する。
 * Application.Run からは IRibbonControl を渡せないので、引数のない Sub だけを実行できる。
 * VBA を読めていないときは判断せず、実行してみる（ホストが読めれば宣言を調べ、読めなければ失敗の理由を返す）。
 */
export function checkRunnable(el: Element | null): RunCheck {
  const macro = el?.getAttribute('onAction');
  if (!macro) return { ok: false, reason: t('選択中のコントロールに onAction がありません') };
  if (vba.status !== 'ok') return { ok: true, macro };
  const bare = bareCallbackName(macro).toLowerCase();
  const proc = vba.statuses().find((x) => x.procedure && x.procedure.name.toLowerCase() === bare)?.procedure;
  if (!proc) return { ok: false, reason: t('{name} は VBA にありません。先に雛形を挿入してください', { name: macro }) };
  if (proc.params.trim() !== '') {
    return { ok: false, reason: `${t('{name} は引数（{params}）を取るため、Sash からは実行できません。', { name: proc.name, params: proc.params.trim() })} ${t('引数に IRibbonControl を取るマクロは、Excel のリボンから押して試してください。')}` };
  }
  return { ok: true, macro };
}

/** 選んだコントロールのマクロを Excel で実行する（試しに押す）。 */
export function runSelectedMacro(): Promise<void> {
  const el = app.store?.selectedElement ?? null;
  return el ? runMacroFor(el) : Promise.resolve();
}

/** 要素の onAction を Excel で実行する。右クリックメニューからは、選択を待たずに要素を渡す。 */
export async function runMacroFor(el: Element): Promise<void> {
  const s = app.session;
  if (!s) return;
  if (!app.info.excelInstalled) {
    toast({ kind: 'warning', message: t('Excel が見つからないため、マクロを実行できません。') });
    return;
  }
  if (!s.path) {
    toast({ kind: 'warning', message: t('このファイルは Excel で開かれていないため、マクロを実行できません。') });
    return;
  }
  const check = checkRunnable(el);
  if (!check.ok) {
    toast({ kind: 'warning', message: check.reason });
    return;
  }
  try {
    await invoke('excel.runMacro', { path: s.path, macro: check.macro, controlId: el.getAttribute('id') ?? undefined });
    toast({ kind: 'success', message: t('{name} を実行しました', { name: check.macro }) });
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
}
