// 0.3.1 の辞書の拡充で、これまで引けていた語の結果が細くなったり変わったりしていないか（回帰）。
// fixtures-search-before.json は、拡充の途中（57272a1 の直後。Q&A を QA と分ける 503528c より前、第 3 弾より前）の辞書で、辞書の全見出し 4,884 語（ひらがな・カタカナの別も含む）を探したときの [語, 上位 5 件, 結果の件数]。
// 「前の 1 位が、いまの上位 5 件に残る」「前の上位 5 件のどれかが残る」を全語で確かめる。残らないものは、理由つきの許容の一覧に書く。
import { describe, expect, it } from 'vitest';
import before from './fixtures-search-before.json';
import { CONCEPTS } from '../src/fluent/iconConcepts';
import { categorize, categoryBit } from '../src/fluent/iconCategories';
import { searchIconSet, searchTerms } from '../src/fluent/iconSearch';
import { allIcons } from './helpers/allIcons';

/** 許容する悪化（語 → 理由）。前の結果が、そもそも関係のないアイコンだったもの・意図した変更。 */
const ALLOW: Readonly<Record<string, string>> = {
  'げこう': '下降の読みではない見出し（下校など）だったので外した。結果は 0 件（読みとして誤りなので、直さない）',
  'フロー': '前の 1 位は armchair（無関係）。工程・フロー（chart-gantt・kanban・workflow）が先頭に出るのが正しい',
  'か': '前の 1 位は car（「か」→車は無関係）',
  'セル': '前の 1 位は discount（「セル」→セール）。表のセル（table-column・table・cell）が先頭に出る',
  'せる': '同上',
  'おと': '前の 1 位は sparkles。音（music・volume・headphones）が先頭に出る',
  'しる': '前の 1 位は sticker。汁物（bowl-chopsticks・soup）が先頭に出る',
  'チーズ': '前の 1 位は map-2（無関係）。cheese・milk が先頭に出る',
  'ちーず': '同上',
  'ヒート': '前の 1 位は user（無関係）。flame・fire が先頭に出る',
  'ウェーブ': '前の「ウェブ」の言い間違いの見出しより、波（beach・swimming）の語が合う',
  'うぇーぶ': '同上',
  'ツリー': '前の 1 位は fish-bone。木（tree・trees）が先頭に出る（ツリー構造は部品表・階層の行）',
  'つりー': '同上',
  'ソーラー': '前の 1 位は plane（無関係だった）。太陽光の行を分け、solar-panel・sun を先頭に出す（上位 5 件に残らないのは、前の 1 位が無関係だったため）',
  'わく': '前の 1 位は briefcase（「枠」の読みとして無関係）。枠線（line・minus）が出る',
  'スキー': '前の 1 位は heart（無関係）。ski-jumping・snowboarding が先頭に出る',
  'すきー': '同上',
  'から': '前の 1 位は palette（無関係）',
  'キー': '前の 1 位は tree。鍵（key・key-round）が先頭に出る',
  'QR': 'scan-barcode より scan-qr-code・qrcode が先頭に出るのが正しい',
  'ビル': '意図した変更：建物（ビール＝飲み物とは別の語。長音まで同じ見出しを先に使う）',
  'Q＆A': '意図した変更：質疑応答（help・message-question）。品質保証（QA）とは別の語',
  'M＆A': '意図した変更：買収・合併（handshake）',
  'Web会議': '意図した変更：video 系が先頭（前は web と会議の両方に当たる無関係のもの）',
};

/** 件数が前の半分未満に減った語（語 → 理由）。大きく減るのは、広すぎた一般語の部分一致を直したときなど。 */
const SHRUNK: Readonly<Record<string, string>> = {
  'セール': '短い語で、前は無関係な前方一致が多く当たっていた',
  'ワーク': '同上',
  'げこう': '見出しから外した（読みとして誤り）',
  'か': '同上（短い語）',
  '修理': '一般語 tool の名前の部分一致（eraser_tool など）を、wrench・toolbox・hammer の具体的な名前に直した（193 → 79。上位は tools・wrench・hammer）',
  'しゅうり': '同上',
  'おと': '短い語で、前は無関係な前方一致が多く当たっていた',
  'カラー': '同上',
  'からー': '同上',
  'QR': 'QRコードの行を分けた（バーコードの行の言葉が減った。scan-qr-code・qrcode は先頭に出る）',
  'キューアール': '同上',
  'つり': '短い語で、前は無関係な前方一致が多く当たっていた',
  'そら': '同上',
  'しる': '同上',
  'チーズ': '前の 195 件は map-2 など無関係なものが大半。cheese・milk に絞られた',
  'ちーず': '同上',
  'ヒート': '短い語で、前は無関係な前方一致が多く当たっていた',
  'ウェーブ': '波（beach・swimming）に絞られた（前は web の言い間違いの見出しで広く当たっていた）',
  'うぇーぶ': '同上',
  'き': '短い語で、前は無関係な前方一致が多く当たっていた',
  'ふろ': '同上',
  'スキー': '前は無関係な見出しに広く当たっていた。ski・snowboarding に絞られた',
  'すきー': '同上',
  'ビル': '意図した変更（建物。ビールとは別の語）',
  'ソーラー': '太陽光の行を分けて、solar-panel・sun に絞った（前の 96 件は plane など無関係なものが大半）',
};

