import { describe, expect, it } from 'vitest';
import { missingKeys } from '../src/i18n';

// 0.3.0 で足した画面の文言に、英語の訳があるか（辞書にない文言は日本語のまま出てしまう）。
// 文言は t('…') の第 1 引数の文字列そのものがキー。ここに挙げたファイルの t('…') を全部確かめる。

const FILES = [
  '../src/macroAssign.ts',
  '../src/dialogs/macroDialog.ts',
  '../src/recovery.ts',
  '../src/dialogs/recoveryDialog.ts',
  '../src/dialogs/externalChangeDialog.ts',
  '../src/shell/externalWatch.ts',
  '../src/importFlow.ts',
  '../src/dialogs/importDialog.ts',
  '../src/ribbonImport.ts',
  '../src/distributionCheck.ts',
  // 0.4.0：アイコンのペイント機能（SPEC §25）
  '../src/icon/paint/paintDialog.ts',
  '../src/icon/paint/session.ts',
  '../src/icon/paint/paintPanels.ts',
];

// ペイント画面の英語の訳は、画面の塊を読み込んだときに足される（起動時の辞書に入れない）。その経路のまま確かめる
await import('../src/icon/paint/paintDialog');

const sources = import.meta.glob(['../src/**/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** t('…') の文字列を取り出す（エスケープした \' を含む）。変数の差し込みは {name} のまま。 */
function keysOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w.$])t\('((?:[^'\\\n]|\\.)*)'/g)) out.push(m[1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  return out;
}

describe('英語の辞書（0.3.0 の文言）', () => {
  it.each(FILES)('%s の t(…) の文言がすべて辞書にある', (file) => {
    const text = sources[file];
    expect(text, `${file} を読めない`).toBeTypeOf('string');
    const keys = keysOf(text!);
    expect(keys.length).toBeGreaterThan(0);
    expect(missingKeys(keys)).toEqual([]);
  });
});

// iconDialog.ts の文言は別名 tr('…') で書かれていて、上の数え方（t('…'）に入らない。ペイント機能で足した分を、ここに挙げて確かめる
describe('英語の辞書（アイコンエディタに足した、描いて編集の文言）', () => {
  it('tr(…) の文言がすべて辞書にある', () => {
    const text = sources['../src/icon/iconDialog.ts']!;
    const used = [
      '新しく描く', '描いて編集…', '描いた絵（{canvas} × {canvas}）',
      '空の絵を、鉛筆や塗りつぶしで一から描きます（16 × 16 のドット絵も描けます）',
      '今の見た目を下絵にして、鉛筆や塗りつぶしで直します',
      '描く絵の大きさを選んでください。16 × 16 はドット絵向きで、出力の大きさに合わせて拡大されます。',
      '描いた絵を捨てますか？', '描いた絵は、［設定する］を押さないと、ブックに入りません。', '捨てる', '戻る',
      '今の加工の結果を下絵にします。余白や色の設定は初期化されます（描いたあとに、もう一度かけられます）',
      'もっと新しい版の Sash で描いた絵です。見た目はそのまま使えますが、描き直しはできません',
    ];
    // 挙げた文言が、実際に iconDialog.ts にあること（書き換えて、この一覧が古くならないように）
    for (const k of used) expect(text, k).toContain(`tr('${k}'`);
    expect(missingKeys(used)).toEqual([]);
  });
});
