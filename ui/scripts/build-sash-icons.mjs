// Sash のオリジナルのアイコン（scripts/sash-icons.mjs）から、アイコン集のデータ（src/fluent/sashIcons.json）を作る。
// build-lucide-icons.mjs と同じく、手で実行して出力をコミットする。
//
//   cd ui
//   npm run sash-icons   （= node scripts/build-sash-icons.mjs）
//
// 保存の形は Tabler と同じ：icons[名前] = [カテゴリ番号, タグ（空白区切り）, 線のパス, 0]。

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteStart, packPaths, tidy } from './iconPaths.mjs';
import { SASH_ICONS } from './sash-icons.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'src', 'fluent', 'sashIcons.json');

const categories = [...new Set(Object.values(SASH_ICONS).map((v) => v[0]))].sort();
const icons = {};
for (const [name, [category, tags, parts]] of Object.entries(SASH_ICONS)) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`名前は小文字の英数字とハイフンだけ: ${name}`);
  if (!/^[a-z0-9 -]*$/.test(tags)) throw new Error(`タグは英語（小文字）だけ: ${name}`);
  const list = (Array.isArray(parts) ? parts : [parts]).map((d) => absoluteStart(tidy(d, name), name));
  icons[name] = [categories.indexOf(category), [...new Set(tags.split(' ').filter(Boolean))].join(' '), packPaths(list), 0];
}

const data = { source: 'sash', version: '1', license: 'Sash', categories, icons };
const json = JSON.stringify(data);
writeFileSync(outFile, json);
console.log(`${Object.keys(icons).length} icons -> ${outFile} (${(json.length / 1024).toFixed(1)} KB)`);
