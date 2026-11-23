import { describe, expect, it } from 'vitest';
import { controlRows, csvCell, toCsv, toTsv } from '../src/controlList';
import { parseXml } from '../src/model';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';

function doc(xml: string): Document {
  const r = parseXml(`<customUI xmlns="${NS}">${xml}</customUI>`);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

const SAMPLE = doc(`<ribbon><tabs><tab id="t" label="集計"><group id="g" label="出力">
  <button id="btnRun" label="実行" size="large" imageMso="MacroPlay" screentip="実行します" keytip="R" onAction="Ribbon_btnRun_onAction" />
  <box id="bx"><toggleButton id="tgl" getLabel="Ribbon_tgl_getLabel" image="myIcon" getPressed="Ribbon_tgl_getPressed" onAction="Ribbon_tgl_onAction" /></box>
  <dropDown id="ddn" label="出力先" onAction="Ribbon_ddn_onAction"><item id="i1" label="A" /></dropDown>
  <separator id="sep" />
  <button idMso="Copy" />
</group></tab></tabs></ribbon>
<contextMenus><contextMenu idMso="ContextMenuCell"><button id="cm" label="右クリック, の項目" getImage="Ribbon_cm_getImage" /></contextMenu></contextMenus>`);

describe('コントロール一覧', () => {
  it('コントロールだけを文書の順に並べる（入れ物・区切り線・選択肢は除く）', () => {
    const rows = controlRows(SAMPLE);
    expect(rows.map((r) => r.id)).toEqual(['btnRun', 'tgl', 'ddn', 'Copy', 'cm']);
    expect(rows[0]).toEqual({ tab: '集計', group: '出力', kind: 'ボタン', label: '実行', id: 'btnRun', macro: 'Ribbon_btnRun_onAction', screentip: '実行します', keytip: 'R', image: 'imageMso:MacroPlay' });
  });

  it('VBA で決まる値は（VBA：名前）と書き、表示以外のコールバックをマクロの列に並べる', () => {
    const tgl = controlRows(SAMPLE)[1]!;
    expect(tgl.label).toBe('（VBA：Ribbon_tgl_getLabel）');
    expect(tgl.image).toBe('myIcon');
    expect(tgl.macro).toBe('Ribbon_tgl_getPressed (getPressed), Ribbon_tgl_onAction');
    expect(tgl.group).toBe('出力');
  });

  it('右クリックメニューの項目は、タブの列にメニューの名前を書く', () => {
    const cm = controlRows(SAMPLE)[4]!;
    expect(cm.tab).toBe('右クリック：ContextMenuCell');
    expect(cm.image).toBe('（VBA：Ribbon_cm_getImage）');
  });

  it('CSV の値は , " 改行 前後の空白を含むときだけ囲む', () => {
    expect(csvCell('abc')).toBe('abc');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(' lead')).toBe('" lead"');
    expect(csvCell('日本語')).toBe('日本語');
  });

  it('CSV は BOM 付きで、見出しの行と CRLF の改行を持つ', () => {
    const csv = toCsv(controlRows(SAMPLE));
    expect(csv.startsWith('﻿タブ,グループ,種類,ラベル,id,マクロ,ヒント,キーヒント,画像\r\n')).toBe(true);
    expect(csv).toContain('\r\n集計,出力,ボタン,実行,btnRun,Ribbon_btnRun_onAction,実行します,R,imageMso:MacroPlay\r\n');
    expect(csv).toContain('"右クリック, の項目"');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(7);
  });

  it('TSV は BOM なしで、値の中のタブと改行を空白にする', () => {
    const tsv = toTsv([{ tab: 'a\tb', group: 'x\r\ny', kind: '', label: '', id: '', macro: '', screentip: '', keytip: '', image: '' }]);
    expect(tsv.startsWith('タブ\tグループ')).toBe(true);
    expect(tsv.split('\r\n')[1]).toBe('a b\tx y\t\t\t\t\t\t\t');
  });
});
