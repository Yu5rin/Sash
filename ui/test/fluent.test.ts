import { describe, expect, it } from 'vitest';
import data from '../src/fluent/fluentIcons.json';
import {
  buildSvg, DEFAULT_COLOR, displayName, JA_KEYWORDS, jaToEnglish, normalize, safeColor, toIcons,
  type FluentData, type FluentIcon,
} from '../src/fluent/fluent';
import { searchIcons } from '../src/fluent/iconSearch';

const all = toIcons(data as unknown as FluentData);

const icon = (name: string, regular: FluentIcon['regular'] = 'M0 0h24v24H0z', filled: FluentIcon['filled'] = 'M1 1h22v22H1z', size = 24): FluentIcon => ({ name, words: name.split('_'), regular, filled, size });

describe('アイコン集のデータ', () => {
  it('パッケージの版とライセンスを持ち、2,000 個以上のアイコンがある', () => {
    const d = data as unknown as FluentData;
    expect(d.license).toBe('MIT');
    expect(d.source).toBe('@fluentui/svg-icons');
    expect(all.length).toBeGreaterThan(2000);
  });

  it('すべてのアイコンに少なくとも1つの種類がある', () => {
    expect(all.every((i) => i.regular !== 0 || i.filled !== 0)).toBe(true);
    expect(all.every((i) => i.size === 24 || i.size === 20)).toBe(true);
  });

  it('日本語の辞書の言葉は、どれも少なくとも1つのアイコンに当たる', () => {
    const misses = Object.keys(JA_KEYWORDS).filter((k) => searchIcons(all, k).length === 0);
    expect(misses).toEqual([]);
  });
});

describe('SVG の組み立て', () => {
  it('パスから色付きの SVG を作る', () => {
    const s = buildSvg(icon('save'), 'regular', '#217346')!;
    expect(s).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#217346"><path d="M0 0h24v24H0z"/></svg>');
  });

  it('大きさを指定でき、パスが複数あれば分けたまま並べる', () => {
    const s = buildSvg(icon('x', ['M0 0h1v1z', 'M2 2h1v1z']), 'regular', '#000000', 32)!;
    expect(s).toContain('width="32" height="32" viewBox="0 0 24 24"');
    expect(s.match(/<path /g)).toHaveLength(2);
  });

  it('20px のアイコンは viewBox を 20 にする', () => {
    expect(buildSvg(icon('y', 'M0 0z', 0, 20), 'regular', '#000000')).toContain('viewBox="0 0 20 20"');
  });

  it('その種類がなければ null', () => {
    expect(buildSvg(icon('z', 'M0 0z', 0), 'filled', '#000000')).toBeNull();
  });

  it('色は #rrggbb 以外を既定の色にする（属性に入れるので）', () => {
    expect(safeColor('"/><script>')).toBe(DEFAULT_COLOR);
    expect(safeColor('#ABCDEF')).toBe('#abcdef');
    expect(buildSvg(icon('save'), 'regular', 'red" onload="x')).toContain(`fill="${DEFAULT_COLOR}"`);
  });

  it('パスのデータに想定外の文字があれば使わない', () => {
    expect(buildSvg(icon('bad', 'M0 0"/><script>'), 'regular', '#000000')).toBeNull();
  });

  it('実際のデータから組み立てた SVG を DOM で読める', () => {
    const save = all.find((i) => i.name === 'save')!;
    const s = buildSvg(save, 'filled', '#424242', 32)!;
    const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.getAttribute('fill')).toBe('#424242');
    expect(doc.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('表示名は単語をスペースで区切る', () => {
    expect(displayName('arrow_clockwise')).toBe('arrow clockwise');
  });
});

describe('検索', () => {
  const sample = [icon('save'), icon('save_arrow_right'), icon('document_save'), icon('arrow_sync'), icon('arrow_clockwise'), icon('folder'), icon('folder_open'), icon('table'), icon('table_add', 'M0 0z', 0), icon('upload')];
  const names = (q: string, variant?: 'regular' | 'filled') => searchIcons(sample, q, variant).map((i) => i.name);

  it('Object.prototype にある名前（constructor・__proto__・toString など）でも落ちない', () => {
    for (const q of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'constructor save', '__proto__ 保存']) {
      expect(() => names(q)).not.toThrow();
      expect(() => searchIcons(all, q)).not.toThrow();
    }
    expect(names('constructor')).toEqual([]);
    expect(names('tostring')).toEqual([]);
    expect(jaToEnglish('constructor')).toEqual([]);
  });

  it('空の検索は名前順の全件', () => {
    expect(names('')).toEqual([...sample.map((i) => i.name)].sort());
  });

  it('英語は単語の先頭一致で、先頭の単語に当たるものを上にする', () => {
    expect(names('save')).toEqual(['save', 'save_arrow_right', 'document_save']);
    expect(names('fold')).toEqual(['folder', 'folder_open']);
  });

  it('空白で区切った語はすべてに合うものだけ（AND）', () => {
    expect(names('folder open')).toEqual(['folder_open']);
    expect(names('arrow save')).toEqual(['save_arrow_right']);
  });

  it('単語の途中には3文字以上で当たる', () => {
    expect(names('load')).toEqual(['upload']);
    expect(names('lo')).toEqual([]);
  });

  it('日本語は辞書で英単語に置き換える', () => {
    expect(names('保存')).toEqual(['save', 'save_arrow_right', 'document_save']);
    expect(names('更新')).toEqual(['arrow_sync', 'arrow_clockwise']);
    expect(names('表')).toEqual(['table', 'table_add']);
  });

  it('言い回しの付いた語、入力途中、ひらがな、長音の揺れ、全角英字でも当たる', () => {
    expect(names('保存する')[0]).toBe('save');
    expect(names('フォル')).toEqual(['folder', 'folder_open']);
    expect(names('ふぉるだ')).toEqual(['folder', 'folder_open']);
    expect(names('フォルダ')).toEqual(['folder', 'folder_open']);
    expect(names('ＳＡＶＥ')[0]).toBe('save');
  });

  it('1文字の語は完全に一致したときだけ使う（「上書き」で「上」に当てない）', () => {
    expect(jaToEnglish('上書き')).toEqual(['save']);
    expect(jaToEnglish('上')).toContain('arrow_up');
  });

  it('日本語と英語を混ぜられる', () => {
    expect(names('フォルダー open')).toEqual(['folder_open']);
  });

  it('辞書にない日本語は何も返さない', () => {
    expect(names('存在しない言葉')).toEqual([]);
  });

  it('種類を指定すると、その種類があるものだけ', () => {
    expect(names('table', 'filled')).toEqual(['table']);
    expect(names('table', 'regular')).toEqual(['table', 'table_add']);
  });

  it('実際のデータで、よく使う言葉が期待どおりのアイコンを先頭に出す', () => {
    expect(searchIcons(all, '保存')[0]!.name).toBe('save');
    expect(searchIcons(all, '印刷')[0]!.name).toBe('print');
    expect(searchIcons(all, 'メール')[0]!.name).toBe('mail');
    expect(searchIcons(all, 'フィルター')[0]!.name).toBe('filter');
    expect(searchIcons(all, '停止')[0]!.name).toBe('stop');
    expect(searchIcons(all, '更新')[0]!.name).toBe('arrow_sync');
    expect(searchIcons(all, 'グラフ').length).toBeGreaterThan(10);
  });

  it('正規化：全角半角・大文字小文字・ひらがな', () => {
    expect(normalize(' ＡＢｃ ')).toBe('abc');
    expect(normalize('ほぞん')).toBe('ホゾン');
  });
});
