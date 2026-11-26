// アイコン集の検索。「お金」「配送」「ねこ」のようなあいまいな言葉から、関係するアイコンを絞り込む。
// 画面に依存しない純粋な処理にして、テストできるようにする（速さも測る）。
//
// 考え方：
// 1. 入力を正規化し（全角半角・大文字小文字・ひらがな→カタカナ・長音）、空白と文字種の境目で語に分ける。
// 2. 語ごとに「概念の辞書」（iconConcepts.ts）で英語の言葉に広げる。広げた言葉には重みを付ける
//    （辞書の先頭ほど代表的な意味なので重い。入力の途中や言い回しの付いた語は少し軽い）。
//    英語の語はそのまま探す。
// 3. 広げた言葉ごとに、アイコンの「名前の単語」「タグ」「カテゴリ」に当たるかを見て点を付ける。
//    名前に完全に一致 > 名前の単語に一致 > タグに一致 > カテゴリに一致 > 前方一致 > 部分一致 の順に高い。
//    1つの語に当たった広げた言葉が複数あるアイコンは、少しだけ上げる（「お金」ならコインが、タグに money・cash・currency を持つので上に来る）。
// 4. 複数の語はすべてに当たるものだけ残し（AND）、点の合計の順に並べる。
//
// 速さのために、アイコンの数が増えても重くならないよう、単語 → アイコンの索引を最初に1度だけ作る（単語の全探索をしない）。
// 前方一致は、並べておいた単語の一覧を二分探索して、当たる範囲だけを見る。

import type { FluentIcon, FluentVariant, IconSet } from './fluent';
import { categoryBit, CATEGORIES, categorize } from './iconCategories';
import { CONCEPTS } from './iconConcepts';
import { JA_KEYWORDS, normalize } from './iconWords';

// ---- 概念の辞書 ----

interface Entry {
  /** 正規化した見出し（ひらがな→カタカナ、長音なし）。 */
  key: string;
  /** 長音（ー）を残した正規化の見出し。「ビル」と「ビール」のように、長音だけが違う別の語を区別するため。 */
  raw: string;
  /** 英語の言葉。_ は - にそろえてある。ハイフンつきは「名前の中でその順に並ぶ単語」を表す。 */
  terms: readonly string[];
  /** 利用者に見せる見出し（概念の最初の言葉）。 */
  display: string;
  /** 概念がこのカテゴリのアイコンだけを指すとき、そのカテゴリの id（食べ物など。下の FOOD_CONCEPTS）。 */
  category?: string;
}

/**
 * 食べ物の概念（見出しの最初の言葉）。これらは「食べ物のカテゴリのアイコン」だけに当てる。
 * 「ばなな」→ apple の言葉がタグ（apple）として device-imac など機器のアイコンにも当たってしまうため。
 * カテゴリが分かっているアイコンだけを絞る（カテゴリの割り当てがない＝その他、のアイコンは出さない）。
 */
const FOOD_CONCEPTS: ReadonlySet<string> = new Set(['食べ物', '飲み物', 'コーヒー', 'ビール', '肉', '野菜', '果物', '米', 'ハンバーガー', '調味料']);

/**
 * ある言葉のアイコンのうち、言葉の意味ではないものを外す（言葉 → 名前に含まれると外す単語）。
 * 「印刷」→ print が、動物の足跡（animal_paw_print）の print にも当たって上位に出るため。
 */
const NOISE_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  print: new Set(['paw']),
};

function stripLong(text: string): string {
  return text.replace(/ー/g, '');
}

function normTerm(term: string): string {
  return term.toLowerCase().replace(/_/g, '-');
}

let entries: Entry[] | null = null;

