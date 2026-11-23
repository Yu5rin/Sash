import { describe, expect, it } from 'vitest';
import { LARGE_LABEL_MAX_WIDTH, labelWidth, lint, SMALL_LABEL_MAX_CHARS, type LintContext } from '../src/lint';
import { parseXml } from '../src/model';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const ctx: LintContext = { version: 'office2010', imageIds: new Set(), knownIdMso: new Set(), missingImageMso: new Set() };
const LARGE = '大きいボタンのラベルが長いため、Excel では2行目で切れる可能性があります';

function run(group: string): string[] {
  const r = parseXml(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" label="T"><group id="g" label="G">${group}</group></tab></tabs></ribbon></customUI>`);
  if (!r.ok) throw new Error(r.message);
  return lint(r.doc, ctx).map((p) => `${p.severity}:${p.message}`);
}

describe('ラベルの長さ', () => {
  it('幅は全角を 2、半角を 1 と数える', () => {
    expect(labelWidth('集計する')).toBe(8);
    expect(labelWidth('CSV出力')).toBe(7);
    expect(labelWidth('ｱｲｳ')).toBe(3);
    expect(LARGE_LABEL_MAX_WIDTH).toBe(16);
    expect(SMALL_LABEL_MAX_CHARS).toBe(20);
  });

  it('大きいボタンは全角 8 文字まで出さず、9 文字で警告する', () => {
    expect(run('<button id="b" size="large" label="あいうえおかきく" />')).toEqual([]);
    expect(run('<button id="b" size="large" label="あいうえおかきくけ" />')).toEqual([`warning:${LARGE}`]);
    expect(run(`<button id="b" size="large" label="${'a'.repeat(16)}" />`)).toEqual([]);
    expect(run(`<button id="b" size="large" label="${'a'.repeat(17)}" />`)).toEqual([`warning:${LARGE}`]);
  });

  it('splitButton の中のボタンは、splitButton の大きさに従う', () => {
    expect(run('<splitButton id="s" size="large"><button id="b" label="とても長いラベルのボタン" /><menu id="m" /></splitButton>')).toEqual([`warning:${LARGE}`]);
  });

  it('小さいボタンは 20 文字を超えたら警告する', () => {
    expect(run(`<button id="b" label="${'あ'.repeat(20)}" />`)).toEqual([]);
    const r = run(`<button id="b" label="${'あ'.repeat(21)}" />`);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain('warning:ラベルが 21 文字あります');
  });

  it('メニューの中の項目は対象にしない', () => {
    expect(run(`<menu id="m" label="M"><button id="b" label="${'あ'.repeat(30)}" /></menu>`)).toEqual([]);
  });

  it('ラベルを出さないもの（showLabel="false"）と getShowLabel のものは見ない', () => {
    expect(run('<button id="b" size="large" showLabel="false" label="あいうえおかきくけこさしすせそ" />')).toEqual([]);
    expect(run(`<button id="b" getShowLabel="Ribbon_b_getShowLabel" label="${'あ'.repeat(25)}" />`)).toEqual([]);
    // showLabel="true" は従来どおり見る
    expect(run('<button id="b" size="large" showLabel="true" label="あいうえおかきくけ" />')).toEqual([`warning:${LARGE}`]);
  });
});
