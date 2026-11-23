// 「Excel をプレビューの幅にする」（仕様書 §18.1）。キャンバスの見出しの「表示」メニューと、外枠の 表示 メニュー・
// コマンドパレットの両方から呼ぶので、ここに一つだけ置く（どこから押しても同じ断り方・同じ知らせ方にするため）。

import { app } from '../app';
import { invoke } from '../bridge';
import { t } from '../i18n';
import { toast } from '../shell/toast';
import { preview } from './ribbonPreview';

/** 押せないときの理由（押せるなら ''）。メニューに無効の理由として出す。 */
export function excelWidthDisabledReason(): string {
  if (!app.info.excelInstalled) return t('Excel が見つからないため使えません');
  if (preview().width === null) return t('先に「画面の幅」を選んでください');
  return '';
}

/**
 * Excel のウィンドウを、プレビューで選んでいる幅に合わせる。開いているファイルの Excel を対象にする。
 * サンプル（パスが空）のときはパスを送らない（空のパスでブックを探させないため。起動中の最初の Excel が対象になる）。
 * ホストが測った実際の幅が狙いとずれたときは、その幅も知らせる。
 */
export async function fitExcelToPreview(): Promise<void> {
  const p = preview();
  const reason = excelWidthDisabledReason();
  if (reason) {
    toast({ kind: 'warning', message: reason });
    return;
  }
  const width = p.width!;
  try {
    const r = await invoke('excel.setWindowWidth', { width, scale: p.scale, path: app.session?.path || undefined });
    const base = t('Excel のウィンドウを {w} 幅（拡大率 {s}%）に合わせました（{pt} pt）', { w: width, s: p.scale, pt: Math.round(r.points) });
    // 実際の幅（物理 px）が 2px より大きくずれたら、測った値を添える（Windows が最小の幅などで縮めた場合）
    const off = r.actualWidth !== undefined && r.expectedWidth !== undefined && Math.abs(r.actualWidth - r.expectedWidth) > 2;
    toast({
      kind: off ? 'warning' : 'success',
      message: off ? `${base} ${t('ただし実際の幅は {a}px でした（狙いは {e}px）', { a: r.actualWidth!, e: r.expectedWidth! })}` : base,
    });
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
}