/** 辞書の見出しの一覧。初めて検索したときに1度だけ作る（読み込み時に作ると、使わない画面でも時間を使うため）。 */
function dictionary(): readonly Entry[] {
  if (entries) return entries;
  const list: Entry[] = [];
  for (const [keys, terms] of CONCEPTS) {
    const ks = keys.split('/');
    const ts = terms.split(' ').filter(Boolean).map(normTerm);
    const category = FOOD_CONCEPTS.has(ks[0]!) ? 'food' : undefined;
    for (const k of ks) list.push({ key: stripLong(normalize(k)), raw: normalize(k), terms: ts, display: ks[0]!, ...(category ? { category } : {}) });
  }
  // 昔からある小さな辞書（JA_KEYWORDS）も使う。新しい辞書にない言葉を取りこぼさないため
  for (const [k, v] of Object.entries(JA_KEYWORDS)) list.push({ key: stripLong(normalize(k)), raw: normalize(k), terms: v.map(normTerm), display: k });
  entries = list;
  return list;
}

/** 概念の数（見出しの数ではなく、意味のまとまりの数）。 */
export const CONCEPT_COUNT = CONCEPTS.length;

export interface ExpandedTerm {
  /** 探す英語の言葉。 */
  term: string;
  /** 重み（0〜1）。 */
  weight: number;
  /** どの見出しから来たか（ヒント表示用。英語の語をそのまま探すときは空）。 */
  from: string;
  /** このカテゴリのアイコンだけに当てる（食べ物の概念）。 */
  category?: string;
}

/** 辞書の何番目の言葉かによる重み。先頭ほど代表的な意味。 */
function positionWeight(i: number): number {
  return Math.max(0.45, 1 - i * 0.045);
}

/** 1つの語（正規化済み）を、探す英語の言葉に広げる。 */
export function expandToken(token: string): ExpandedTerm[] {
  const q = stripLong(token);
  if (!q) return [];
  const out = new Map<string, ExpandedTerm>();
  const put = (term: string, weight: number, from: string, category?: string) => {
    const old = out.get(term);
    if (!old || old.weight < weight) out.set(term, category ? { term, weight, from, category } : { term, weight, from });
  };
  const ascii = /^[a-z0-9_-]+$/.test(q);
  if (ascii) {
    // 1文字（a・5 など）は、その文字のアイコン（letter-a・number-5）に絞る。1文字で単語の前方一致をすると何にでも当たるため
    if (q.length === 1) {
      put(/[0-9]/.test(q) ? `number-${q}` : `letter-${q}`, 1, '');
      return [...out.values()];
    }
    put(q.replace(/_/g, '-'), 1, '');
  }
  const hits: { entry: Entry; quality: number }[] = [];
  for (const e of dictionary()) {
    const k = e.key;
    let quality = 0;
    if (k === q) quality = 1;
    else if (!ascii) {
      // 入力の途中（「はいそ」→配送）、言い回しの付いた語（「保存する」）、語の中に見出しを含むもの（「売上集計」）
      if (q.length >= 2 && k.startsWith(q)) quality = 0.8;
      else if (k.length >= 2 && q.startsWith(k)) quality = 0.9;
      else if (k.length >= 2 && q.length > k.length && q.includes(k)) quality = 0.75;
    }
    if (quality > 0) hits.push({ entry: e, quality });
  }
  // 見出しにそのまま一致するものがあれば、それだけを使う（「ログイン」で、前方が同じ「ログ」＝履歴まで広がらないように）
  if (hits.some((h) => h.quality === 1)) hits.splice(0, hits.length, ...hits.filter((h) => h.quality === 1));
  // 長音まで同じ見出しがあれば、それだけを使う（「ビル」で建物、「ビール」で飲み物。長音を除くと同じ語になるため）。なければ長音の違いは無視する（フォルダー／フォルダ）
  if (hits.some((h) => h.entry.raw === token)) hits.splice(0, hits.length, ...hits.filter((h) => h.entry.raw === token));
  // 入力が短いと前方一致が大量に当たるので、確かなもの・短い（近い）ものから最大 8 つの見出しだけ使う
  hits.sort((a, b) => b.quality - a.quality || a.entry.key.length - b.entry.key.length);
  for (const { entry, quality } of hits.slice(0, 8)) {
    entry.terms.forEach((term, i) => put(term, quality * positionWeight(i), entry.display, entry.category));
  }
  return [...out.values()];
}

