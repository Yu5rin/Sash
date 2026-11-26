// Lucide（ISC License）から、業務で使うアイコンだけを選んで、アイコン集のデータ（src/fluent/lucideIcons.json）を作る。
// build-tabler-icons.mjs と同じく、手で実行して出力をコミットする（ビルドや CI ではパッケージを読まない）。
//
//   cd ui
//   npm install              （devDependencies の lucide-static が入る）
//   npm run lucide-icons     （= node scripts/build-lucide-icons.mjs）
//
// パッケージの版を上げたときは、src/fluent/LICENSE-lucide.txt の冒頭の版も合わせて直す。
//
// 全部（約 1,700 個）は取り込まない。Tabler・Fluent と同じ意味のものを大量に重ねても探しにくくなるだけなので、
// 業務（ものづくり・物流・営業・事務・開発・品質）で区別がつくものを、下の LIST から名前で選ぶ。
// Tabler にすでにある名前は入れない（同じ名前のアイコンを二重に出さない）。別名（古い名前）のファイルは使わない。
//
// 保存の形は Tabler と同じ：icons[名前] = [カテゴリ番号, タグ（空白区切り）, 線のパス, 0]。
// Lucide は円・四角・線なども要素で持つので、パスの d に直して 1 本につなぐ（scripts/iconPaths.mjs）。
// どちらも 24×24・線幅 2・丸い端の線なので、見た目はそろう。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteStart, elementToPath, packPaths, tidy } from './iconPaths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', 'node_modules', 'lucide-static');
const outFile = join(here, '..', 'src', 'fluent', 'lucideIcons.json');

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.license !== 'ISC') throw new Error(`想定外のライセンスです: ${pkg.license}`);
const nodes = JSON.parse(readFileSync(join(pkgDir, 'icon-nodes.json'), 'utf8'));
const tagsOf = JSON.parse(readFileSync(join(pkgDir, 'tags.json'), 'utf8'));
const tablerNames = new Set(Object.keys(JSON.parse(readFileSync(join(here, '..', 'src', 'fluent', 'tablerIcons.json'), 'utf8')).icons));

/** カテゴリ（Tabler の読み替えに合わせた名前。Industry だけは Sash のカテゴリ「ものづくり・工場」）→ 取り込む名前。 */
const LIST = {
  Industry: `factory warehouse anvil drill screw screwdriver wrench toolbox tool-case pickaxe paint-gun paint-roller spool laser hole robot-arm hard-hat construction
    circuit-board microchip cable plug-zap ev-charger utility-pole fan air-vent faucet circle-gauge radiation siren cctv hourglass-cog cog
    ruler-dimension-line drafting-compass diameter radius square-dimensions proportions scaling inspection-panel
    cuboid torus component combine layers flask-conical test-tubes beaker thermometer-sun house-cog door-closed-cog tower-control`,
  Vehicles: 'hand-truck truck-electric van trailer ship-cargo train-front tram-front plane-takeoff plane-landing',
  'E-commerce': `shelving-unit briefcase-conveyor-belt baggage-claim door-closed-package boxes carton package-check package-minus package-open package-pen
    package-plus package-search package-x scan-box scan-barcode scan-search scan-qr-code qr-code scan-line store receipt-text receipt-japanese-yen
    badge-japanese-yen badge-percent badge-check ticket-percent banknote banknote-arrow-up banknote-arrow-down hand-coins piggy-bank landmark`,
  Document: `signature clipboard-clock clipboard-pen-line file-chart-column-increasing file-chart-line file-chart-pie file-cog file-search-corner
    stamp notebook-tabs notebook-pen sticky-notes book-open-check library-big sheet table-properties folder-kanban folder-tree folder-sync
    folder-clock folder-archive folder-cog`,
  Charts: `chart-gantt chart-network chart-no-axes-combined chart-candlestick chart-bell-curve chart-spline chart-column-increasing
    chart-bar-decreasing kanban workflow waypoints milestone goal`,
  Communication: `handshake megaphone lectern concierge-bell messages-square message-square-text mail-clock phone-forwarded printer-check projector`,
  System: `briefcase-business calendar-range calendar-sync calendar-days list-todo list-checks list-clock timer-reset alarm-clock-check search-check
    graduation-cap university building-complex hotel map-pin-house signpost footprints fingerprint-pattern key-round lock-keyhole monitor-check monitor-cloud laptop-minimal-check`,
  Communication2: `id-card-lanyard id-card contact-round user-round-check user-round-clock user-round-search user-round-star user-round-key user-round-cog user-round-pen users-round user-group`,
  Development: `bot brain-circuit code-xml bug-play database-backup server-nas hard-drive lightbulb square-terminal file-braces swatch-book spline pen-tool`,
};
// Communication2 は人まわり（カテゴリは Communication と同じ読み替え）。見やすさのために分けて書いただけ
const CATEGORY_OF = (key) => (key === 'Communication2' ? 'Communication' : key);

const categories = [...new Set(Object.keys(LIST).map(CATEGORY_OF))].sort();

const icons = {};
const dup = [];
const missing = [];
for (const [group, text] of Object.entries(LIST)) {
  const category = CATEGORY_OF(group);
  for (const name of text.split(/\s+/).filter(Boolean)) {
    if (icons[name]) throw new Error(`重複しています: ${name}`);
    if (tablerNames.has(name)) {
      dup.push(name);
      continue;
    }
    const els = nodes[name];
    if (!els) {
      missing.push(name);
      continue;
    }
    // 保存の形：線だけのパスは 1 本につなぎ、塗りも要る点（fill 指定の小さな円）は '#' を付けて別に持つ
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length) out.push(packPaths(run));
      run = [];
    };
    for (const [tag, attrs] of els) {
      // 小さな点（半径 1 以下で fill 指定のある円）。線幅 2 の線だけで描くと、半径 0.5 の円は真ん中に穴が空く（元は塗りがある）ので、
      // 塗りと線の両方で描く印（'#'）を付けて別に持つ。それ以外の塗りは扱えない
      const dot = 'fill' in attrs && attrs.fill !== 'none';
      if (dot && !(tag === 'circle' && Number(attrs.r) <= 1)) throw new Error(`塗りのある要素は扱えません: ${name}`);
      const d = absoluteStart(tidy(elementToPath(tag, attrs, name), name), name);
      if (dot) {
        flush();
        out.push(`#${d}`);
      } else run.push(d);
    }
    flush();
    if (out.length === 0) throw new Error(`図形がありません: ${name}`);
    const tags = (tagsOf[name] ?? []).map((t) => String(t).trim().replace(/\s+/g, '-').toLowerCase()).filter(Boolean).slice(0, 14);
    icons[name] = [categories.indexOf(category), [...new Set(tags)].join(' '), out.length === 1 ? out[0] : out, 0];
  }
}
if (missing.length) throw new Error(`Lucide にない名前（書き間違いか、別名しかない）: ${missing.join(' ')}`);

const data = { source: 'lucide-static', version: pkg.version, license: 'ISC', categories, icons };
const json = JSON.stringify(data);
writeFileSync(outFile, json);
console.log(`${Object.keys(icons).length} icons (Tabler と同名で外した ${dup.length}: ${dup.join(' ')}) -> ${outFile} (${(json.length / 1024).toFixed(1)} KB)`);
