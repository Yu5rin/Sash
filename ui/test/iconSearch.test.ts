import { describe, expect, it } from 'vitest';
import type { FluentIcon } from '../src/fluent/fluent';
import { CATEGORIES, categorize, categoryBit } from '../src/fluent/iconCategories';
import { CONCEPTS } from '../src/fluent/iconConcepts';
import { buildIndex, CONCEPT_COUNT, conceptsInText, expandToken, relatedConcepts, searchIconSet, searchTerms, splitQuery } from '../src/fluent/iconSearch';
import { normalize } from '../src/fluent/iconWords';
import { hasSuggestTerms, suggestFluent } from '../src/iconSuggest';
import { allIcons } from './helpers/allIcons';

const all: FluentIcon[] = allIcons;

const names = (q: string, n = 10, opts: Parameters<typeof searchIconSet>[2] = {}) => searchIconSet(all, q, opts).hits.slice(0, n).map((h) => h.icon.name);
const has = (icon: FluentIcon, cat: string) => (categorize(icon) & categoryBit(cat)) !== 0;

describe('入力の正規化と語の分け方', () => {
  it('全角半角・大文字小文字・ひらがな・長音をそろえる', () => {
    expect(normalize('Ａ')).toBe('a');
    expect(normalize('ＣＳＶ')).toBe('csv');
    expect(normalize('ねこ')).toBe(normalize('ネコ'));
    expect(expandToken('フォルダー').map((e) => e.term)).toEqual(expandToken('フォルダ').map((e) => e.term));
  });

  it('空白・読点・中黒と、英数字と日本語の境目で語に分ける', () => {
    expect(splitQuery('CSV出力').map((t) => t.norm)).toEqual(['csv', '出力']);
    expect(splitQuery('お金、配送　ねこ').map((t) => t.raw)).toEqual(['お金', '配送', 'ねこ']);
    expect(splitQuery('Ａ').map((t) => t.norm)).toEqual(['a']);
    expect(splitQuery('  ')).toEqual([]);
  });
});