describe('辞書の拡充の回帰（前の全見出しで、前の結果が残る）', () => {
  const rows = before as unknown as [string, string[], number][];
  const top5 = (w: string) => searchIconSet(allIcons, w).hits.slice(0, 5).map((h) => h.icon.name);
  const lost: string[] = [];
  const noOverlap: string[] = [];
  const shrunk: string[] = [];
  for (const [w, o, oc] of rows) {
    if (searchIconSet(allIcons, w).hits.length < oc * 0.5) shrunk.push(w);
    const n = top5(w);
    if (!n.includes(o[0]!)) lost.push(w);
    if (!o.some((x) => n.includes(x))) noOverlap.push(w);
  }

  it('前の 1 位が上位 5 件から消えた語は、許容の一覧にあるものだけ（理由つき）', () => {
    expect(rows.length).toBeGreaterThan(4800);
    expect(lost.filter((w) => !(w in ALLOW))).toEqual([]);
  });

  it('前の上位 5 件がすべて入れ替わった語も、許容の一覧にあるものだけ', () => {
    expect(noOverlap.filter((w) => !(w in ALLOW))).toEqual([]);
  });

  it('結果の件数が前の半分未満に減った語は、許容の一覧（理由つき）にあるものだけ。直ったら一覧から外す', () => {
    expect(shrunk.filter((w) => !(w in SHRUNK))).toEqual([]);
    expect(Object.keys(SHRUNK).filter((w) => !shrunk.includes(w))).toEqual([]);
  });

  it('許容の一覧は、いま本当に悪化している語だけ（直ったら一覧から外す）。数も増やさない', () => {
    const live = new Set([...lost, ...noOverlap]);
    expect(Object.keys(ALLOW).filter((w) => !live.has(w))).toEqual([]);
    expect(lost.length).toBeLessThanOrEqual(25);
    expect(noOverlap.length).toBeLessThanOrEqual(7);
  });

  it('見出しを移した語（サポート・担当者・はんだ・段取り・カタログ・勤怠・外観検査・電力・省エネ・地震）が、元の行の結果も残して広く出る', () => {
    const n = (w: string) => searchIconSet(allIcons, w).hits.length;
    for (const [w, min] of [['サポート', 30], ['担当者', 20], ['はんだ', 20], ['段取り', 10], ['カタログ', 20], ['勤怠', 4], ['外観検査', 8], ['電力', 20], ['省エネ', 20], ['地震', 4]] as const) {
      expect(n(w), w).toBeGreaterThanOrEqual(min);
    }
    expect(top5('電力')).toEqual(expect.arrayContaining(['plug']));
    expect(top5('サポート')).toEqual(expect.arrayContaining(['hand-helping']));
    expect(top5('担当者')).toContain('user');
  });

  it('SDカード・QRコード・QRコード決済は、これまでの 1 位が上位 5 件に残る', () => {
    expect(top5('SDカード')).toContain('device-sd-card');
    expect(top5('QRコード')).toContain('scan-qr-code');
    expect(top5('QRコード決済')).toContain('scan-qr-code');
  });
});

