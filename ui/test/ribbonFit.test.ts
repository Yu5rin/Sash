import { afterEach, describe, expect, it } from 'vitest';
import {
  availableForGroups, DEFAULT_CHECK_WIDTHS, effectiveWidth, fitProblems, getCheckWidths, getFitReport, RIBBON_RESERVED_PX, setCheckWidths, setFitReport, simulateFit,
  type FitGroupInput, type FitReport,
} from '../src/views/ribbonFit';
import { duplicateKeytips, screentipContent } from '../src/views/ribbonTips';

const g = (id: string, large: number, opts: Partial<{ small: number; nolabel: number; collapsed: number; autoScale: boolean }> = {}): FitGroupInput => ({
  id,
  widths: { large, small: opts.small ?? large, nolabel: opts.nolabel ?? opts.small ?? large, collapsed: opts.collapsed ?? 50 },
  autoScale: opts.autoScale ?? false,
});

describe('effectiveWidth', () => {
  it('画面の幅を拡大率で割る', () => {
    expect(effectiveWidth(1920, 100)).toBe(1920);
    expect(effectiveWidth(1920, 125)).toBe(1536);
    expect(effectiveWidth(1920, 150)).toBe(1280);
    expect(effectiveWidth(1366, 125)).toBe(1093);
  });
  it('グループを並べられる幅は右端の余白を引く', () => {
    expect(availableForGroups(1366)).toBe(1366 - RIBBON_RESERVED_PX);
    expect(availableForGroups(10)).toBe(0);
  });
});

describe('simulateFit', () => {
  it('入るなら何も縮めない', () => {
    const r = simulateFit([g('a', 100), g('b', 200)], 300);
    expect(r.fits).toBe(true);
    expect(r.groups.map((x) => x.state)).toEqual(['large', 'large']);
    expect(r.groups.map((x) => x.left)).toEqual([0, 100]);
    expect(r.used).toBe(300);
  });

  it('autoScale のグループを右から small にしてから、ラベルを消す', () => {
    const groups = [g('a', 200, { small: 150, nolabel: 100, autoScale: true }), g('b', 200, { small: 150, nolabel: 100, autoScale: true })];
    // 右（b）だけ small で入る
    expect(simulateFit(groups, 350).groups.map((x) => x.state)).toEqual(['large', 'small']);
    // 両方 small で入る（ラベルを消す前に、全部を small にする）
    expect(simulateFit(groups, 300).groups.map((x) => x.state)).toEqual(['small', 'small']);
    // 右のラベルを消して入る
    expect(simulateFit(groups, 250).groups.map((x) => x.state)).toEqual(['small', 'nolabel']);
  });

  it('autoScale でないグループは縮めずに、右から畳む', () => {
    const groups = [g('a', 200), g('b', 200), g('c', 200)];
    const r = simulateFit(groups, 480);
    expect(r.groups.map((x) => x.state)).toEqual(['large', 'large', 'collapsed']);
    expect(r.fits).toBe(true);
    expect(simulateFit(groups, 320).groups.map((x) => x.state)).toEqual(['large', 'collapsed', 'collapsed']);
  });

  it('縮めても入らなければ、畳みに進む', () => {
    const groups = [g('a', 200, { small: 180, autoScale: true }), g('b', 200)];
    const r = simulateFit(groups, 260);
    expect(r.groups.map((x) => x.state)).toEqual(['small', 'collapsed']);
    expect(r.used).toBe(230);
  });

  it('畳んでも入らなければ、右からはみ出すものに印を付ける', () => {
    const r = simulateFit([g('a', 200), g('b', 200), g('c', 200)], 90);
    expect(r.fits).toBe(false);
    expect(r.groups.map((x) => x.state)).toEqual(['collapsed', 'collapsed', 'collapsed']);
    expect(r.groups.map((x) => x.clipped)).toEqual([false, true, true]);
  });

  it('幅が減らない段は飛ばす（畳むと広くなるグループは畳まない）', () => {
    const r = simulateFit([g('a', 40, { collapsed: 60 }), g('b', 200)], 100);
    expect(r.groups.map((x) => x.state)).toEqual(['large', 'collapsed']);
  });

  it('グループがなければ入る', () => {
    expect(simulateFit([], 0)).toEqual({ groups: [], used: 0, fits: true });
  });
});

