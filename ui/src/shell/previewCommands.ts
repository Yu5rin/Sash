// キャンバスの幅のプレビューを、メニュー・コマンドパレットから切り替える（表示 メニューの「リボンの幅」「拡大率」。仕様書 §18.7）。
// 設定の持ち主はキャンバス（views/canvas.ts・views/ribbonPreview.ts）。ここではキャンバスの切り替えを呼ぶだけにする。

import { t } from '../i18n';
import { setFitMode, setPreviewScale, setPreviewWidth, toggleKeytips } from '../views/canvas';
import { SCALE_CHOICES, WIDTH_CHOICES } from '../views/ribbonFit';
import { preview, type PreviewSettings } from '../views/ribbonPreview';

export { SCALE_CHOICES, WIDTH_CHOICES };
export { fitExcelToPreview } from '../views/excelWidth';

/**
 * プレビューの設定を変える。キャンバスの切り替え（setPreviewWidth など）を直接呼ぶ。
 * 先に設定だけを書き換えてからキャンバスに知らせると、キャンバスは「変わっていない」とみなして
 * 一時的に広げたグループを畳み直さず、描き直しも二度になるため。
 */
export function changePreview(patch: Partial<Pick<PreviewSettings, 'width' | 'scale' | 'fit' | 'keytips'>>): void {
  if ('width' in patch && patch.width !== undefined) setPreviewWidth(patch.width);
  if (patch.scale !== undefined) setPreviewScale(patch.scale);
  if (patch.fit !== undefined) setFitMode(patch.fit);
  if (patch.keytips !== undefined && patch.keytips !== preview().keytips) toggleKeytips();
}

export function currentPreview(): Readonly<PreviewSettings> {
  return preview();
}

/** 幅の表記（「自由」または「1920 px」）。 */
export function widthChoiceLabel(width: number | null): string {
  return width === null ? t('自由（キャンバスの幅）') : t('{w} px', { w: width });
}

