// XML の構文エラーの文を日本語にする（XML エディタの帯と、下部パネルの問題一覧で同じ文にするため、Monaco に依存しない小さなモジュールに分ける）。

import { lang } from './i18n';

/**
 * XML の構文エラーの文（Chromium＝libxml2 の英語）を、よく出るものだけ日本語にする。
 * 日本語表示のときだけ変える。英語表示では原文のほうが検索しやすく、辞書にも載せない。
 * 知らない文はそのまま返す（誤訳するより原文を見せるほうがよいため）。
 */
export function describeXmlError(message: string): string {
  if (lang !== 'ja') return message;
  // 名前空間付きの名前は {uri}name の形で来る。読みにくいので名前だけにする
  const bare = (n: string) => n.replace(/\{[^}]*\}/g, '');
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    // 現在の Chromium（WebView2）の文
    [/Unexpected closing tag:\s*(\S+) != (\S+)/i, (m) => `閉じタグ </${bare(m[1]!)}> に対応する開始タグが <${bare(m[2]!)}> です。閉じ忘れか、タグ名の違いです`],
    [/Unexpected end of stream: still inside the root element/i, () => '閉じられていないタグがあります。閉じタグを足してください'],
    [/Unexpected end of stream: no root element found/i, () => 'XML が空です'],
    [/Unexpected end of stream/i, () => 'タグや引用符が閉じられないまま、XML が終わっています'],
    [/Unexpected token inside qualified name:\s*\/?>/i, () => '属性に値がありません（名前="値" の形にしてください）'],
    // 開始タグの中に「<」が来た。いちばん多い原因は、直前のタグの「>」の閉じ忘れ（<button id="a" <button …）
    [/Unexpected token inside opening tag:\s*<?\s*$/i, () => '開始タグの中に予期しない文字があります（> の閉じ忘れの可能性）'],
    [/Unexpected token inside opening tag/i, () => '開始タグの中に予期しない文字があります'],
    [/Unexpected token inside qualified name/i, () => 'タグ名や属性名の途中に使えない文字があります'],
    [/Unexpected token inside entity/i, () => '「&」の使い方が正しくありません（文字としての「&」は &amp; にしてください）'],
    [/Unexpected token '--' before/i, () => 'コメントの中に「--」は書けません'],
    [/Unexpected token '<' before/i, () => '属性の値に「<」は書けません（&lt; にしてください）'],
    [/Unexpected token '([^']*)' before '([^']*)'/i, (m) => `「${m[2]}」の前に、予期しない文字「${m[1]}」があります`],
    [/Unexpected characters outside the root element/i, () => 'ルート要素の外に余分な文字があります'],
    [/Unexpected token:\s*(<\/?|[<>])\s*$/i, (m) => `予期しない「${m[1]}」があります（タグの閉じ忘れや、余分なタグがないか確かめてください）`],
    [/Unexpected token:\s*(\S+)/i, (m) => `予期しない文字「${m[1]}」があります（属性の値は " で囲んでいるか確かめてください）`],
    [/Attribute '([^']+)' is redefined/i, (m) => `属性 ${m[1]} が同じタグに二重に書かれています`],
    [/Element (\S+) prefix is unbound/i, (m) => `名前空間の接頭辞が定義されていません（${m[1]}）`],
    [/Qualified name is invalid/i, () => 'タグ名・属性名が正しくありません（文字としての「<」は &lt; にしてください）'],
    // 以前の libxml2 系の文（古い WebView2 など）
    [/Opening and ending tag mismatch:\s*(\S+) line (\d+) and (\S+)/i, (m) => `<${m[1]}>（${m[2]}行目）の閉じタグが <${m[3]}> になっています。閉じ忘れか、タグ名の違いです`],
    [/Premature end of data in tag (\S+) line (\d+)/i, (m) => `<${m[1]}>（${m[2]}行目）が閉じられないままファイルが終わっています。閉じタグを足してください`],
    [/Premature end of data/i, () => '閉じられていないタグがあります。閉じタグを足してください'],
    [/Couldn't find end of Start Tag (\S+)/i, (m) => `<${m[1]}> の開始タグが「>」で閉じられていません`],
    [/AttValue: ["'] or ["'] expected/i, () => '属性の値が引用符（" または \'）で囲まれていません'],
    [/Specification mandates value for attribute (\S+)/i, (m) => `属性 ${m[1]} に値がありません（${m[1]}="…" の形にしてください）`],
    [/Unescaped '<' not allowed in attributes values/i, () => '属性の値に「<」は書けません（&lt; にしてください）'],
    [/attributes construct error/i, () => '属性の書き方が正しくありません（引用符や「=」の抜けを確かめてください）'],
    [/Attribute (\S+) redefined/i, (m) => `属性 ${m[1]} が同じタグに二重に書かれています`],
    [/Extra content at the end of the document/i, () => 'ルート要素のあとに余分な内容があります（閉じタグが多いか、ルートが 2 つあります）'],
    [/Start tag expected, '<' not found/i, () => '先頭が「<」で始まっていません'],
    [/Document is empty/i, () => 'XML が空です'],
    [/StartTag: invalid element name/i, () => '「<」のあとのタグ名が正しくありません（文字としての「<」は &lt; にしてください）'],
    [/xmlParseEntityRef: no name|EntityRef: expecting ';'/i, () => '「&」の使い方が正しくありません（文字としての「&」は &amp; にしてください）'],
    [/Namespace prefix (\S+) (?:on (\S+) )?is not defined/i, (m) => `名前空間の接頭辞 ${m[1]} が定義されていません`],
    [/Double hyphen within comment/i, () => 'コメントの中に「--」は書けません'],
    [/Comment not terminated/i, () => 'コメントが「-->」で閉じられていません'],
    [/expected '>'/i, () => '「>」が必要です'],
    [/Unexpected end tag\s*:?\s*(\S+)?/i, (m) => `対応する開始タグのない閉じタグがあります${m[1] ? `（${m[1]}）` : ''}`],
  ];
  for (const [re, f] of rules) {
    const m = re.exec(message);
    if (m) return message.slice(0, m.index) + f(m) + message.slice(m.index + m[0].length);
  }
  return message;
}
