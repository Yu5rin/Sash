import { describe, expect, it } from 'vitest';
import { exportSash, parseSash, partXml } from '../src/sashJson';
import { PartStore } from '../src/store';

const XML = '<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui">\n  <ribbon />\n</customUI>\n';

describe('.sash.json', () => {
  it('書き出して読み戻すと同じXMLと画像になる', () => {
    const store = new PartStore('office2010', XML, [{ id: 'img_b', dataUrl: 'data:image/png;base64,QUJD', isNew: false }]);
    const text = exportSash([store], 'book.xlsm');
    const json = JSON.parse(text);
    expect(json.parts[0].xml).toEqual(['<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui">', '  <ribbon />', '</customUI>']);
    const back = parseSash(text);
    expect(partXml(back.parts[0]!)).toBe(XML);
    expect(back.parts[0]!.images).toEqual([{ id: 'img_b', contentType: 'image/png', base64: 'QUJD' }]);
  });

  it('形式の違うファイルは理由つきで拒否する', () => {
    expect(() => parseSash('not json')).toThrow('JSON');
    expect(() => parseSash('{"format":"other"}')).toThrow('.sash.json');
    expect(() => parseSash('{"format":"sash-ribbon","formatVersion":99,"parts":[]}')).toThrow('新しいバージョン');
  });

  it('XML が文字列でも読める', () => {
    const f = parseSash(JSON.stringify({ format: 'sash-ribbon', formatVersion: 1, parts: [{ version: 'office2010', xml: XML, images: [] }] }));
    expect(partXml(f.parts[0]!)).toBe(XML);
  });
});
