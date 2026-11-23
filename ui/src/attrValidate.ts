// インスペクタの入力欄で、属性の値を確定する前に確かめる決まり（単独のインスペクタとまとめて変更で共通。仕様書 §19.3）。
// 両方が別々に確かめていると、まとめて変更のほうだけ「1 bad name!」のような値が通ってしまったため、ここに集めた。
// id の重なりのように文書の中身で決まるものは、呼び出し側で確かめる（ここは値だけで決まるものに限る）。

import type { AttrDef } from './schema';
import { isCallbackName } from './vba';
import { t } from './i18n';

/** 値に問題があればその理由、なければ null。空の値は「消す」なので確かめない。 */
export function attrValueError(d: Pick<AttrDef, 'name' | 'kind'>, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (d.kind === 'int') return /^\d+$/.test(v) ? null : t('0 以上の整数で入力してください');
  // コールバック名は「モジュール名.Sub名」「ブック!Sub名」の形も認める（isCallbackName）
  if (d.kind === 'callback') return isCallbackName(v) ? null : t('VBAのSub名として使えない文字があります');
  // keytip は 1〜3 文字（XSD の ST_Keytip）。4 文字以上だと Excel がファイルを読み込めないので、確定させない
  if (d.name === 'keytip' && [...v].length > 3) return t('keytip は3文字以内で指定してください');
  return null;
}