// ---- 索引 ----

export interface Index {
  icons: readonly FluentIcon[];
  /** '-save-arrow-' のように前後にハイフンを付けた名前（ハイフンつきの言葉を、単語の区切りどおりに探すため）。 */
  nameKey: string[];
  nameWords: Map<string, number[]>;
  nameVocab: string[];
  tagWords: Map<string, number[]>;
  tagVocab: string[];
  catWords: Map<string, number[]>;
  /** カテゴリのビット。 */
  cats: Int32Array;
  sortKey: string[];
  wordCount: Uint8Array;
  setRank: Uint8Array;
}

const SET_RANK: Readonly<Record<IconSet, number>> = { sash: 0, fluent: 1, tabler: 2, lucide: 3 };

const indexCache = new WeakMap<readonly FluentIcon[], Index>();

function push(map: Map<string, number[]>, key: string, code: number): void {
  const list = map.get(key);
  if (list) list.push(code);
  else map.set(key, [code]);
}

/** 索引を作る（同じ配列なら1度だけ）。ピッカーを開いて読み込みが終わったらすぐ呼んでおくと、最初の検索が速い。 */
export function buildIndex(icons: readonly FluentIcon[]): Index {
  const cached = indexCache.get(icons);
  if (cached) return cached;
  const n = icons.length;
  const idx: Index = {
    icons,
    nameKey: new Array<string>(n),
    nameWords: new Map(),
    nameVocab: [],
    tagWords: new Map(),
    tagVocab: [],
    catWords: new Map(),
    cats: new Int32Array(n),
    sortKey: new Array<string>(n),
    wordCount: new Uint8Array(n),
    setRank: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const icon = icons[i]!;
    const set = icon.set ?? 'fluent';
    idx.nameKey[i] = `-${icon.words.join('-')}-`;
    idx.sortKey[i] = icon.name.replace(/\d+/g, (m) => m.padStart(4, '0'));
    idx.wordCount[i] = Math.min(255, icon.words.length);
    // 同じ点のときの並び：Sash のオリジナル（目的を絞って描いたもの）> Fluent > Tabler > Lucide
    idx.setRank[i] = SET_RANK[set];
    icon.words.forEach((w, pos) => push(idx.nameWords, w, i * 8 + Math.min(pos, 7)));
    (icon.tags ?? []).forEach((tag, pos) => {
      const p = Math.min(pos, 127);
      push(idx.tagWords, tag, i * 256 + p);
      if (tag.includes('-')) for (const part of tag.split('-')) if (part) push(idx.tagWords, part, i * 256 + 128 + p);
    });
    const mask = categorize(icon);
    idx.cats[i] = mask;
    for (const c of CATEGORIES) {
      if ((mask & categoryBit(c.id)) === 0) continue;
      for (const w of c.words) push(idx.catWords, w, i);
    }
    if (icon.tablerCategory) push(idx.catWords, icon.tablerCategory.toLowerCase().replace(/\s+/g, '-'), i);
  }
  idx.nameVocab = [...idx.nameWords.keys()].sort();
  idx.tagVocab = [...idx.tagWords.keys()].sort();
  indexCache.set(icons, idx);
  return idx;
}

