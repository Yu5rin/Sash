import { afterEach, describe, expect, it } from 'vitest';
import { reportLateApply } from '../src/shell/fileOps';
import { clearToasts } from '../src/shell/toast';

describe('待つのをやめたあとに届いた反映の結果（見直し 中8）', () => {
  afterEach(() => {
    clearToasts();
    document.body.replaceChildren();
  });

  it('needsSave は緑の成功にせず、警告で「保存して反映」のやり直しを案内する', () => {
    reportLateApply({ status: 'needsSave', message: 'Excel 側に未保存の変更があります' });
    const el = document.querySelector('.toast')!;
    expect(el.classList.contains('success')).toBe(false);
    expect(el.classList.contains('warning')).toBe(true);
    expect(el.textContent).toContain('保存して反映');
  });

  it('applied・written は成功、blocked は警告', () => {
    reportLateApply({ status: 'applied', message: 'ok' });
    expect(document.querySelector('.toast.success')).not.toBeNull();
    clearToasts();
    reportLateApply({ status: 'blocked', message: '保護ビュー' });
    expect(document.querySelector('.toast.warning')).not.toBeNull();
  });
});