describe('新しい行の見出しは、細い結果（1〜2 件）にならない', () => {
  it('第 3 弾の各行の先頭の見出しで、3 件以上出る（自作 1 個だけの行にも、意味の近い既存のアイコンを足してある）', () => {
    const start = CONCEPTS.findIndex(([k]) => k.startsWith('研削/'));
    const thin: string[] = [];
    for (const [k] of CONCEPTS.slice(start)) {
      const w = k.split('/')[0]!;
      const n = searchIconSet(allIcons, w).hits.length;
      if (n < 3) thin.push(`${w}:${n}`);
    }
    expect(thin).toEqual([]);
  });

  it('外注・内製・治具・研削・回覧・定員・段取り替え・アンドン は、自作のほかに関連するアイコンも出る', () => {
    for (const w of ['外注', '内製', '治具', '研削', '回覧', '定員', '段取り替え', 'アンドン']) {
      expect(searchIconSet(allIcons, w).hits.length, w).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('新しい行の英語の言葉が一般的すぎない（名前の部分一致で無関係なアイコンを混ぜない）', () => {
  const start = CONCEPTS.findIndex(([k]) => k.startsWith('研削/'));
  const end = CONCEPTS.findIndex(([k]) => k.startsWith('ビル/'));
  const bridges = CONCEPTS.slice(end + 1);
  const rows = CONCEPTS.slice(start, end + 1);
  /** 短く多義で、名前の単語に大量に当たる言葉（具体的な名前に直す）。 */
  const GENERIC = new Set(['tool', 'tools', 'floor', 'box', 'square', 'settings', 'arrow-right', 'arrow-up', 'arrow-down', 'search', 'filter', 'send', 'share', 'star', 'clock', 'heart',
    'folder', 'file', 'building', 'map', 'lock', 'home', 'user', 'help', 'anchor', 'keyboard', 'cash', 'label', 'basket', 'power', 'cube', 'pin', 'bell', 'glass', 'cone']);

  it('第 3 弾の各行（橋渡しの行を除く）に、一般的な言葉（tool・box・floor など）がない', () => {
    const bad = rows.flatMap(([k, t]) => t.split(' ').filter((x) => GENERIC.has(x)).map((x) => `${k.split('/')[0]}: ${x}`));
    expect(bad).toEqual([]);
  });

  it('橋渡しの行（元の行の言葉）にも floor はない（math-x-floor-divide-y など無関係なものが混ざる）', () => {
    expect(bridges.flatMap(([k, t]) => t.split(' ').filter((x) => x === 'floor').map(() => k))).toEqual([]);
  });

  it('各行の言葉のうち、名前の単語に 150 個を超えて当たるものがない', () => {
    const seen = new Map<string, number>();
    const bad: string[] = [];
    for (const [k, t] of rows) for (const term of t.split(' ')) {
      let n = seen.get(term);
      if (n === undefined) { n = searchTerms(allIcons, [term]).length; seen.set(term, n); }
      if (n > 150) bad.push(`${k.split('/')[0]}: ${term} ${n}`);
    }
    expect(bad).toEqual([]);
  });

  it('先頭の見出しで引いた件数が 140 を超えない。上位 30 件に、食べ物などの無関係なカテゴリが混ざらない（一服・割れ物など食べ物に関わる語を除く）', () => {
    const food = categoryBit('food');
    const FOOD_OK = new Set(['休憩', '一服', '喫煙所']);
    const bad: string[] = [];
    for (const [k] of rows) {
      const w = k.split('/')[0]!;
      const r = searchIconSet(allIcons, w);
      if (r.hits.length > 140) bad.push(`${w}: ${r.hits.length} 件`);
      if (!FOOD_OK.has(w) && r.hits.slice(0, 20).some((h) => (categorize(h.icon) & food) !== 0)) bad.push(`${w}: 食べ物`);
    }
    expect(bad).toEqual([]);
  });

  it('研削・段取り替え・治具・丸棒・エスカレーターの結果が、名前に tool や box を含む無関係なものに広がらない', () => {
    const names = (w: string) => searchIconSet(allIcons, w).hits.map((h) => h.icon.name);
    expect(names('研削').length).toBeLessThan(70);
    expect(names('研削').some((n) => /kitchen|eraser_tool|inking_tool|laser_tool|^pen-tool$/.test(n))).toBe(false);
    expect(names('治具').some((n) => /eraser_tool|inking_tool|laser_tool|pen-tool/.test(n))).toBe(false);
    expect(names('丸棒').length).toBeLessThan(60);
    expect(names('丸棒').some((n) => /^box-(model|align)/.test(n))).toBe(false);
    expect(names('エスカレーター').some((n) => /math-x-floor|^arrow-right$/.test(n))).toBe(false);
    expect(names('治具')[0]).toBe('c-clamp');
    expect(names('勤怠')[0]).toBe('time-card');
    expect(names('呼びボタン')[0]).toBe('elevator-call');
  });
});
