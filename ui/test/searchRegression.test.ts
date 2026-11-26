// 0.3.1 の辞書の拡充で、これまで引けていた語の結果が細くなったり変わったりしていないか（回帰）。
// fixtures-search-before.json は、拡充の途中（第 2 弾の最後）の辞書で、辞書の全見出し 4,884 語（ひらがな・カタカナの別も含む）を探したときの上位 5 件。
// 「前の 1 位が、いまの上位 5 件に残る」「前の上位 5 件のどれかが残る」を全語で確かめる。残らないものは、理由つきの許容の一覧に書く。
import { describe, expect, it } from 'vitest';
import before from './fixtures-search-before.json';
import { CONCEPTS } from '../src/fluent/iconConcepts';
import { searchIconSet } from '../src/fluent/iconSearch';
import { allIcons } from './helpers/allIcons';

/** 許容する悪化（語 → 理由）。前の結果が、そもそも関係のないアイコンだったもの・意図した変更。 */
const ALLOW: Readonly<Record<string, string>> = {
  'げこう': '下降の「かこう」と同じく、読みではない見出し（下校など）だったので外した',
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
  'ソーラー': '前の 1 位は plane（無関係）。太陽光（leaf・recycle）',
  'わく': '前の 1 位は briefcase（無関係）。枠（line・minus）',
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

describe('辞書の拡充の回帰（前の全見出しで、前の結果が残る）', () => {
  const rows = before as unknown as [string, string[]][];
  const top5 = (w: string) => searchIconSet(allIcons, w).hits.slice(0, 5).map((h) => h.icon.name);
  const lost: string[] = [];
  const noOverlap: string[] = [];
  for (const [w, o] of rows) {
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
