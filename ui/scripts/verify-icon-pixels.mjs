// Lucide・Sash のアイコンのデータ（lucideIcons.json・sashIcons.json）を、元の SVG と画素で比べる（Chromium で描いて、差が出ないことを確かめる）。
// パスの相対→絶対の変換や、円・四角のパスへの直しが、図を変えていないかを見るためのもの。ビルドや CI では走らない（手で実行する）。
//
//   cd ui
//   node scripts/verify-icon-pixels.mjs          （playwright が必要。グローバルでも ui の devDependency でもよい）
//
// Lucide：lucide-static の icon-nodes.json の要素をそのまま描いたものと、JSON の 1 本のパスで描いたものを、96px で比べる。
// Sash：scripts/sash-icons.mjs の部分パスを別々に描いたものと、JSON の 1 本のパスで描いたものを比べる。
// 色が 96 以上（0〜255）違う画素が 1 つでもあれば「差あり」として、名前を出して終わりコード 1 にする。
// 2 通りで比べる：①元の要素ごと vs JSON のパスを M で分けて描いたもの（図形の一致。これが 1 つでも違えば失敗）、②元 vs アプリ（buildSvg）と同じ 1 本のパス（線が重なる縁の薄い画素が変わるので、参考として数だけ出す）。

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SASH_ICONS } from './sash-icons.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
for (const p of ['playwright', join(process.execPath, '..', '..', 'lib', 'node_modules', 'playwright')]) {
  try { playwright = require(p); break; } catch { /* 次へ */ }
}
if (!playwright) throw new Error('playwright が見つかりません');

const nodes = JSON.parse(readFileSync(join(here, '..', 'node_modules', 'lucide-static', 'icon-nodes.json'), 'utf8'));
const lucide = JSON.parse(readFileSync(join(here, '..', 'src', 'fluent', 'lucideIcons.json'), 'utf8')).icons;
const sash = JSON.parse(readFileSync(join(here, '..', 'src', 'fluent', 'sashIcons.json'), 'utf8')).icons;

const attrs = (a) => Object.entries(a).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ');
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
// 1 本につないだパスを、M の位置で元の要素ごとに戻して描く（重なる線を 1 本のパスで塗ると、重なりの縁の薄い画素が元と変わるため。図形そのものの比較が目的）。
// '#' で始まる要素は塗りと線の両方（半径の小さい点）
const splitPaths = (d) => (Array.isArray(d) ? d : [d]).flatMap((x) => {
  const fill = x.startsWith('#');
  return (fill ? x.slice(1) : x).split(/(?=M)/).filter(Boolean).map((q) => `<path d="${q}"${fill ? ' fill="#000"' : ''}/>`);
}).join('');
// アプリが描く形：'#' のない部分は 1 本の path にまとめて描く（buildSvg と同じ。'#' は塗りと線の別の path）
const wholePath = (d) => (Array.isArray(d) ? d : [d]).map((x) => x.startsWith('#') ? `<path d="${x.slice(1)}" fill="#000"/>` : `<path d="${x}"/>`).join('');
const pairs = [];
for (const [name, e] of Object.entries(lucide)) {
  const orig = wrap(nodes[name].map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join(''));
  pairs.push({ name: `lucide:${name}`, a: orig, b: wrap(splitPaths(e[2])), c: wrap(wholePath(e[2])) });
}
for (const [name, e] of Object.entries(sash)) {
  const parts = SASH_ICONS[name][2];
  pairs.push({ name: `sash:${name}`, a: wrap((Array.isArray(parts) ? parts : [parts]).map((d) => `<path d="${d}"/>`).join('')), b: wrap(splitPaths(e[2])), c: wrap(wholePath(e[2])) });
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage();
const result = await page.evaluate(async (list) => {
  const draw = (svg) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 96, 96);
      ctx.drawImage(img, 0, 0);
      res(ctx.getImageData(0, 0, 96, 96).data);
    };
    img.onerror = () => rej(new Error('svg を読めません'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const bad = [];
  const bad2 = [];
  for (const p of list) {
    const a = await draw(p.a);
    const b = await draw(p.b);
    const c = await draw(p.c);
    const count = (x, y) => { let n = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) >= 96) n++; return n; };
    // 元（要素ごと）と、M で分けて描いた形：図形そのものの一致。元と、アプリと同じ 1 本のパス：重なる線の縁の薄い画素だけ変わるので、別に数える
    const d1 = count(a, b);
    const d2 = count(a, c);
    if (d1 > 0) bad.push(`${p.name} 分割 (${d1})`);
    if (d2 > 0) bad2.push(`${p.name} 1本 (${d2})`);
  }
  return { total: list.length, bad, bad2 };
}, pairs);
await browser.close();
console.log(`${result.total} 個を比べた。差があるもの（元と、M で分けて描いた形）：${result.bad.length} 個、（元と、アプリと同じ 1 本のパス）：${result.bad2.length} 個`);
if (result.bad2.length) console.log(result.bad2.join('\n'));
if (result.bad.length) {
  console.log(result.bad.join('\n'));
  process.exit(1);
}