describe('概念の辞書', () => {
  it('概念の数は数百あり、どの言葉も少なくとも1つのアイコンに当たる', () => {
    expect(CONCEPT_COUNT).toBeGreaterThanOrEqual(300);
    const cache = new Map<string, number>();
    const misses: string[] = [];
    for (const [keys, terms] of CONCEPTS) {
      for (const term of terms.split(' ').filter(Boolean)) {
        let n = cache.get(term);
        if (n === undefined) {
          n = searchTerms(all, [term]).length;
          cache.set(term, n);
        }
        if (n === 0) misses.push(`${keys.split('/')[0]}: ${term}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('漢字の見出しには、ひらがな（かカタカナ）の読みを並べてある', () => {
    const kanji = /[一-鿿]/;
    const kana = /^[ぁ-んァ-ヶー]+$/;
    const missing = CONCEPTS.map(([keys]) => keys.split('/')).filter((ks) => ks.some((k) => kanji.test(k)) && !ks.some((k) => kana.test(k))).map((ks) => ks[0]);
    expect(missing).toEqual([]);
  });

  it('見出しをそのまま検索すると、どれも結果がある', () => {
    const empty = CONCEPTS.map(([keys]) => keys.split('/')[0]!).filter((k) => searchIconSet(all, k).hits.length === 0);
    expect(empty).toEqual([]);
  });

  it('お金は money・cash・coin などに広がり、辞書の先頭の言葉ほど重い', () => {
    const e = expandToken(normalize('お金'));
    const terms = e.map((x) => x.term);
    expect(terms).toEqual(expect.arrayContaining(['money', 'cash', 'coin', 'wallet', 'receipt', 'calculator']));
    const w = (t: string) => e.find((x) => x.term === t)!.weight;
    expect(w('money')).toBeGreaterThan(w('chart'));
  });

  it('入力の途中（はいそ→配送）、言い回し（保存する）、語の中の見出し（売上集計）でも広がる', () => {
    expect(expandToken(normalize('はいそ')).map((e) => e.term)).toContain('truck');
    expect(expandToken(normalize('保存する')).map((e) => e.term)).toContain('save');
    expect(expandToken(normalize('売上集計')).map((e) => e.term)).toEqual(expect.arrayContaining(['chart-line', 'sum']));
  });

  it('見出しにそのまま一致するときは、前方が同じ別の見出しまで広げない（ログイン→ログに広がらない）', () => {
    const terms = expandToken(normalize('ログイン')).map((e) => e.term);
    expect(terms).toContain('login');
    expect(terms).not.toContain('history');
  });

  it('1文字の見出しは、入力がその1文字だけのときにしか使わない', () => {
    expect(expandToken(normalize('上書き')).map((e) => e.term)).not.toContain('arrow-up');
    expect(expandToken(normalize('上')).map((e) => e.term)).toContain('arrow-up');
  });

  it('constructor のような語でも落ちない', () => {
    for (const q of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => searchIconSet(all, q)).not.toThrow();
      expect(searchIconSet(all, q).hits).toEqual([]);
    }
  });
});

describe('概念による検索', () => {
  it('お金：コイン・現金・通貨のアイコンが上位に出る', () => {
    const top = names('お金', 10);
    const money = top.filter((n) => /coin|cash|money|currency/.test(n));
    expect(money.length).toBeGreaterThanOrEqual(8);
    expect(names('おかね', 10)).toEqual(top);
  });

  it('費用・売上・経費でも、お金の仲間が出る', () => {
    for (const q of ['費用', 'コスト', '売上', '経費']) {
      const top = names(q, 12).join(' ');
      expect(top, q).toMatch(/coin|cash|money|currency|chart|report|receipt|calculator|trending/);
    }
  });

  it('配送：トラックが先頭付近に出る（読みの途中「はいそ」でも）', () => {
    expect(names('配送', 3).join(' ')).toMatch(/truck/);
    expect(names('はいそ', 3).join(' ')).toMatch(/truck/);
    expect(names('物流', 5).join(' ')).toMatch(/truck|package|forklift|box/);
  });

  it('ねこ・猫・ネコは同じで、cat が先頭', () => {
    expect(names('ねこ', 1)).toEqual(['cat']);
    expect(names('猫', 1)).toEqual(['cat']);
    expect(names('ネコ', 5)).toEqual(names('ねこ', 5));
    expect(names('cat', 1)).toEqual(['cat']);
  });

  it('動物：動物のアイコンが出る', () => {
    const top = names('動物', 15).join(' ');
    expect(top).toMatch(/paw|cat|dog|fish|horse|pig/);
  });

  it('1文字の a・Ａ は letter-a を先頭に出す。数字は number-5', () => {
    expect(names('a', 1)).toEqual(['letter-a']);
    expect(names('Ａ', 1)).toEqual(['letter-a']);
    expect(names('z', 1)).toEqual(['letter-z']);
    expect(names('5', 1)).toEqual(['number-5']);
    expect(names('５', 1)).toEqual(['number-5']);
    // 1文字で単語の前方一致をしない（「a」で arrow などの全件に当たらない）
    expect(searchIconSet(all, 'a').hits.length).toBeLessThan(40);
    expect(names('circle a', 3)).toContain('circle-letter-a');
  });

  it('アルファベット：A〜Z のアイコンが出る', () => {
    const top = names('アルファベット', 80);
    for (const l of ['a', 'm', 'z']) expect(top).toContain(`letter-${l}`);
  });

  it('生産・事務の言葉：どれも結果があり、先頭が関係するもの', () => {
    const expectTop: Record<string, RegExp> = {
      '生産': /factory|assembly|tool|settings|robot/,
      '工場': /factory/,
      '在庫': /packages|box|warehouse/,
      '出荷': /truck|package|box/,
      '品番': /package|barcode|box|tag|hash|list/,
      '図面': /ruler|pencil|layout|triangle/,
      '仕様': /file|list|clipboard|settings/,
      '工程': /timeline|route|arrows|hierarchy|schema|chevrons|flow/,
      '納期': /calendar|alarm|clock|hourglass|flag/,
      '稼働': /play|power|activity|gauge|settings|engine|bolt/,
      '品質': /certificate|shield|award|rosette|star|clipboard|zoom/,
      '予定': /calendar|clock/,
      '会議': /users|presentation|message|calendar/,
      '確認': /check/,
      '承認': /check|badge|stamp|thumb|shield|rosette/,
      '警告': /alert|warning|exclamation|urgent/,
      '集計': /sum|calculator|chart|report|table/,
      '印刷': /print/,
      '検索': /search|zoom/,
      '設定': /settings|adjustments|tool/,
      '削除': /trash|eraser|delete|x/,
      '食事': /bowl|burger|pizza|food|soup|salad/,
      '飲み物': /cup|mug|coffee|glass|bottle|beer|drink/,
      '乗り物': /car|bus|train|plane|truck|ship|bike|vehicle/,
      '移動': /arrow|truck|car|bus|train|plane|route|move/,
    };
    for (const [q, re] of Object.entries(expectTop)) {
      const top = names(q, 6);
      expect(top.length, q).toBeGreaterThan(0);
      expect(top.join(' '), q).toMatch(re);
    }
  });

  it('複数の語はすべてに合うもの（AND）。ひとつも残らなければ、いずれかに合うものに広げる', () => {
    const both = searchIconSet(all, 'お金 レポート');
    expect(both.relaxed).toBe(false);
    expect(both.hits[0]!.icon.name).toBe('report-money');
    const none = searchIconSet(all, 'ねこ ロケット');
    expect(none.relaxed).toBe(true);
    expect(none.hits.length).toBeGreaterThan(0);
    expect(searchIconSet(all, 'ねこ ほげほげ').hits.length).toBeGreaterThan(0);
  });

  it('辞書にない語は何も返さない', () => {
    expect(searchIconSet(all, 'ほげほげ').hits).toEqual([]);
    expect(searchIconSet(all, 'ほげほげ').counts).toEqual({});
  });

  it('当たった理由（お金 → money など）が上位の結果に付く。英語をそのまま探したときは付かない', () => {
    const r = searchIconSet(all, 'お金');
    expect(r.hits[0]!.via).toMatch(/^お金 → /);
    expect(searchIconSet(all, 'cat').hits[0]!.via).toBe('');
  });

  it('空の結果のときは、近い言葉を案内できる', () => {
    expect(relatedConcepts('どうぶ')).toContain('動物');
    expect(relatedConcepts('ほげほげ').length).toBeGreaterThan(0);
    expect(relatedConcepts('').length).toBeGreaterThan(0);
    expect(relatedConcepts('どうぶ', 3).length).toBeLessThanOrEqual(3);
  });
});

describe('検索の質の調整', () => {
  it('最長一致：「ログイン」は、中に含まれる短い見出し「ログ」（履歴）を拾わない', () => {
    expect(conceptsInText('ログイン').map((c) => c.display)).toEqual(['ログイン']);
    // 離れた位置にある短い見出しは、これまでどおり拾う
    expect(conceptsInText('ログを見る').map((c) => c.display)).toContain('履歴');
    // 同じ位置で別の長さの見出しがあれば、長いほうだけ
    expect(conceptsInText('ログイン履歴').map((c) => c.display)).toEqual(expect.arrayContaining(['ログイン', '履歴']));
  });

  it('「せいさん」は精算（支払い）と生産の両方の概念が出る', () => {
    expect(conceptsInText('せいさん').map((c) => c.display)).toEqual(expect.arrayContaining(['支払い', '生産']));
  });

  it('「印刷」で動物の足跡（animal_paw_print）を上位に出さない。プリンターは出る', () => {
    const top = names('印刷', 8);
    expect(top).toContain('printer');
    expect(top.some((n) => /paw/.test(n))).toBe(false);
    // 英語で打った探し方は外さない
    expect(names('paw print', 5).some((n) => /paw/.test(n))).toBe(true);
  });

  it('「ばなな」の候補は食べ物のカテゴリだけ（apple のタグが付いた機器 device-imac などを出さない）', () => {
    const hits = searchIconSet(all, 'ばなな').hits.slice(0, 40).map((h) => h.icon);
    expect(hits.map((i) => i.name)).toContain('banana');
    expect(hits.every((i) => has(i, 'food'))).toBe(true);
    expect(hits.some((i) => /^device-/.test(i.name))).toBe(false);
  });

  it('ラベルからの候補も、食べ物の概念は食べ物のカテゴリだけ', async () => {
    const picks = await suggestFluent(all, 'バナナを数える');
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.some((i) => /^device-/.test(i.name))).toBe(false);
  });

  it('1 文字の入力には、関係のない「近い言葉」を出さない。2 文字以上は出す', () => {
    expect(relatedConcepts('こ')).toEqual([]);
    expect(relatedConcepts('あ')).toEqual([]);
    expect(relatedConcepts('どうぶ')).toContain('動物');
  });

  it('1 文字の英数字は、その文字のアイコンに当たる', () => {
    expect(names('a', 5).some((n) => /letter-a|^a$/.test(n))).toBe(true);
    expect(names('5', 5).some((n) => /number-5/.test(n))).toBe(true);
  });

  it('英語の画面では、近い言葉を英語で出す（押すとそのまま検索できる）', () => {
    const en = relatedConcepts('どうぶ', 6, 'en');
    expect(en.length).toBeGreaterThan(0);
    expect(en.every((w) => /^[\x20-\x7e]+$/.test(w))).toBe(true);
    expect(en).toContain('animal');
    expect(searchIconSet(all, en[0]!).hits.length).toBeGreaterThan(0);
    // 何にも似ていないときの既定の案内も英語
    expect(relatedConcepts('ほげほげ', 6, 'en').every((w) => /^[\x20-\x7e]+$/.test(w))).toBe(true);
    // 日本語の画面は見出しのまま
    expect(relatedConcepts('どうぶ', 6, 'ja')).toContain('動物');
  });

  it('ラベルの言葉の判定は、概念の辞書にだけある言葉（出荷・精算する・猫・納期・発注）でも true', async () => {
    for (const w of ['出荷', '精算する', '猫', '納期', '発注']) expect(await hasSuggestTerms(w), w).toBe(true);
    expect(await hasSuggestTerms('ほげ')).toBe(false);
    expect(await hasSuggestTerms('')).toBe(false);
    // 英数字の語はそのまま探すので true
    expect(await hasSuggestTerms('CSV')).toBe(true);
  });
});

describe('カテゴリ・出どころ・スタイルの絞り込み', () => {
  it('カテゴリは 32 個以内で、ビジネス・動物・乗り物・食べ物・文字・数字がある', () => {
    expect(CATEGORIES.length).toBeLessThanOrEqual(31);
    for (const id of ['business', 'animal', 'vehicle', 'food', 'text', 'document', 'arrow', 'shape', 'nature', 'people', 'device', 'symbol']) {
      expect(CATEGORIES.some((c) => c.id === id), id).toBe(true);
    }
  });

  it('カテゴリで絞ると、そのカテゴリのアイコンだけが出る', () => {
    const find = (cat: string, name: string) => searchIconSet(all, '', { category: cat }).hits.some((h) => h.icon.name === name);
    expect(find('animal', 'cat')).toBe(true);
    expect(find('animal', 'animal_dog')).toBe(true);
    expect(find('animal', 'home')).toBe(false);
    expect(find('vehicle', 'truck')).toBe(true);
    expect(find('vehicle', 'vehicle_car')).toBe(true);
    expect(find('food', 'pizza')).toBe(true);
    expect(find('food', 'coffee')).toBe(true);
    expect(find('text', 'letter-a')).toBe(true);
    expect(find('text', 'number-5')).toBe(true);
    expect(find('business', 'report-money')).toBe(true);
    expect(find('business', 'building-factory')).toBe(true);
    expect(find('business', 'truck')).toBe(true);
    expect(find('arrow', 'arrow-up')).toBe(true);
    // トラックは物流として、ビジネスと乗り物の両方に入る
    expect(find('animal', 'truck')).toBe(false);
  });

  it('検索語とカテゴリを組み合わせられ、件数のカウントはカテゴリで絞る前の数', () => {
    const r = searchIconSet(all, '配送', { category: 'vehicle' });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => has(h.icon, 'vehicle'))).toBe(true);
    const full = searchIconSet(all, '配送');
    expect(r.total).toBe(full.total);
    expect(r.counts['vehicle']).toBe(r.hits.length);
    expect(full.counts['business']).toBeGreaterThan(0);
  });

  it('各カテゴリに十分な数のアイコンがある', () => {
    const counts = searchIconSet(all, '').counts;
    expect(counts['business']).toBeGreaterThan(300);
    expect(counts['animal']).toBeGreaterThan(25);
    expect(counts['vehicle']).toBeGreaterThan(80);
    expect(counts['food']).toBeGreaterThan(100);
    expect(counts['text']).toBeGreaterThan(500);
    expect(counts['arrow']).toBeGreaterThan(300);
  });

  it('出どころで絞れる', () => {
    expect(searchIconSet(all, 'home', { set: 'tabler' }).hits.every((h) => h.icon.set === 'tabler')).toBe(true);
    expect(searchIconSet(all, 'home', { set: 'fluent' }).hits.every((h) => (h.icon.set ?? 'fluent') === 'fluent')).toBe(true);
    const both = searchIconSet(all, 'home', { set: 'all' }).hits;
    expect(both.some((h) => h.icon.set === 'tabler') && both.some((h) => h.icon.set === 'fluent')).toBe(true);
  });

  it('塗りに絞ると、塗りがあるものだけ', () => {
    const r = searchIconSet(all, 'home', { variant: 'filled' });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.icon.filled !== 0)).toBe(true);
    expect(searchIconSet(all, '', { variant: 'filled' }).hits.length).toBeLessThan(searchIconSet(all, '', { variant: 'regular' }).hits.length);
  });

  it('検索語が空なら、名前順の全件', () => {
    const r = searchIconSet(all, '').hits.map((h) => h.icon.name);
    expect(r.length).toBe(all.length);
    expect(r.slice(0, 3)).toEqual([...r.slice(0, 3)].sort());
  });
});

describe('ラベルからの候補', () => {
  it('ラベルの中の概念ごとに探し、Tabler も含めて候補を出す', async () => {
    expect(conceptsInText('在庫確認').map((c) => c.display)).toEqual(expect.arrayContaining(['在庫', '確認']));
    const s = (await suggestFluent(all, '売上集計')).map((i) => i.name).join(' ');
    expect(s).toMatch(/chart|sum|trending|calculator/);
    const csv = (await suggestFluent(all, 'CSV出力')).map((i) => i.name);
    expect(csv.some((n) => /csv/.test(n))).toBe(true);
    expect(csv.some((n) => /print|export/.test(n))).toBe(true);
    expect(csv.length).toBeLessThanOrEqual(5);
    expect((await suggestFluent(all, '配送リスト')).some((i) => i.set === 'tabler')).toBe(true);
    expect(await suggestFluent(all, 'ほげ')).toEqual([]);
  });
});

describe('速さ', () => {
  it('8,000 個の検索は、よくある語で 30ms 未満（索引を作った後）', () => {
    const t0 = performance.now();
    buildIndex(all);
    const build = performance.now() - t0;
    // 索引は読み込みの後に1度だけ作る。目安として、1秒を超えないこと
    expect(build).toBeLessThan(1500);
    const queries = ['お金', '配送', 'ねこ', 'a', '食事', '会議 予定', '在庫確認', 'ロボット', 'arrow', 'フォルダ', '生産計画', 'letter'];
    const times: number[] = [];
    for (const q of queries) {
      searchIconSet(all, q); // 1回目は JIT の温まり待ち
      const s = performance.now();
      for (let i = 0; i < 5; i++) searchIconSet(all, q, { variant: 'regular', set: 'all', category: 'all' });
      times.push((performance.now() - s) / 5);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    expect(all.length).toBeGreaterThan(7500);
    expect(median).toBeLessThan(30);
    expect(times[times.length - 1]!).toBeLessThan(60);
  });
});
