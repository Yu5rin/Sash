// ラベルからアイコンの候補を出す（インスペクタのアイコン欄）。純粋な処理にして、並び順をテストできるようにする。
// 何千もの imageMso やアイコン集から一から探すのは手間なので、ラベルの言葉から「たぶんこれ」を数個だけ先に見せる。

import { jaTermsInText, normalize, searchIcons, type FluentIcon } from './fluent/fluent';

/** 候補の数。インスペクタは幅が狭いので、1行に収まる数にする。 */
export const SUGGEST_LIMIT = 5;

/** ラベルの中の英数字の語（「CSV出力」の csv など）。 */
function asciiWords(label: string): string[] {
  return (label.normalize('NFKC').match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).map((w) => w.toLowerCase());
}

/** ラベルから探す英単語。日本語の言葉は辞書で英単語に置き換え、英数字の語はそのまま使う。 */
export function suggestTerms(label: string): string[] {
  const out: string[] = [];
  for (const term of [...jaTermsInText(label), ...asciiWords(label)]) if (!out.includes(term)) out.push(term);
  return out;
}

/** imageMso の名前を単語に分ける（FileSaveAs → file, save, as）。 */
function msoWords(name: string): string[] {
  return name.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|_/).map((w) => w.toLowerCase()).filter(Boolean);
}

/**
 * imageMso の候補。次の2つで点を付け、高い順に返す。
 * 1. Excel から取得した日本語の表示名（labels）がラベルと一致・包含するもの。Excel 自身の名前なので、当たれば確かさが高い
 * 2. ラベルの言葉を英単語にしたものが、imageMso の名前の単語に含まれるもの（「保存」→ save → FileSave）
 * 表示名は Excel がある PC でしか取れないので、2 は Excel がなくても候補を出すための手立て。
 */
export function suggestImageMso(label: string, names: readonly string[], labels: ReadonlyMap<string, string>, limit = SUGGEST_LIMIT): string[] {
  const q = normalize(label);
  if (!q) return [];
  const terms = suggestTerms(label);
  // group は当たった手がかり（-1 は Excel の表示名、0 以上は何番目の言葉か）。言葉ごとに交互に取るために使う
  const scored: { name: string; score: number; group: number }[] = [];
  for (const name of names) {
    let score = 0;
    let group = -1;
    const ja = labels.get(name);
    if (ja) {
      const l = normalize(ja);
      if (l === q) score = 100;
      else if (l.length >= 2 && q.includes(l)) score = 50 + l.length * 4;
      else if (q.length >= 2 && l.includes(q)) score = 45 + q.length * 4 - (l.length - q.length);
    }
    if (terms.length) {
      const words = msoWords(name);
      const joined = words.join('');
      terms.forEach((term, i) => {
        const parts = term.split('_');
        const termJoined = parts.join('');
        // 単語ごとに合うか、つないだ形で名前に含まれるか（辞書の autosum が AutoSum に当たるように）
        const byWords = parts.every((p) => words.includes(p));
        if (!byWords && !(termJoined.length >= 4 && joined.includes(termJoined))) return;
        const covered = words.filter((w) => termJoined.includes(w)).length;
        // 言葉に関係のない単語が多い名前（InkToolboxWithEraserAndLasso など）は、たまたま一語が合っただけなので出さない
        if (words.length - covered > 2) return;
        // 先に出てくる言葉ほどラベルの主題なので高くし、名前の単語が少ないもの（素直な形）を上にする
        let s = 40 - i * 4 - (words.length - covered) * 2;
        if (termJoined.startsWith(words[0]!)) s += 3;
        // FileSave のように「名前のすべてが言葉に含まれる」ものは、さらに上にする
        if (covered === words.length) s += 6;
        if (s > score) {
          score = s;
          group = i;
        }
      });
    }
    if (score > 0) scored.push({ name, score, group });
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  // Excel の表示名で当たったものを先に出し、残りは言葉ごとに交互に取る
  // （「集計して保存」で AutoSum の仲間ばかりが並ばず、保存の候補も入るように）
  const out = scored.filter((x) => x.group < 0).slice(0, limit).map((x) => x.name);
  const lists = terms.map((_t, i) => scored.filter((x) => x.group === i).map((x) => x.name));
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const name = l[i];
      if (name && !out.includes(name) && out.length < limit) out.push(name);
    }
  }
  return out;
}

/**
 * アイコン集（Fluent）の候補。言葉ごとに searchIcons で探し、言葉の順に1つずつ交互に取る
 * （最初の言葉の候補だけで埋まらず、「CSV出力」なら出力と CSV の両方の候補が並ぶように）。
 */
export function suggestFluent(icons: readonly FluentIcon[], label: string, limit = SUGGEST_LIMIT): FluentIcon[] {
  const lists = suggestTerms(label).map((term) => searchIcons(icons, term, 'regular').slice(0, limit));
  const out: FluentIcon[] = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const icon = l[i];
      if (icon && !out.includes(icon)) out.push(icon);
      if (out.length >= limit) break;
    }
  }
  return out;
}