/** 並べた単語の一覧から、prefix で始まるものの範囲（先頭の位置）を二分探索で探す。 */
function lowerBound(sorted: readonly string[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---- 点の付け方 ----
// 数字は「名前に当たる > タグに当たる > カテゴリに当たる」の順になるように決めた。値そのものに意味はなく、順序が大事。

const S_NAME_EXACT = 16; // 名前が言葉と同じ（単語1つの名前）
const S_NAME_WORD = 10; // 名前の単語が言葉と同じ
const S_NAME_FIRST = 3; // 先頭の単語なら加える（先頭の単語が主題）
const S_NAME_PREFIX = 6; // 名前の単語が言葉で始まる
const S_PHRASE_EXACT = 16;
const S_PHRASE_START = 11;
const S_PHRASE_IN = 8;
const S_TAG = 7; // タグが言葉と同じ（先頭のタグほど主題）
const S_TAG_PART = 4; // ハイフンつきのタグの一部が言葉と同じ
const S_CAT = 3;
const S_TAG_PREFIX = 3;
const S_NAME_SUB = 2;
const S_TAG_SUB = 1;

/** 複数の言葉に当たったときの加点の割合と、その上限（最高点に対する割合）。小さくして、名前の完全一致が加点で抜かれないようにする。 */
const BONUS_RATE = 0.06;
const BONUS_CAP = 0.25;

interface TokenScore {
  best: Float32Array;
  bonus: Float32Array;
  /** 最高点をつけた言葉（expanded の番号。-1 は未設定）。 */
  via: Int16Array;
}

function scoreToken(idx: Index, expanded: readonly ExpandedTerm[], typed: boolean): TokenScore {
  const n = idx.icons.length;
  const ts: TokenScore = { best: new Float32Array(n), bonus: new Float32Array(n), via: new Int16Array(n).fill(-1) };
  const hit = (i: number, s: number, ti: number) => {
    const e = expanded[ti]!;
    // 食べ物の概念は食べ物のカテゴリだけ。意味の違う同名の単語（paw print など）も外す
    if (e.category && (idx.cats[i]! & categoryBit(e.category)) === 0) return;
    // 利用者が英語で打った言葉（from が空）は外さない（「paw print」で探せるように）
    const noise = e.from ? NOISE_WORDS[e.term] : undefined;
    if (noise && idx.icons[i]!.words.some((w) => noise.has(w))) return;
    if (s > ts.best[i]!) {
      ts.best[i] = s;
      ts.via[i] = ti;
    }
    ts.bonus[i] = ts.bonus[i]! + s * BONUS_RATE;
  };
  expanded.forEach((e, ti) => {
    const term = e.term;
    const w = e.weight;
    if (term.includes('-')) {
      // 単語の並び：名前の中に、その順に並んでいるものだけ
      const inner = `-${term}-`;
      for (let i = 0; i < n; i++) {
        const key = idx.nameKey[i]!;
        if (key === inner) hit(i, S_PHRASE_EXACT * w, ti);
        else if (key.startsWith(inner)) hit(i, S_PHRASE_START * w, ti);
        else if (key.includes(inner)) hit(i, S_PHRASE_IN * w, ti);
      }
      for (const code of idx.tagWords.get(term) ?? []) hit(Math.floor(code / 256), (S_TAG - Math.min(code % 128, 10) * 0.25) * w, ti);
      return;
    }
    // 名前の単語：完全一致
    for (const code of idx.nameWords.get(term) ?? []) {
      const i = Math.floor(code / 8);
      const pos = code % 8;
      hit(i, (idx.wordCount[i] === 1 ? S_NAME_EXACT : S_NAME_WORD + (pos === 0 ? S_NAME_FIRST : 0)) * w, ti);
    }
    // タグ：完全一致
    for (const code of idx.tagWords.get(term) ?? []) {
      const part = (code % 256) >= 128;
      const p = Math.min(code % 128, 10);
      hit(Math.floor(code / 256), (part ? S_TAG_PART - p * 0.1 : S_TAG - p * 0.25) * w, ti);
    }
    for (const i of idx.catWords.get(term) ?? []) hit(i, S_CAT * w, ti);
    // 前方一致と部分一致は、利用者が打った英語の言葉だけ。辞書で広げた言葉に使うと、car が card・cart・category に、
    // plane が planet に当たるなど、関係のないものまで広く当たってしまう
    if (!typed || term.length < 2) return;
    // 前方一致（名前の単語・タグ・カテゴリ）
    for (let v = lowerBound(idx.nameVocab, term); v < idx.nameVocab.length; v++) {
      const word = idx.nameVocab[v]!;
      if (!word.startsWith(term)) break;
      if (word === term) continue;
      for (const code of idx.nameWords.get(word)!) hit(Math.floor(code / 8), (S_NAME_PREFIX + (code % 8 === 0 ? 2 : 0)) * w, ti);
    }
    if (term.length >= 3) {
      for (let v = lowerBound(idx.tagVocab, term); v < idx.tagVocab.length; v++) {
        const word = idx.tagVocab[v]!;
        if (!word.startsWith(term)) break;
        if (word === term) continue;
        for (const code of idx.tagWords.get(word)!) hit(Math.floor(code / 256), S_TAG_PREFIX * w, ti);
      }
    }
    if (term.length >= 3) {
      for (const word of idx.nameVocab) {
        if (word.length > term.length && word.includes(term) && !word.startsWith(term)) for (const code of idx.nameWords.get(word)!) hit(Math.floor(code / 8), S_NAME_SUB * w, ti);
      }
      for (const word of idx.tagVocab) {
        if (word.length > term.length && word.includes(term) && !word.startsWith(term)) for (const code of idx.tagWords.get(word)!) hit(Math.floor(code / 256), S_TAG_SUB * w, ti);
      }
    }
  });
  return ts;
}

// ---- 検索 ----

export interface IconHit {
  icon: FluentIcon;
  score: number;
  /** 当たった理由（例：「お金 → money」）。上位の数百件だけ付ける。 */
  via: string;
}

export interface SearchOptions {
  /** 線 / 塗り。指定すると、その種類があるものだけ。 */
  variant?: FluentVariant;
  /** 出どころ。省略か 'all' なら両方。 */
  set?: IconSet | 'all';
  /** カテゴリの id（'all' か省略なら絞らない）。 */
  category?: string;
}

export interface SearchResult {
  hits: IconHit[];
  /** カテゴリごとの件数（カテゴリで絞る前の、検索語・出どころ・種類で絞った結果の中の数）。 */
  counts: Readonly<Record<string, number>>;
  /** 絞る前の件数。 */
  total: number;
  /** すべての語に合うものがほとんどなく、いずれかに合うものを出したとき。 */
  relaxed: boolean;
}

/** 当たった理由を付ける上位の件数。全件に文字列を作ると無駄なので。 */
const VIA_LIMIT = 400;

/** 入力を語に分ける。空白・読点・中黒で区切り、英数字と日本語の境目でも分ける（「CSV出力」→ csv / 出力）。 */
export function splitQuery(query: string): { raw: string; norm: string }[] {
  const out: { raw: string; norm: string }[] = [];
  // R&D・Q&A・M&A のように、1 文字の英字どうしをはさむ & は 1 語（randd・qanda・manda）として扱う（& で分けると 1 文字ずつの検索になるため）。
  // Q&A は QA（品質保証）とは別の語。drag&drop・black&white のように、長い語をはさむ & は今までどおり分ける
  const text = query.normalize('NFKC').replace(/(?<![A-Za-z])([A-Za-z])&([A-Za-z])(?![A-Za-z])/g, '$1and$2');
  for (const chunk of text.split(/[\s、。,，・/／]+/)) {
    // 英数字と日本語が続いた 1 語（Web会議・Excel出力）が、辞書の見出しそのものなら、分けずに 1 語として探す
    if (/[A-Za-z0-9]/.test(chunk) && /[^\x00-\x7f]/.test(chunk)) {
      const whole = normalize(chunk);
      const wk = stripLong(whole);
      if (whole && dictionary().some((e) => e.key === wk)) {
        out.push({ raw: chunk, norm: whole });
        continue;
      }
    }
    for (const part of chunk.match(/[A-Za-z0-9_-]+|[^A-Za-z0-9_\-]+/g) ?? []) {
      const norm = normalize(part);
      if (norm) out.push({ raw: part, norm });
    }
  }
  return out;
}

const EMPTY_COUNTS: Readonly<Record<string, number>> = {};

export function searchIconSet(icons: readonly FluentIcon[], query: string, opts: SearchOptions = {}): SearchResult {
  const idx = buildIndex(icons);
  const n = icons.length;
  const variant = opts.variant;
  const setFilter = opts.set && opts.set !== 'all' ? opts.set : null;
  const catBit = opts.category && opts.category !== 'all' ? categoryBit(opts.category) : 0;
  const tokens = splitQuery(query);
  const total = new Float32Array(n);
  const viaInfo: { raw: string; expanded: ExpandedTerm[]; ts: TokenScore }[] = [];

  let alive: Uint8Array | null = null;
  let relaxed = false;
  if (tokens.length > 0) {
    const scored: TokenScore[] = [];
    for (const tok of tokens) {
      const expanded = expandToken(tok.norm);
      if (expanded.length === 0 && tokens.length === 1) return { hits: [], counts: EMPTY_COUNTS, total: 0, relaxed: false };
      const typed = /^[a-z0-9_-]+$/.test(tok.norm);
      const ts = scoreToken(idx, expanded, typed);
      // 辞書で広げた語は、関係の薄い末尾（最高点の4分の1に満たないもの）を落とす。広く当たる言葉（box など）で長い尾が付くため
      if (expanded.some((e) => e.from)) {
        let top = 0;
        for (let i = 0; i < n; i++) if (ts.best[i]! > top) top = ts.best[i]!;
        const floor = top * 0.25;
        for (let i = 0; i < n; i++) if (ts.best[i]! < floor) ts.best[i] = 0;
      }
      viaInfo.push({ raw: tok.raw, expanded, ts });
      scored.push(ts);
    }
    // すべての語に合うもの（AND）。1つも残らないときは、いずれかに合うもの（OR）に広げる（「CSV出力」のように、
    // 同じアイコンに並んで当たらない語の組み合わせでも、何か出るように）。辞書にない語は、そのとき無視される
    const every = new Uint8Array(n).fill(1);
    const any = new Uint8Array(n);
    const sum = new Float32Array(n);
    for (const ts of scored) {
      for (let i = 0; i < n; i++) {
        const b = ts.best[i]!;
        if (b === 0) every[i] = 0;
        else {
          any[i] = 1;
          // 当たった言葉が多いほど少し上げる（上げ幅は最高点の4分の1まで）
          sum[i] = sum[i]! + b + Math.min(ts.bonus[i]! - b * BONUS_RATE, b * BONUS_CAP);
        }
      }
    }
    let andCount = 0;
    for (let i = 0; i < n; i++) andCount += every[i]!;
    if (andCount === 0 && tokens.length > 1) {
      relaxed = true;
      alive = any;
      // AND に合うものは上に出す
      for (let i = 0; i < n; i++) total[i] = sum[i]! + (every[i] ? 1000 : 0);
    } else {
      alive = every;
      total.set(sum);
    }
  }

  const counts: Record<string, number> = {};
  const ids: number[] = [];
  let all = 0;
  for (let i = 0; i < n; i++) {
    if (alive && !alive[i]) continue;
    const icon = icons[i]!;
    if (variant && icon[variant] === 0) continue;
    if (setFilter && (icon.set ?? 'fluent') !== setFilter) continue;
    all++;
    const mask = idx.cats[i]!;
    for (const c of CATEGORIES) if ((mask & categoryBit(c.id)) !== 0) counts[c.id] = (counts[c.id] ?? 0) + 1;
    if (catBit && (mask & catBit) === 0) continue;
    ids.push(i);
  }
  const byName = (a: number, b: number) => (idx.sortKey[a]! < idx.sortKey[b]! ? -1 : idx.sortKey[a]! > idx.sortKey[b]! ? 1 : 0) || idx.setRank[a]! - idx.setRank[b]!;
  // 検索語がなければ名前順。あれば、点の高い順（同じ点なら、単語の少ない素直な名前、Fluent、名前順）
  if (tokens.length === 0) ids.sort(byName);
  else ids.sort((a, b) => total[b]! - total[a]! || idx.wordCount[a]! - idx.wordCount[b]! || idx.setRank[a]! - idx.setRank[b]! || byName(a, b));

  const hits = ids.map((i, rank): IconHit => {
    let via = '';
    if (rank < VIA_LIMIT) {
      const parts: string[] = [];
      for (const v of viaInfo) {
        const ti = v.ts.via[i]!;
        const e = ti >= 0 ? v.expanded[ti] : undefined;
        // 英語の語がそのまま当たったもの（広げていない）は、理由を付けない
        if (e && e.from) parts.push(`${v.raw} → ${e.term}`);
      }
      via = parts.join('、');
    }
    return { icon: icons[i]!, score: total[i]!, via };
  });
  return { hits, counts, total: all, relaxed };
}

/** 以前からの形：アイコンの配列だけを返す。 */
export function searchIcons(icons: readonly FluentIcon[], query: string, variant?: FluentVariant): FluentIcon[] {
  return searchIconSet(icons, query, variant ? { variant } : {}).hits.map((h) => h.icon);
}

/**
 * 英語の言葉の並びで探す（OR）。ラベルから出す候補のように、辞書の1つの概念が持つ言葉全体で探したいときに使う。
 * 言葉ごとの重みは、先頭ほど重い。
 */
export function searchTerms(icons: readonly FluentIcon[], terms: readonly string[], opts: SearchOptions & { onlyCategory?: string } = {}): IconHit[] {
  const idx = buildIndex(icons);
  const expanded: ExpandedTerm[] = terms.map((t, i) => ({ term: normTerm(t), weight: positionWeight(i), from: 'x', ...(opts.onlyCategory ? { category: opts.onlyCategory } : {}) }));
  if (expanded.length === 0) return [];
  const ts = scoreToken(idx, expanded, false);
  const out: { i: number; s: number }[] = [];
  for (let i = 0; i < icons.length; i++) {
    const b = ts.best[i]!;
    if (b === 0) continue;
    const icon = icons[i]!;
    if (opts.variant && icon[opts.variant] === 0) continue;
    if (opts.set && opts.set !== 'all' && (icon.set ?? 'fluent') !== opts.set) continue;
    out.push({ i, s: b + Math.min(ts.bonus[i]! - b * BONUS_RATE, b * BONUS_CAP) });
  }
  out.sort((a, b) => b.s - a.s || idx.wordCount[a.i]! - idx.wordCount[b.i]! || idx.setRank[a.i]! - idx.setRank[b.i]! || (idx.sortKey[a.i]! < idx.sortKey[b.i]! ? -1 : 1));
  return out.map((o) => ({ icon: icons[o.i]!, score: o.s, via: '' }));
}

// ---- ラベルの中の概念（ラベルから候補を出すため） ----

export interface ConceptHit {
  /** 見出し。 */
  display: string;
  /** その概念がこのカテゴリのアイコンだけを指すとき、そのカテゴリの id。 */
  category?: string;
  /** 文の中の位置。 */
  at: number;
  terms: readonly string[];
}

/**
 * 文（ボタンのラベルなど）の中の辞書の言葉を、概念ごとに探す。文の中で先に出る言葉を先に返し、同じ位置なら長い言葉を先にする。
 * ラベルは「集計して保存」のように語が空白で区切られていないので、見出しが文に含まれるかで探す。
 * 1文字の見出し（上・表など）は、文そのものと一致したときだけ使う（「上書き」で「上」が当たらないように）。
 */
export function conceptsInText(text: string): ConceptHit[] {
  const t = stripLong(normalize(text));
  if (!t) return [];
  const hits: (ConceptHit & { len: number })[] = [];
  const found: { display: string; at: number; len: number }[] = [];
  const seen = new Set<string>();
  for (const e of dictionary()) {
    if (!e.key) continue;
    const at = e.key.length >= 2 ? t.indexOf(e.key) : e.key === t ? 0 : -1;
    if (at < 0) continue;
    // 同じ概念の読みと表記が両方文に出ていても、1回だけ数える
    const id = `${e.display}@${at}`;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({ display: e.display, at, len: e.key.length });
    hits.push({ display: e.display, at, terms: e.terms, len: e.key.length, ...(e.category ? { category: e.category } : {}) });
  }
  // 最長一致：より長い見出しの範囲に収まる短い見出しは使わない（「ログイン」の中の「ログ」＝履歴、が当たらないように）。
  // 同じ概念の別の書き方（同じ display）の範囲は、同じ概念なので比べない
  const kept = hits.filter((a) => !found.some((b) => b.display !== a.display && b.len > a.len && b.at <= a.at && b.at + b.len >= a.at + a.len));
  kept.sort((a, b) => a.at - b.at || b.len - a.len);
  return kept.map((h) => ({ display: h.display, at: h.at, terms: h.terms, ...(h.category ? { category: h.category } : {}) }));
}

// ---- 空の結果のときの案内 ----

const DEFAULT_RELATED = ['お金', '配送', '会議', '予定', '食べ物', '動物', '確認', '分析'];

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 合うアイコンがなかったときに、近い言葉（辞書の見出し）を出す。文字の並びが似ているもの（2文字組の重なり）を探し、
 * 何も似ていなければ、よく使う言葉を出す。
 */
export function relatedConcepts(query: string, limit = 6, language: 'ja' | 'en' = 'ja'): string[] {
  const q = stripLong(normalize(query)).replace(/\s+/g, '');
  if (!q) return localizeRelated(DEFAULT_RELATED.slice(0, limit), language);
  // 1文字（「こ」など）は2文字組が作れず、1字が含まれるだけの見出しが大量に当たって、関係のない言葉が並ぶので出さない。
  // 1文字の英数字は、その文字のアイコン（letter-a・number-5）に当たるので、案内はいらない
  if (q.length < 2) return [];
  const qb = bigrams(q);
  const scored = new Map<string, number>();
  for (const e of dictionary()) {
    if (!e.key || !/[^\x00-\x7f]/.test(e.display)) continue;
    let s = 0;
    if (q.length >= 2 && (e.key.includes(q) || q.includes(e.key))) s = 2 + Math.min(e.key.length, q.length) / 10;
    else if (qb.size > 0) {
      const eb = bigrams(e.key);
      let common = 0;
      for (const b of qb) if (eb.has(b)) common++;
      if (common > 0) s = common / (qb.size + eb.size - common);
    }
    if (s > 0 && s > (scored.get(e.display) ?? 0)) scored.set(e.display, s);
  }
  const list = [...scored.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([d]) => d);
  return localizeRelated((list.length ? list : DEFAULT_RELATED).slice(0, limit), language);
}

/**
 * 近い言葉を英語の画面用にする：見出し（日本語）を、その概念の最初の英語の言葉に置き換える。
 * 英語の画面で日本語の見出しが並んでも読めず、押して検索すると日本語の語で探すことになるため。
 * 英語の言葉はそのまま検索に使える（「animal」など）。同じ言葉になったものは1つにする。
 */
function localizeRelated(list: readonly string[], language: 'ja' | 'en'): string[] {
  if (language === 'ja') return [...list];
  const byDisplay = new Map<string, string>();
  for (const e of dictionary()) if (!byDisplay.has(e.display) && e.terms[0]) byDisplay.set(e.display, e.terms[0].replace(/-/g, ' '));
  const out: string[] = [];
  for (const d of list) {
    const en = byDisplay.get(d) ?? d;
    if (!out.includes(en)) out.push(en);
  }
  return out;
}
