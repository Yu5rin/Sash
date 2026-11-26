// VBA との照合の印（総点検 G-12）の文言と色を決める。画面の組み立て（main.ts）から切り離してあるのはテストのため。

import { t } from '../i18n';

/** 状態の文言と色。ok は照合できていて、要対応があれば warning。Excel がない・まだ読んでいないときは出さない。 */
export function vbaChipState(status: string, issues: number): { text: string; state: 'ok' | 'warning' | 'off' } | null {
  switch (status) {
    case 'ok': return issues > 0 ? { text: t('VBA：要対応 {n}', { n: issues }), state: 'warning' } : { text: t('VBA：照合済み'), state: 'ok' };
    case 'notOpen': return { text: t('VBA：未照合'), state: 'off' };
    case 'trustDenied': return { text: t('VBA：照合できません'), state: 'warning' };
    case 'locked': return { text: t('VBA：保護されています'), state: 'off' };
    default: return null;
  }
}