describe('確かめる幅', () => {
  afterEach(() => localStorage.clear());
  it('既定は 1920 と 1366', () => {
    expect(getCheckWidths()).toEqual([...DEFAULT_CHECK_WIDTHS]);
  });
  it('保存すると大きい順・重複なしで返し、sash:fitsettings を投げる', () => {
    let fired = 0;
    const on = () => fired++;
    window.addEventListener('sash:fitsettings', on);
    setCheckWidths([1366, 1280, 1366, 2560]);
    window.removeEventListener('sash:fitsettings', on);
    expect(getCheckWidths()).toEqual([2560, 1366, 1280]);
    expect(fired).toBe(1);
  });
  it('壊れた値なら既定に戻す', () => {
    localStorage.setItem('sash.fit.checkWidths', '{broken');
    expect(getCheckWidths()).toEqual([...DEFAULT_CHECK_WIDTHS]);
  });
});

describe('getFitReport と fitProblems', () => {
  const report: FitReport = {
    width: 1366,
    scale: 125,
    effective: 1093,
    checkedWidths: [1920, 1366],
    overflowing: [
      { path: [0, 0, 1, 0], id: 'grpMode', label: 'モード', tab: '集計', collapsedAt: 1366, noIcon: true },
      { path: [0, 0, 1, 1], id: 'grpWide', label: 'ひろい', tab: '集計', collapsedAt: 1920, clippedAt: 1366, noIcon: false },
    ],
  };

  it('変わったときだけ sash:fitreport を投げる', () => {
    let fired = 0;
    const on = () => fired++;
    window.addEventListener('sash:fitreport', on);
    setFitReport(report);
    setFitReport(JSON.parse(JSON.stringify(report)) as FitReport);
    window.removeEventListener('sash:fitreport', on);
    expect(fired).toBe(1);
    expect(getFitReport()).toEqual(report);
  });

  it('問題の文言にする（拡大率が 100% 以外なら添える）', () => {
    const ps = fitProblems(report);
    expect(ps).toEqual([
      { severity: 'info', path: [0, 0, 1, 0], message: '1366 幅（125%）で［モード］が畳まれます（目安）' },
      { severity: 'warning', path: [0, 0, 1, 0], message: '［モード］が畳まれたときのアイコンが未設定です' },
      { severity: 'warning', path: [0, 0, 1, 1], message: '1366 幅（125%）で［ひろい］が収まりません（目安）' },
    ]);
    expect(fitProblems({ ...report, scale: 100 })[0]!.message).toBe('1366 幅で［モード］が畳まれます（目安）');
  });
});

describe('ヒントとキーヒント', () => {
  const el = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml').documentElement;

  it('screentip がなければラベルを見出しにする', () => {
    expect(screentipContent(el('<button id="b" label="集計" />'), '集計')).toMatchObject({ title: '集計', body: '', dynamicTitle: false, id: 'b' });
    expect(screentipContent(el('<button id="b" screentip="見出し" supertip="本文" />'), 'x')).toMatchObject({ title: '見出し', body: '本文' });
  });

  it('getScreentip・getSupertip は VBA で決まる', () => {
    expect(screentipContent(el('<button id="b" getScreentip="a" getSupertip="b" />'), 'x')).toMatchObject({ dynamicTitle: true, dynamicBody: true, title: '', body: '' });
  });

  it('キーヒントの重なりは大文字小文字を区別せずに見つける', () => {
    expect(duplicateKeytips([{ key: '1', keytip: 'A' }, { key: '2', keytip: 'a' }, { key: '3', keytip: 'B' }, { key: '4', keytip: '' }, { key: '5', keytip: '' }])).toEqual(new Set(['1', '2']));
  });
});
