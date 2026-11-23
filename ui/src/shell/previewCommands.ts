// キャンバスの幅のプレビューを、メニュー・コマンドパレットから切り替える（表示 メニューの「リボンの幅」「拡大率」。仕様書 §18.7）。
// 設定の持ち主はキャンバス（views/ribbonPreview.ts）。ここでは設定を書き換えて、キャンバスに描き直しを頼むだけにする。

import { app } from '../app';
import { invoke } from '../bridge';
import { t } from '../i18n';
import { SCALE_CHOICES, WIDTH_CHOICES } from '../views/ribbonFit';
import { preview, setPreview, type FitMode, type PreviewSettings } from '../views/ribbonPreview';
import { toast } from './toast';

export { SCALE_CHOICES, WIDTH_CHOICES };

/**
 * プレビューの設定を変えて、キャンバスに知らせる。
 * 知らせ方は window の CustomEvent 'sash:preview'（detail は { width?, scale?, mode?, keytips? }）。
 * キャンバスがまだ sash:preview を受けていない間も描き直されるよう、確かめる幅が変わったときの知らせ（sash:fitsettings）も投げる
 * （どちらもキャンバスを描き直すだけで、副作用はない）。
 */
export function changePreview(patch: Partial<Pick<PreviewSettings, 'width' | 'scale' | 'fit' | 'keytips'>>): void {
  setPreview(patch);
  const detail: { width?: number | null; scale?: number; mode?: FitMode; keytips?: boolean } = {};
  if ('width' in patch) detail.width = patch.width;
  if (patch.scale !== undefined) detail.scale = patch.scale;
  if (patch.fit !== undefined) detail.mode = patch.fit;
  if (patch.keytips !== undefined) detail.keytips = patch.keytips;
  window.dispatchEvent(new CustomEvent('sash:preview', { detail }));
  window.dispatchEvent(new CustomEvent('sash:fitsettings'));
}

export function currentPreview(): Readonly<PreviewSettings> {
  return preview();
}

/** 幅の表記（「自由」または「1920 px」）。 */
export function widthChoiceLabel(width: number | null): string {
  return width === null ? t('自由（キャンバスの幅）') : t('{w} px', { w: width });
}

/**
 * Excel のウィンドウを、プレビューで選んでいる幅に合わせる（仕様書 §18.1）。開いているファイルの Excel を対象にする。
 * 幅が「自由」のときは合わせる幅がないので、幅を選ぶよう知らせる。
 */
export async function fitExcelToPreview(): Promise<void> {
  const p = preview();
  if (p.width === null) {
    toast({ kind: 'warning', message: t('表示 メニューの「リボンの幅」で幅を選んでから、もう一度やり直してください') });
    return;
  }
  try {
    const r = await invoke('excel.setWindowWidth', { width: p.width, scale: p.scale, path: app.session?.path || undefined });
    toast({ kind: 'success', message: t('Excel のウィンドウを {w} 幅（拡大率 {s}%）に合わせました（{pt} pt）', { w: p.width, s: p.scale, pt: Math.round(r.points) }) });
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
  }
}
