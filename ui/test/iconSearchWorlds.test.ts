// 0.3.1 第 3 弾：町工場・ビジネスマン・エレベーター・エスカレーターの言葉で、妥当なアイコンが上位 5 件に出ること。
// 「拡充前の辞書に見出しがなかった語」は fixtures-headwords-before.txt（拡充前の見出しの一覧）で確かめる。
import { describe, expect, it } from 'vitest';
import before from './fixtures-headwords-before.txt?raw';
import { CONCEPTS } from '../src/fluent/iconConcepts';
import { searchIconSet } from '../src/fluent/iconSearch';
import { normalize } from '../src/fluent/iconWords';
import { allIcons, fluentIcons, tablerIcons } from './helpers/allIcons';

const oldHeads = new Set(before.split('\n').filter(Boolean));
const key = (w: string) => normalize(w).replace(/ー/g, '');
const top5 = (q: string) => searchIconSet(allIcons, q).hits.slice(0, 5).map((h) => h.icon.name);

/** [語, 上位 5 件に入っていてほしい名前（どれか）]。 */
const SHOP: readonly (readonly [string, readonly string[]])[] = [
  ['段取り替え', ['changeover']], ['山積み', ['load-capacity']], ['負荷', ['load-capacity']], ['アンドン', ['signal-tower']], ['現品票', ['item-tag']],
  ['外注', ['outsource']], ['内製', ['in-house']], ['治具', ['c-clamp']], ['研削', ['grinding-wheel']], ['板金', ['sheet-bending']], ['鋳造', ['casting-ladle']],
  ['めっき', ['plating-tank']], ['5S', ['five-s']], ['カイゼン', ['bulb', 'lightbulb']], ['ヒヤリハット', ['near-miss']], ['歩留まり', ['chart-funnel', 'percentage']],
  ['切粉', ['metal-chips']], ['ノギス', ['caliper']], ['マイクロメータ', ['caliper', 'ruler-measure']], ['マイクロメーター', ['caliper', 'ruler-measure']],
  ['熱処理', ['furnace']], ['はんだ付け', ['soldering-iron']], ['パレート図', ['pareto-chart']], ['管理図', ['control-chart']], ['リードタイム', ['lead-time']],
  ['滞留在庫', ['stagnant-stock']], ['発注点', ['reorder-point']], ['ポカヨケ', ['poka-yoke']], ['無人搬送車', ['agv']], ['保護メガネ', ['safety-goggles']],
  ['軍手', ['work-glove']], ['タイムカード', ['time-card']], ['ハンドリフト', ['pallet-jack']], ['ホイスト', ['chain-hoist']], ['天地無用', ['packing-box']],
  ['非常停止ボタン', ['emergency-stop']], ['制御盤', ['control-panel']], ['作業指示書', ['work-order']], ['油差し', ['oil-can']], ['コンプレッサー', ['gauge', 'wind']],
  ['丸棒', ['bar-stock']], ['H形鋼', ['h-beam']], ['シャッター', ['shutter']], ['エンドミル', ['end-mill']], ['やすり', ['rasp-file']], ['鋼材', ['h-beam']],
];
const BUSINESS: readonly (readonly [string, readonly string[]])[] = [
  ['ビジネスマン', ['businessperson']], ['サラリーマン', ['businessperson']], ['会社員', ['businessperson']], ['スーツ', ['tie', 'shirt', 'businessperson']], ['ネクタイ', ['tie']],
  ['名刺交換', ['business-card']], ['稟議', ['rubber-stamp', 'stamp']], ['決裁', ['rubber-stamp', 'stamp']], ['押印', ['rubber-stamp', 'stamp']], ['回覧', ['circulation']],
  ['予実', ['chart-arrows', 'chart-bar']], ['Web会議', ['video', 'device-desktop-share']], ['共有フォルダ', ['folder-share']], ['出張', ['plane', 'luggage']], ['残業', ['clock-plus', 'moon']],
  ['会議室', ['meeting-room']], ['バインダー', ['binder']], ['手形', ['promissory-note']], ['在席表示', ['user-check', 'chalkboard']], ['ホチキス', ['stapler']],
];
const ELEVATOR: readonly (readonly [string, readonly string[]])[] = [
  ['戸開', ['door-open-button']], ['戸閉', ['door-close-button']], ['閉じ込め', ['elevator-trapped']], ['階数表示', ['floor-indicator']], ['非常呼び', ['emergency-call']],
  ['インターホン', ['emergency-call']], ['行先ボタン', ['car-panel']], ['操作盤', ['control-panel', 'car-panel']], ['昇降路', ['elevator-shaft']], ['巻上機', ['elevator-shaft']],
  ['ダムウェーター', ['freight-lift']], ['定員', ['capacity-plate']], ['カウンターウェイト', ['counterweight']], ['地震', ['earthquake']], ['ビルの階', ['building-floors']],
  ['エレベーター', ['elevator', 'elevator-car']], ['エレベータ', ['elevator', 'elevator-car']], ['昇降機', ['elevator', 'elevator-car']],
];
const ESCALATOR: readonly (readonly [string, readonly string[]])[] = [
  ['エスカレーター', ['escalator', 'escalator-up', 'escalator-down']], ['エスカレータ', ['escalator', 'escalator-up', 'escalator-down']], ['動く歩道', ['moving-walkway']],
  ['上り', ['escalator-up']], ['下り', ['escalator-down']], ['非常停止', ['emergency-stop']], ['足元注意', ['step-caution']], ['手すり', ['handrail']],
  ['ステップ', ['escalator', 'escalator-up', 'escalator-down']], ['立ち止まる', ['stand-still']], ['スロープ', ['ramp']], ['ハンドレール', ['handrail']],
];

