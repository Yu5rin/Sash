// 総点検の「低」の指摘への対応のうち、ほかのテストファイルに収まらない小さなもの。
import { describe, expect, it } from 'vitest';
import { PANE_ORDER } from '../src/shell/panes';
import { vbaChipState } from '../src/shell/vbaChip';

describe('G-13 F6 の順番は画面の並びに合わせる', () => {
  it('パレット → ツリー → キャンバス → XML → インスペクタ → 下部', () => {
    expect([...PANE_ORDER]).toEqual(['palette', 'tree', 'canvas', 'xml', 'inspector', 'bottom']);
  });
});

describe('G-12 VBA 照合の印', () => {
  it('照合できていれば「照合済み」、要対応があれば数を添えて警告、読めないときは理由に応じた印、Excel がないときは出さない', () => {
    expect(vbaChipState('ok', 0)).toEqual({ text: 'VBA：照合済み', state: 'ok' });
    expect(vbaChipState('ok', 3)).toEqual({ text: 'VBA：要対応 3', state: 'warning' });
    expect(vbaChipState('notOpen', 0)?.state).toBe('off');
    expect(vbaChipState('trustDenied', 0)?.state).toBe('warning');
    expect(vbaChipState('locked', 0)?.state).toBe('off');
    expect(vbaChipState('noExcel', 0)).toBeNull();
    expect(vbaChipState('idle', 0)).toBeNull();
  });
});
