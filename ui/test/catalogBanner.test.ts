import { describe, expect, it } from 'vitest';
import { iconBanner } from '../src/dialogs/catalogDialog';
import { imageMsoNames } from '../src/catalog/catalog';
import type { IconPrefetchStatus } from '../src/bridge';

const status = (patch: Partial<IconPrefetchStatus>): IconPrefetchStatus => ({ state: 'none', done: 0, total: 0, size: 32, cached: 0, excelInstalled: true, ...patch });

describe('カタログのアイコンの案内', () => {
  it('取り込み済みなら出さない', () => {
    expect(iconBanner(status({ state: 'done', cached: 2000 }), true, true)).toBeNull();
  });

  it('未取り込みで Excel があれば、理由と取り込むボタンを出す', () => {
    const b = iconBanner(status({ state: 'none' }), true, true);
    expect(b?.canStart).toBe(true);
    expect(b?.text).toContain('まだ取り込まれていません');
  });

  it('取り込み中は進み具合を出し、ボタンは出さない', () => {
    const b = iconBanner(status({ state: 'running', done: 10, total: 100 }), true, true);
    expect(b?.canStart).toBe(false);
    expect(b?.text).toContain('10 / 100');
  });

  it('Excel がなくキャッシュもなければ、取り込めない理由だけを出す', () => {
    const b = iconBanner(status({ state: 'unavailable', excelInstalled: false }), false, false);
    expect(b?.canStart).toBe(false);
    expect(b?.text).toContain('Excel が見つからない');
    expect(iconBanner(status({ state: 'none', cached: 50, excelInstalled: false }), true, false)).toBeNull();
  });

  it('失敗したら理由とやり直しのボタンを出す', () => {
    const b = iconBanner(status({ state: 'failed', message: '起動できない' }), true, true);
    expect(b).toEqual({ text: '取り込めませんでした：起動できない', canStart: true });
  });
});

describe('取り込む名前', () => {
  it('重複がなく、画像を持たない種類（タブなど）を含まない', () => {
    const names = imageMsoNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('AutoSum');
    expect(names).not.toContain('TabHome');
  });
});