describe.each([['町工場', SHOP], ['ビジネスマン・オフィス', BUSINESS], ['エレベーター', ELEVATOR], ['エスカレーター・動く歩道', ESCALATOR]] as const)('%s の言葉で探す', (_world, list) => {
  it.each(list)('「%s」の上位 5 件に %j のどれかが出る', (q, want) => {
    const got = top5(q);
    expect(got.some((g) => want.includes(g)), `${q}: ${got.join(', ')}`).toBe(true);
  });
});

describe('拡充前には出なかったこと', () => {
  const NEW_WORDS = ['段取り替え', '山積み', 'アンドン', '現品票', '外注', '内製', '治具', '研削', '板金', 'めっき', '5S', 'ヒヤリハット', '歩留まり', '切粉',
    'ビジネスマン', 'サラリーマン', '予実', '戸開', '戸閉', '閉じ込め', '階数表示', '非常呼び', 'インターホン', '動く歩道', '足元注意', '手すり', 'ハンドレール'];

  it('これらの語は、拡充前の辞書に見出しがなかった', () => {
    expect(oldHeads.has(key('エレベーター'))).toBe(true); // 一覧の読み方の確認（旧辞書にあった語）
    const had = NEW_WORDS.filter((w) => oldHeads.has(key(w)));
    expect(had).toEqual([]);
  });

  it('新しい語で出る自作・Lucide のアイコンは、Fluent + Tabler だけの索引にはなかった', () => {
    const before = new Set([...fluentIcons, ...tablerIcons].map((i) => i.name));
    const newIcons = ['changeover', 'load-capacity', 'signal-tower', 'item-tag', 'outsource', 'in-house', 'c-clamp', 'grinding-wheel', 'sheet-bending', 'plating-tank', 'near-miss',
      'metal-chips', 'businessperson', 'door-open-button', 'door-close-button', 'elevator-trapped', 'floor-indicator', 'emergency-call', 'moving-walkway', 'step-caution', 'handrail'];
    expect(newIcons.filter((n) => before.has(n))).toEqual([]);
    for (const n of newIcons) expect(allIcons.some((i) => i.name === n), n).toBe(true);
  });

  it('既存のアイコンしかない言葉も、新しい見出しで引ける（旧辞書に見出しがなかった）', () => {
    for (const w of ['歩留まり', '予実', '山積み']) expect(oldHeads.has(key(w)), w).toBe(false);
    expect(top5('歩留まり').some((n) => ['chart-funnel', 'percentage'].includes(n))).toBe(true);
    expect(top5('予実').some((n) => ['chart-arrows', 'chart-bar'].includes(n))).toBe(true);
  });
});

describe('表記ゆれ（ひらがな・カタカナ・長音）', () => {
  it('エレベーター／エレベータ／えれべーた／えれべーたー は同じ先頭、エスカレーター／エスカレータ も同じ', () => {
    const a = top5('エレベーター');
    for (const q of ['エレベータ', 'えれべーた', 'えれべーたー', 'ｴﾚﾍﾞｰﾀｰ']) expect(top5(q), q).toEqual(a);
    const b = top5('エスカレーター');
    for (const q of ['エスカレータ', 'えすかれーたー', 'えすかれーた']) expect(top5(q), q).toEqual(b);
  });

  it('ひらがなで書いても引ける（だんどりがえ・いんたーほん・ひやりはっと）', () => {
    expect(top5('だんどりがえ')).toContain('changeover');
    expect(top5('いんたーほん')).toContain('emergency-call');
    expect(top5('ひやりはっと')).toContain('near-miss');
    expect(top5('うごくほどう')).toContain('moving-walkway');
  });
});

describe('「ビル」と「ビール」（長音だけが違う別の語）', () => {
  it('「ビル」で建物が先頭、「ビール」で飲み物が先頭。ビルにビールは出ず、ビールにビルは出ない', () => {
    const bill = top5('ビル');
    expect(bill[0]).toMatch(/skyscraper|building/);
    expect(bill).not.toContain('beer');
    const beer = top5('ビール');
    expect(beer[0]).toMatch(/beer/);
    expect(beer.some((n) => /building/.test(n))).toBe(false);
  });

  it('長音の違いを無視する語（フォルダー／フォルダ）は、これまでどおり同じ結果', () => {
    expect(top5('フォルダー')).toEqual(top5('フォルダ'));
  });
});

describe('「エスカレーター」「フロア」は階段の行から新しい行へ移った', () => {
  it('エスカレーターの先頭は escalator 系（stairs ではない）。フロアは building-floors が先頭', () => {
    expect(top5('エスカレーター')[0]).toMatch(/escalator/);
    expect(top5('フロア')[0]).toBe('building-floors');
    expect(top5('階段')[0]).toBe('stairs');
    const stairsRow = CONCEPTS.find(([k]) => k.startsWith('階段/'))!;
    expect(stairsRow[0]).not.toContain('エスカレーター');
    expect(stairsRow[0]).not.toContain('フロア');
  });
});

describe('読みが同じで意味が違う語は、新しい行に入れない', () => {
  it('けんさく・ベンダー・がいちゅう・てんじ は、新しい行の見出しにない', () => {
    const heads = new Set(CONCEPTS.slice(CONCEPTS.findIndex(([k]) => k.startsWith('研削/'))).flatMap(([k]) => k.split('/')).map(key));
    for (const w of ['けんさく', 'ベンダー', 'がいちゅう', 'てんじ']) expect(heads.has(key(w)), w).toBe(false);
  });
});
