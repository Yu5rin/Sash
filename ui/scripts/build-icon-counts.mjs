// 4 つのアイコン集の個数を数えて、src/fluent/iconCounts.ts にする（画面のツールチップの「約 8,200 個」を直書きしないため）。
// データ（*.json）は大きく、起動時には読み込まないので、個数だけの小さなファイルを別に持つ。
// アイコン集のデータを作り直したら、これも実行してコミットする（test/iconCounts.test.ts が、実際の個数と合っているか確かめる）。
//
//   cd ui
//   npm run icon-counts

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'src', 'fluent');
const count = (file) => Object.keys(JSON.parse(readFileSync(join(dir, file), 'utf8')).icons).length;
const c = { fluent: count('fluentIcons.json'), tabler: count('tablerIcons.json'), lucide: count('lucideIcons.json'), sash: count('sashIcons.json') };
const body = `// アイコン集の個数。scripts/build-icon-counts.mjs が作る（手で直さない）。\n\nexport const ICON_COUNTS = ${JSON.stringify(c)} as const;\n`;
writeFileSync(join(dir, 'iconCounts.ts'), body);
console.log(c, '->', join(dir, 'iconCounts.ts'));
