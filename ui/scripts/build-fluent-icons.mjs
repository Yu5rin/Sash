// Fluent UI System Icons（MIT License）から、アイコン集のデータ（src/fluent/fluentIcons.json）を作る。
// 手で実行して、出力をコミットする。ビルドや CI では npm パッケージを読まないようにするため（読み込みは数千ファイルで遅く、
// パッケージの版が変わると見た目が勝手に変わってしまう）。
//
//   cd ui
//   npm install            （devDependencies の @fluentui/svg-icons が入る）
//   npm run fluent-icons   （= node scripts/build-fluent-icons.mjs）
//
// パッケージの版を上げたときは、src/fluent/LICENSE-fluentui-system-icons.txt の冒頭の版も合わせて直す。
//
// サイズは 24 を基本にする。リボンの 32px（大）と 16px（小）のどちらに縮めても線の太さの釣り合いがよく、
// 種類も一番多いため。24 がないアイコンだけ 20 で補う（その分 viewBox を変える）。
// 保存するのは <path d="…"> の中身だけ。<svg> の外枠や属性はアプリ側で組み立て直す（データを小さくするため）。

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', 'node_modules', '@fluentui', 'svg-icons');
const iconDir = join(pkgDir, 'icons');
const outFile = join(here, '..', 'src', 'fluent', 'fluentIcons.json');

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.license !== 'MIT') throw new Error(`想定外のライセンスです: ${pkg.license}`);

const SIZES = [24, 20];
// パッケージの単色アイコンの既定色。これ以外の色が付いたパス（虹色の旗など）は単色にすると意味が崩れるので除く
const DEFAULT_FILL = '#242424';

/** 1ファイルからパスを取り出す。<path> 以外の要素や、既定以外の色を含むものは使えないので null。 */
function readPaths(file) {
  const text = readFileSync(file, 'utf8');
  const tags = text.match(/<[a-zA-Z]+/g) ?? [];
  if (tags.some((t) => t !== '<svg' && t !== '<path')) return null;
  const paths = [];
  for (const m of text.matchAll(/<path([^>]*)\/?>/g)) {
    const attrs = m[1];
    const d = /\sd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) return null;
    const fill = /\sfill="([^"]+)"/.exec(attrs)?.[1];
    if (fill && fill.toLowerCase() !== DEFAULT_FILL) return null;
    // d 以外の属性（fill-rule など）があると、組み立て直したときに見た目が変わるので除く
    const rest = attrs.replace(/\sd="[^"]*"/, '').replace(/\sfill="[^"]*"/, '').trim().replace(/\/$/, '').trim();
    if (rest) return null;
    paths.push(d);
  }
  if (paths.length === 0) return null;
  return paths.length === 1 ? paths[0] : paths;
}

const files = new Set(readdirSync(iconDir));
const names = new Set();
for (const f of files) {
  const m = /^(.+)_(\d+)_(regular|filled)\.svg$/.exec(f);
  if (m && SIZES.includes(Number(m[2]))) names.add(m[1]);
}

const icons = {};
let skipped = 0;
for (const name of [...names].sort()) {
  let entry = null;
  for (const size of SIZES) {
    const r = files.has(`${name}_${size}_regular.svg`) ? readPaths(join(iconDir, `${name}_${size}_regular.svg`)) : null;
    const f = files.has(`${name}_${size}_filled.svg`) ? readPaths(join(iconDir, `${name}_${size}_filled.svg`)) : null;
    if (r || f) {
      // [regular, filled] か、24 以外なら [regular, filled, size]。ない種類は 0
      entry = size === 24 ? [r ?? 0, f ?? 0] : [r ?? 0, f ?? 0, size];
      break;
    }
  }
  if (entry) icons[name] = entry;
  else skipped++;
}

const data = { source: '@fluentui/svg-icons', version: pkg.version, license: 'MIT', icons };
mkdirSync(dirname(outFile), { recursive: true });
const json = JSON.stringify(data);
writeFileSync(outFile, json);
console.log(`${Object.keys(icons).length} icons (skipped ${skipped}) -> ${outFile} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
