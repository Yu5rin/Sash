// Tabler Icons（MIT License）から、アイコン集のデータ（src/fluent/tablerIcons.json）を作る。
// build-fluent-icons.mjs と同じく、手で実行して出力をコミットする（ビルドや CI ではパッケージを読まない）。
//
//   cd ui
//   npm install            （devDependencies の @tabler/icons が入る）
//   npm run tabler-icons   （= node scripts/build-tabler-icons.mjs）
//
// パッケージの版を上げたときは、src/fluent/LICENSE-tabler-icons.txt の冒頭の版も合わせて直す。
//
// 保存の形（アプリ側の読み込みは src/fluent/iconSet.ts の parseTabler）：
//   icons[名前] = [カテゴリ番号, タグ（空白区切り）, 線のパス, 塗りのパス]
//   線（outline）  : stroke-width 2 の線で描く。パスは「d の文字列」か、その配列。
//                    線だけのパスは1本にまとめる（fill が none なので、まとめても見た目は変わらない。データも小さくなる）。
//                    線と塗りを両方使うパスは先頭に '#'、塗りだけ（stroke なし）のパスは先頭に '@' を付けて分けたまま持つ。
//   塗り（filled） : パスの配列（1本に重ねると、逆回りの部分で穴が空くことがあるので、まとめずに分けたまま持つ）。
//   ない種類は 0。
// 外枠の <svg> と、先頭の透明な当たり判定用の <path d="M0 0h24v24H0z"> は保存しない（アプリ側で組み立て直す）。
//
// ブランドのロゴ（Brand カテゴリ、約 380 個）は除く。ボタンのアイコンには使いにくく、商標の扱いも別になるため。
// パスの数字は読みやすさのための空白を詰めて小さくする。詰めた前後で数字の並びが同じことを、ここで確かめる。

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', 'node_modules', '@tabler', 'icons');
const outFile = join(here, '..', 'src', 'fluent', 'tablerIcons.json');

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.license !== 'MIT') throw new Error(`想定外のライセンスです: ${pkg.license}`);
const meta = JSON.parse(readFileSync(join(pkgDir, 'icons.json'), 'utf8'));

const EXCLUDED_CATEGORIES = new Set(['Brand']);
const HIT_AREA = 'M0 0h24v24H0z';

/** 空白を詰める。コマンド文字の前後と負号の前だけを詰める（数字どうしの区切りは、読み違えるので残す）。 */
function minify(d) {
  return d
    .replace(/\s*([A-Za-z])\s*/g, '$1')
    .replace(/\s+-/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 数字の並び（コマンド文字を含む）。詰める前後で同じでなければ、詰め方が壊している。 */
function tokens(d) {
  return d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
}

function readPaths(file) {
  const text = readFileSync(file, 'utf8');
  const list = [];
  for (const m of text.matchAll(/<path([^>]*?)\/?>/g)) {
    const attrs = m[1];
    const d = /\sd="([^"]+)"/.exec(attrs)?.[1];
    if (!d || d === HIT_AREA) continue;
    if (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(d)) throw new Error(`想定外の文字があります: ${file}`);
    const rest = ' ' + attrs.replace(/\sd="[^"]*"/, '').replace(/\s+/g, ' ').trim();
    const small = minify(d);
    if (tokens(small).join(' ') !== tokens(d).join(' ')) throw new Error(`詰めたら数字が変わりました: ${file}`);
    let kind;
    if (rest.trim() === '') kind = 'plain';
    else if (rest.trim() === 'fill="currentColor"') kind = 'fill-stroke';
    else if (rest.trim() === 'fill="currentColor" stroke="none"') kind = 'fill-only';
    else if (rest.trim() === 'opacity=".5"') kind = 'plain'; // 1個だけ（ブランドのロゴ）。除外対象なので実際には使われない
    else throw new Error(`想定外の属性です: ${file}: ${rest}`);
    list.push({ kind, d: small });
  }
  return list;
}

function outline(file) {
  const list = readPaths(file);
  if (list.length === 0) return 0;
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length) out.push(run.join(''));
    run = [];
  };
  for (const p of list) {
    if (p.kind === 'plain') {
      // 先頭が絶対指定の M でないと、つないだときに前のパスの終点からの相対になってしまう
      if (!p.d.startsWith('M')) throw new Error('M で始まらないパスがあります');
      run.push(p.d);
    } else {
      flush();
      out.push((p.kind === 'fill-stroke' ? '#' : '@') + p.d);
    }
  }
  flush();
  return out.length === 1 ? out[0] : out;
}

function filled(file) {
  const list = readPaths(file);
  if (list.length === 0) return 0;
  const out = list.map((p) => p.d);
  return out.length === 1 ? out[0] : out;
}

const categories = [...new Set(Object.values(meta).map((v) => v.category))].filter((c) => !EXCLUDED_CATEGORIES.has(c)).sort();
const outlineFiles = new Set(readdirSync(join(pkgDir, 'icons', 'outline')));
const filledFiles = new Set(readdirSync(join(pkgDir, 'icons', 'filled')));

const icons = {};
let excluded = 0;
let withFilled = 0;
for (const name of Object.keys(meta).sort()) {
  const m = meta[name];
  if (EXCLUDED_CATEGORIES.has(m.category)) {
    excluded++;
    continue;
  }
  const o = outlineFiles.has(`${name}.svg`) ? outline(join(pkgDir, 'icons', 'outline', `${name}.svg`)) : 0;
  const f = filledFiles.has(`${name}.svg`) ? filled(join(pkgDir, 'icons', 'filled', `${name}.svg`)) : 0;
  if (!o && !f) continue;
  if (f) withFilled++;
  // タグは数字（3d など）や null が混じる。文字にして、空白を含むものは - でつなぐ
  const tags = (m.tags ?? []).filter((t) => t !== null && t !== undefined).map((t) => String(t).trim().replace(/\s+/g, '-').toLowerCase()).filter(Boolean);
  icons[name] = [categories.indexOf(m.category), [...new Set(tags)].join(' '), o, f];
}

const data = { source: '@tabler/icons', version: pkg.version, license: 'MIT', categories, icons };
mkdirSync(dirname(outFile), { recursive: true });
const json = JSON.stringify(data);
writeFileSync(outFile, json);
console.log(`${Object.keys(icons).length} icons (filled ${withFilled}, excluded brand ${excluded}) -> ${outFile} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
