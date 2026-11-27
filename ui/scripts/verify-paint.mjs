// アイコンのペイント機能（SPEC §25）を、ブラウザのダミーのホストで実際に操作して確かめる（手で動かす）。
//   cd ui && npx vite --port 5411        （別の窓で）
//   PLAYWRIGHT=/path/to/node_modules/playwright SHOTS=/path/to/dir node scripts/verify-paint.mjs [http://localhost:5411]
// 確かめること：描く・消す・塗る・スポイト・選択して動かす・元に戻す／やり直し・完了してアイコンエディタへ戻る・保存と描き直し・
// 旧版（0.3.1）の加工の手順に通しても画素が一致すること・Esc の順番・Enter・貼り付け。画面は SHOTS に撮る（ライト・ダーク・英語・1366×700）。
// 失敗があれば、終了コード 1 で、何が合わなかったかを出す。Windows 実機（WebView2・ペン・タッチ・高 DPI）では確かめていない。

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');
const BASE = process.argv[2] ?? 'http://localhost:5411';
const SHOTS = process.env.SHOTS ?? 'paint-shots';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
console.log(`ブラウザ：Chromium ${browser.version()}（下限の WebView2 は Chromium 109。実機では確かめていない）`);

/** ページが読み込んだのと同じモジュール（Vite は ?t=… を付けるので、同じ URL で読まないと別のインスタンスになる）。 */

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: opts.height ?? 700 }, colorScheme: opts.dark ? 'dark' : 'light' });
  await ctx.addInitScript(() => {
    window.__mod = (name) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/' + name)) ?? '/src/' + name);
  });
  if (opts.en) await ctx.addInitScript(() => localStorage.setItem('sash.lang', 'en'));
  // 初回の手引きは、確かめるときは出さない（opts.guide のときだけ出す）
  if (!opts.guide) await ctx.addInitScript(() => localStorage.setItem('sash.paint.guide', '1'));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await page.goto(`${BASE}/?sample`);
  await page.waitForTimeout(2200);
  return page;
}

async function openIconEditor(page) {
  await page.click('.rb-ctl.rb-button.large');
  await page.locator('.menubar button, .menu-title, [role=menubar] *').filter({ hasText: /ツール|Tools/ }).first().click();
  await page.waitForTimeout(250);
  await page.locator('text=/アイコンを作る…|Create icon…|Icon editor…|Create an icon…/').first().click();
  await page.waitForTimeout(400);
}

const topModal = (page) => page.locator('.modal-backdrop').last();

async function drawNew(page, size) {
  await page.click('.icon-draw-new');
  await page.waitForTimeout(250);
  await topModal(page).locator(`footer button:has-text("${size} × ${size}")`).click();
  await page.waitForSelector('.paint-canvas');
  await page.waitForTimeout(500);
}

/** 絵の上の (x, y) 画素の中心の画面上の位置。 */
async function cell(page, x, y, size) {
  const g = await page.evaluate(() => {
    const r = document.querySelector('.paint-canvas').getBoundingClientRect();
    return { left: r.left, top: r.top, w: Math.floor(r.width), h: Math.floor(r.height), z: Number(document.querySelector('.paint-zoom').value) };
  });
  const len = size * g.z;
  return { x: g.left + Math.round((g.w - len) / 2) + (x + 0.5) * g.z, y: g.top + Math.round((g.h - len) / 2) + (y + 0.5) * g.z };
}

async function drag(page, size, pts, button = 'left') {
  const p0 = await cell(page, pts[0][0], pts[0][1], size);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down({ button });
  for (const [x, y] of pts.slice(1)) {
    const p = await cell(page, x, y, size);
    await page.mouse.move(p.x, p.y, { steps: 3 });
  }
  await page.mouse.up({ button });
}

const click = (page, size, x, y, button = 'left') => drag(page, size, [[x, y]], button);

async function setPrimary(page, hex) {
  await page.locator('#paint-tab-colors').click();
  const input = page.locator('.paint-side .cp-hex');
  await input.fill(hex);
  await input.press('Enter');
  await page.locator('.paint-stage').focus();
}

const finishPaint = async (page) => {
  await topModal(page).locator('footer button.primary').click();
  await page.waitForTimeout(500);
};

/** ブックの画像（store.images）の画素。 */
async function storedPixels(page, id = 'img_btnSummary') {
  return page.evaluate(async (id) => {
    const { app } = await window.__mod('app.ts');
    const e = app.store.images.get(id);
    if (!e) return null;
    const img = new Image();
    img.src = e.dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data), options: e.edit?.options ?? null };
  }, id);
}

const apply = async (page) => {
  await page.locator('.modal-backdrop').last().locator('footer button.primary').click();
  await page.waitForTimeout(500);
};

const rgbaAt = (px, x, y) => px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 4);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function blank(n) {
  return { width: n, height: n, data: new Array(n * n * 4).fill(0) };
}
function put(px, x, y, rgba) {
  if (x < 0 || y < 0 || x >= px.width || y >= px.height) return;
  const i = (y * px.width + x) * 4;
  px.data[i] = rgba[0]; px.data[i + 1] = rgba[1]; px.data[i + 2] = rgba[2]; px.data[i + 3] = rgba[3];
}

/** 旧版（0.3.1）の process() と同じ手順（中立の設定）を、元画像に通した画素。 */
async function legacyOutput(page, id, size) {
  return page.evaluate(async ({ id, size }) => {
    const { app } = await window.__mod('app.ts');
    const { fitRect, adjustBrightness, shapeMask } = await import('/src/icon/process.ts');
    const e = app.store.images.get(id);
    const bmp = await createImageBitmap(e.edit.source);
    const r = document.createElement('canvas'); r.width = bmp.width; r.height = bmp.height;
    const rc = r.getContext('2d', { willReadFrequently: true }); rc.drawImage(bmp, 0, 0, r.width, r.height);
    const px = rc.getImageData(0, 0, r.width, r.height);
    const tmp = document.createElement('canvas'); tmp.width = px.width; tmp.height = px.height; tmp.getContext('2d').putImageData(px, 0, 0);
    const bounds = { x: 0, y: 0, width: px.width, height: px.height };
    let step = document.createElement('canvas'); step.width = bounds.width; step.height = bounds.height; step.getContext('2d').drawImage(tmp, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    const fit = fitRect(step.width, step.height, size, 0);
    while (step.width / 2 >= fit.width && step.height / 2 >= fit.height) {
      const half = document.createElement('canvas'); half.width = Math.ceil(step.width / 2); half.height = Math.ceil(step.height / 2);
      const hc = half.getContext('2d'); hc.imageSmoothingQuality = 'high'; hc.drawImage(step, 0, 0, half.width, half.height); step = half;
    }
    const o = document.createElement('canvas'); o.width = o.height = size;
    const oc = o.getContext('2d', { willReadFrequently: true }); oc.clearRect(0, 0, size, size); oc.imageSmoothingQuality = 'high'; oc.drawImage(step, fit.x, fit.y, fit.width, fit.height);
    const result = oc.getImageData(0, 0, size, size); adjustBrightness(result, 0); shapeMask(result, 'none', 20); oc.putImageData(result, 0, 0);
    return Array.from(oc.getImageData(0, 0, size, size).data);
  }, { id, size });
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const TRANSPARENT = [0, 0, 0, 0];

// ---------------------------------------------------------------------------------------------
console.log('== 1. 新しく描く（32）：鉛筆・右クリック・塗りつぶし・スポイト・選択して動かす・Delete・元に戻す／やり直し → 完了 → 設定する');
{
  const page = await newPage({ guide: true });
  await openIconEditor(page);
  await drawNew(page, 32);
  await page.screenshot({ path: `${SHOTS}/01-paint-open-guide.png` });
  await page.click('.paint-guide button');
  const S = 32;
  await setPrimary(page, '#ff0000');
  // 鉛筆：8×8 の枠（2..9）
  await drag(page, S, [[2, 2], [9, 2]]);
  await drag(page, S, [[9, 2], [9, 9]]);
  await drag(page, S, [[9, 9], [2, 9]]);
  await drag(page, S, [[2, 9], [2, 2]]);
  // 右クリック（背景色＝透明）で角を消す
  await click(page, S, 2, 2, 'right');
  // 塗りつぶし（G）：内側を緑に
  await setPrimary(page, '#00ff00');
  await page.keyboard.press('g');
  await click(page, S, 5, 5);
  // スポイト（I）：枠の赤を前景色に取り、鉛筆（P）で 14,14 に 1 点
  await page.keyboard.press('i');
  await click(page, S, 2, 5);
  await page.keyboard.press('p');
  await click(page, S, 14, 14);
  // 四角形の選択（M）：(4,4)-(7,7) を選び、中をドラッグして +8 動かす
  await page.keyboard.press('m');
  await drag(page, S, [[4, 4], [7, 7]]);
  await drag(page, S, [[5, 5], [9, 5], [13, 5]]);
  await page.screenshot({ path: `${SHOTS}/02-paint-floating.png` });
  const hint1 = await page.locator('.paint-coords').textContent();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await page.screenshot({ path: `${SHOTS}/03-paint-redo.png` });
  await finishPaint(page);
  await page.screenshot({ path: `${SHOTS}/04-icon-after-paint.png` });
  // 右の設定欄が中立に戻っている
  const ctl = await page.evaluate(() => ({
    padding: document.querySelector('input[data-opt="padding"]').value,
    trim: document.querySelector('input[data-opt="trim"]').checked,
    badge: document.querySelector('select[data-opt="badge"]').value,
    hint: document.querySelector('.icon-left .muted.small')?.textContent,
  }));
  check('完了後：余白 0・自動カットなし・バッジなしに戻る', ctl.padding === '0' && ctl.trim === false && ctl.badge === 'none', JSON.stringify(ctl));
  await apply(page);
  const out = await storedPixels(page);
  const want = blank(S);
  for (let i = 2; i <= 9; i++) for (const [x, y] of [[i, 2], [i, 9], [2, i], [9, i]]) put(want, x, y, RED);
  put(want, 2, 2, TRANSPARENT);
  for (let y = 3; y <= 8; y++) for (let x = 3; x <= 8; x++) put(want, x, y, GREEN);
  put(want, 14, 14, RED);
  // 選択 (4..7, 4..7) の中身（緑）を +8 動かした：元の場所は透明、動かした先に緑
  for (let y = 4; y <= 7; y++) for (let x = 4; x <= 7; x++) { put(want, x, y, TRANSPARENT); put(want, x + 8, y, GREEN); }
  check('ブックの画像が 32×32', out && out.width === 32 && out.height === 32);
  const bad = [];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (!same(rgbaAt(out, x, y), rgbaAt(want, x, y))) bad.push(`${x},${y}:${rgbaAt(out, x, y)}≠${rgbaAt(want, x, y)}`);
  check('ブックの画像が、描いた絵の期待の画素と一致する', bad.length === 0, bad.slice(0, 5).join(' / '));
  check('options.paint が付き、加工が中立', out.options?.paint?.v === 1 && out.options.paint.canvas === 32 && out.options.padding === 0 && out.options.badge === 'none', JSON.stringify(out.options));
  const legacy = await legacyOutput(page, 'img_btnSummary', 32);
  check('互換：source と options を 0.3.1 の process() の手順に通すと、出力と画素が一致する', same(legacy, out.data));
  await page.context().close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 2. 16×16 で描く → 出力 32 は 2 倍の最近傍');
{
  const page = await newPage();
  await openIconEditor(page);
  await drawNew(page, 16);
  const S = 16;
  await setPrimary(page, '#0000ff');
  await drag(page, S, [[1, 1], [5, 1]]);
  await click(page, S, 8, 8);
  await page.screenshot({ path: `${SHOTS}/05-paint-16.png` });
  await finishPaint(page);
  await apply(page);
  const out = await storedPixels(page);
  const want = blank(32);
  for (let x = 1; x <= 5; x++) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(want, x * 2 + dx, 2 + dy, [0, 0, 255, 255]);
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(want, 16 + dx, 16 + dy, [0, 0, 255, 255]);
  check('出力 32×32 が、16 の絵の 2 倍の最近傍と一致する', out.width === 32 && same(out.data, want.data));
  check('options.paint.canvas が 16', out.options?.paint?.canvas === 16);
  const legacy = await legacyOutput(page, 'img_btnSummary', 32);
  check('互換（16 → 32）：0.3.1 の手順でも一致', same(legacy, out.data));
  // 出力の大きさを 64 に変える：描いた絵から元画像を作り直し、4 倍の最近傍で一致する（拡大した元画像をさらに拡大するとぼける）
  await openIconEditor(page);
  await drawNew(page, 16);
  await setPrimary(page, '#0000ff');
  await drag(page, 16, [[1, 1], [5, 1]]);
  await click(page, 16, 8, 8);
  await finishPaint(page);
  await page.locator('select[data-opt="size"]').selectOption('64');
  await page.waitForTimeout(500);
  await apply(page);
  const out64 = await storedPixels(page);
  const want64 = blank(64);
  for (let x = 1; x <= 5; x++) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) put(want64, x * 4 + dx, 4 + dy, [0, 0, 255, 255]);
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) put(want64, 32 + dx, 32 + dy, [0, 0, 255, 255]);
  check('出力を 64 に変えると、16 の絵の 4 倍の最近傍で一致する（元画像を作り直す）', out64.width === 64 && same(out64.data, want64.data) && out64.options?.paint?.canvas === 16);
  const legacy64 = await legacyOutput(page, 'img_btnSummary', 64);
  check('互換（16 → 64）：0.3.1 の手順でも一致', same(legacy64, out64.data));
  // 32 に戻すと、2 倍に戻る
  await openIconEditor(page);
  await drawNew(page, 16);
  await setPrimary(page, '#0000ff');
  await click(page, 16, 8, 8);
  await finishPaint(page);
  await page.locator('select[data-opt="size"]').selectOption('64');
  await page.waitForTimeout(400);
  await page.locator('select[data-opt="size"]').selectOption('32');
  await page.waitForTimeout(500);
  await apply(page);
  const back = await storedPixels(page);
  const want2 = blank(32);
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(want2, 16 + dx, 16 + dy, [0, 0, 255, 255]);
  check('64 から 32 に戻すと、2 倍の最近傍に戻る', back.width === 32 && same(back.data, want2.data));
  await page.context().close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 3. 取り込んだ画像（半透明の縁つき）→ 余白とバッジ → 描いて編集：焼き込みがプレビューと一致 → 完了で設定が中立に戻る');
{
  const page = await newPage();
  await openIconEditor(page);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 48;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(24, 24, 4, 24, 24, 20); g.addColorStop(0, '#d04020'); g.addColorStop(1, 'rgba(32,96,208,0.4)');
    x.fillStyle = g; x.beginPath(); x.arc(24, 24, 20, 0, Math.PI * 2); x.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('.icon-sources input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForTimeout(700);
  await page.locator('input[data-opt="padding"]').fill('20');
  await page.locator('select[data-opt="badge"]').selectOption('check');
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => document.querySelector('.icon-preview img').src);
  await page.screenshot({ path: `${SHOTS}/06-icon-loaded-finished.png` });
  await page.click('.icon-paint-edit');
  await page.waitForSelector('.paint-canvas');
  await page.waitForTimeout(600);
  const inPaint = await page.evaluate(() => [...document.querySelectorAll('.modal-backdrop')].at(-1).querySelector('.icon-preview img').src);
  const dec = (url) => page.evaluate(async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(i, 0, 0); return { w: c.width, d: Array.from(x.getImageData(0, 0, c.width, c.height).data) }; }, url);
  const a = await dec(before);
  const b = await dec(inPaint);
  check('焼き込んだ絵（ペイント画面のプレビュー）が、アイコンエディタのプレビューと一致する', a.w === b.w && same(a.d, b.d));
  await page.screenshot({ path: `${SHOTS}/07-paint-baked.png` });
  await finishPaint(page);
  const ctl = await page.evaluate(() => ({ padding: document.querySelector('input[data-opt="padding"]').value, badge: document.querySelector('select[data-opt="badge"]').value, trim: document.querySelector('input[data-opt="trim"]').checked }));
  check('完了後：余白 0・バッジなし・自動カットなし', ctl.padding === '0' && ctl.badge === 'none' && ctl.trim === false, JSON.stringify(ctl));
  const after = await page.evaluate(() => document.querySelector('.icon-preview img').src);
  const c2 = await dec(after);
  const maxd = Math.max(...c2.d.map((v, i) => Math.abs(v - a.d[i])));
  check('何も描かずに完了しても、見た目が変わらない（半透明の縁を含む。差の最大値を表示）', a.w === c2.w && maxd <= 1, `max diff=${maxd}`);
  console.log(`     （半透明を含む往復での画素の差の最大値：${maxd}）`);
  // もう一度［描いて編集…］→［完了］：元画像から絵を戻しても、出力が変わらない
  await page.click('.icon-paint-edit');
  await page.waitForSelector('.paint-canvas');
  await page.waitForTimeout(500);
  await finishPaint(page);
  const again = await page.evaluate(() => document.querySelector('.icon-preview img').src);
  const c3 = await dec(again);
  check('描いた絵を戻して、もう一度完了しても出力が変わらない', same(c2.d, c3.d));
  // 貼り付け：ペイント画面を開いている間の Ctrl+V は、アイコンエディタの元画像を入れ替えない
  const hintBefore = await page.locator('.icon-left .muted.small').first().textContent();
  await page.click('.icon-paint-edit');
  await page.waitForSelector('.paint-canvas');
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 6; const x = c.getContext('2d'); x.fillStyle = '#00ff00'; x.fillRect(0, 0, 6, 6);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'p.png', { type: 'image/png' }));
    document.querySelector('.paint-stage').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  const sel = await page.locator('.paint-coords').textContent().catch(() => '');
  await page.mouse.move(600, 300);
  await page.waitForTimeout(200);
  const coords = await page.locator('.paint-coords').textContent();
  check('ペイント画面での貼り付けが、浮いた選択（6 × 6）になる', /6 × 6/.test(coords), coords + sel);
  await page.screenshot({ path: `${SHOTS}/08-paint-pasted.png` });
  await page.keyboard.press('Escape'); // 確定
  await page.keyboard.press('Escape'); // 選択の解除
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await page.locator('.modal-backdrop').last().locator('footer button', { hasText: /キャンセル|Cancel/ }).click();
  await page.waitForTimeout(300);
  const hintAfter = await page.locator('.icon-left .muted.small').first().textContent();
  check('貼り付けでアイコンエディタの元画像が入れ替わっていない', hintBefore === hintAfter, `${hintBefore} → ${hintAfter}`);
  await page.context().close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 4. 閉じるときの確認・Esc の順番・キャンバス上の Enter');
{
  const page = await newPage();
  await openIconEditor(page);
  await drawNew(page, 32);
  const S = 32;
  const modalCount = () => page.locator('.modal-backdrop').count();
  // 何も描いていなければ、Esc ですぐ閉じる
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('何も描いていなければ Esc で確認なしに閉じる', (await page.locator('.paint-canvas').count()) === 0 && (await modalCount()) === 1);
  await drawNew(page, 32);
  await drag(page, S, [[3, 3], [10, 3]]);
  // 選択 → 動かして浮かせる
  await page.keyboard.press('m');
  await drag(page, S, [[2, 2], [6, 4]]);
  await drag(page, S, [[3, 3], [9, 9]]);
  const coords = () => page.locator('.paint-coords').textContent();
  await page.mouse.move(5, 5);
  // Esc 1 回目：浮いた選択を確定（選択の枠は残る）
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc 1 回目：浮いた選択を確定する（ダイアログは閉じない）', (await page.locator('.paint-canvas').count()) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc 2 回目：選択を解除する（ダイアログは閉じない）', (await page.locator('.paint-canvas').count()) === 1);
  // Enter（キャンバスにフォーカス）：［完了］は押されない
  await page.locator('.paint-stage').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('キャンバスで Enter を押しても［完了］は押されない', (await page.locator('.paint-canvas').count()) === 1);
  // Esc 3 回目：描いた内容があるので、確認が出る
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc 3 回目：捨てる確認が出る', (await modalCount()) === 3 && /捨てますか|Discard/.test(await page.locator('.modal-backdrop').last().textContent()));
  await page.screenshot({ path: `${SHOTS}/09-paint-discard-confirm.png` });
  // 戻る
  await page.locator('.modal-backdrop').last().locator('footer button.primary').click();
  await page.waitForTimeout(300);
  check('［戻る］で描き続けられる', (await page.locator('.paint-canvas').count()) === 1 && (await modalCount()) === 2);
  // 背景のクリックでも確認が出る
  await page.mouse.click(3, 350);
  await page.waitForTimeout(300);
  check('背景のクリックでも、捨てる確認が出る', (await modalCount()) === 3);
  await page.locator('.modal-backdrop').last().locator('footer button.danger').click();
  await page.waitForTimeout(300);
  check('［捨てる］で閉じ、アイコンエディタに戻る（元画像は入らない）', (await page.locator('.paint-canvas').count()) === 0 && (await modalCount()) === 1);
  await page.context().close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 5. 拡大・グリッド・パン・色の選択・実寸プレビュー（64）');
{
  const page = await newPage();
  await openIconEditor(page);
  await drawNew(page, 64);
  const zoom = () => page.locator('.paint-zoom').inputValue();
  check('全体表示の拡大率（1366×700 の 64px は 6 倍）', (await zoom()) === '6', await zoom());
  await page.locator('.paint-stage').focus();
  await page.keyboard.press('5');
  check('数字キー 5 で 16 倍', (await zoom()) === '16');
  await page.keyboard.press('0');
  check('0 で全体表示に戻る', (await zoom()) === '6');
  await page.locator('.paint-zoom').selectOption('12');
  // 12 倍の 64px は枠より大きい：Space＋ドラッグでパンできる
  await page.locator('.paint-stage').focus();
  const c0 = await cell(page, 32, 32, 64);
  await page.keyboard.down(' ');
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  await page.mouse.move(c0.x - 120, c0.y - 80, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  // 動かしたあと、同じ画面の位置にある画素が変わる（絵が上へ 80px 動いたので、y が 80/12 ≒ 6〜7 増える）
  await page.mouse.move(c0.x, c0.y);
  const at = (await page.locator('.paint-coords').textContent()).match(/x (-?\d+), y (-?\d+)/);
  // 12 倍の 64px は、横は枠に収まり（動かない）、縦は枠より大きい（動く）
  check('Space＋ドラッグで絵が動く（パン。枠より大きい向きだけ）', at && Number(at[1]) === 32 && Number(at[2]) >= 37 && Number(at[2]) <= 39, String(at));
  await page.screenshot({ path: `${SHOTS}/10-paint-zoom12-pan.png` });
  await page.locator('.paint-zoom').selectOption('16');
  await page.keyboard.press('0');
  // 色を選ぶ：パレットの色を押すと前景色が変わり、描くとその色になる
  await page.locator('.paint-side .cp-swatch[data-color="#1e7145"], .paint-side .cp-swatch').first().click();
  const primary = await page.locator('.paint-swatch[data-which="primary"]').getAttribute('aria-label');
  check('パレットの色を選ぶと前景色が変わる', /前景色|Primary color/.test(primary), primary);
  await page.locator('.paint-stage').focus();
  await drag(page, 64, [[10, 10], [50, 40]]);
  await page.screenshot({ path: `${SHOTS}/11-paint-64.png` });
  const prev = await page.locator('.paint-previews img').count();
  check('実寸プレビューが 4 つ（16・32 × ライト・ダーク）', prev === 4, String(prev));
  await page.context().close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 6. ライブラリへ保存 → ライブラリから開いて描き直す（別のアイコン -2 になる）');
{
  const page = await newPage();
  await openIconEditor(page);
  await drawNew(page, 16);
  await setPrimary(page, '#ff0000');
  await drag(page, 16, [[2, 2], [12, 2]]);
  await drag(page, 16, [[12, 2], [12, 12]]);
  await finishPaint(page);
  await page.locator('.icon-options input[type=checkbox]').last().check();
  await apply(page);
  const saved = await storedPixels(page);
  // もう一度アイコンエディタを開き、ライブラリから選ぶ
  await openIconEditor(page);
  await page.locator('.icon-sources button:has-text("ライブラリ"), .icon-sources button:has-text("Library")').click();
  await page.waitForTimeout(500);
  await page.locator('.library-grid button, .library-grid .library-item, .library-grid > *').first().click();
  await page.waitForTimeout(900);
  const paintBtn = await page.locator('.icon-paint-edit').isVisible();
  check('ライブラリから開くと［描いて編集…］が出る', paintBtn);
  await page.click('.icon-paint-edit');
  await page.waitForSelector('.paint-canvas');
  await page.waitForTimeout(500);
  const info = await page.locator('.paint-info').textContent();
  check('描いた絵（16 × 16）として開き直せる', /16 × 16/.test(info), info);
  await page.screenshot({ path: `${SHOTS}/12-paint-redraw-from-library.png` });
  // 開き直した絵のプレビュー（出力 32）が、最初に描いて設定した絵と同じ画素
  const reopened = await page.evaluate(async () => {
    const i = new Image(); i.src = [...document.querySelectorAll('.modal-backdrop')].at(-1).querySelector('.icon-preview img').src; await i.decode();
    const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(i, 0, 0);
    return { w: c.width, d: Array.from(x.getImageData(0, 0, c.width, c.height).data) };
  });
  check('ライブラリから開き直した絵が、最初に描いた絵と同じ画素', reopened.w === saved.width && same(reopened.d, saved.data));
  await page.locator('.paint-stage').focus();
  await setPrimary(page, '#0000ff');
  await click(page, 16, 7, 7);
  await finishPaint(page);
  await page.locator('.icon-options input[type=checkbox]').last().check();
  await apply(page);
  const libCount = await page.evaluate(async () => { const { invoke } = await window.__mod('bridge.ts'); return (await invoke('library.list')).icons.map((i) => i.id); });
  check('保存し直すと別のアイコン（-2）になる', libCount.length === 2 && libCount[1].endsWith('-2'), JSON.stringify(libCount));
  const first = await page.evaluate(async (id) => { const { invoke } = await window.__mod('bridge.ts'); const d = await invoke('library.get', { id }); return { options: d.options, ct: d.sourceContentType, name: d.sourceName }; }, libCount[0]);
  check('ライブラリの options に paint が入り、source は image/png', first.options?.paint?.canvas === 16 && first.ct === 'image/png', JSON.stringify(first));
  await page.context().close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 7. 見た目（ライト・ダーク・英語・1366×768）');
for (const v of [{ name: 'light', o: {} }, { name: 'dark', o: { dark: true } }, { name: 'en', o: { en: true } }, { name: 'en-dark-768', o: { en: true, dark: true, height: 768 } }]) {
  const page = await newPage(v.o);
  await openIconEditor(page);
  await page.screenshot({ path: `${SHOTS}/20-${v.name}-icon-editor.png` });
  await drawNew(page, 32);
  await setPrimary(page, '#1e7145');
  await drag(page, 32, [[4, 4], [20, 4], [20, 20], [4, 20], [4, 4]]);
  await page.keyboard.press('g');
  await click(page, 32, 10, 10);
  await page.keyboard.press('m');
  await drag(page, 32, [[6, 6], [12, 12]]);
  await page.screenshot({ path: `${SHOTS}/21-${v.name}-paint.png` });
  await page.locator('#paint-tab-adjust').click();
  await page.screenshot({ path: `${SHOTS}/22-${v.name}-adjust.png` });
  const sideOverflow = await page.evaluate(() => { const b = document.querySelector('.paint-tabbody'); return b.scrollWidth > b.clientWidth + 1; });
  check(`${v.name}：選択範囲の色のタブが横にあふれない`, !sideOverflow);
  await page.locator('#paint-tab-image').click();
  await page.screenshot({ path: `${SHOTS}/23-${v.name}-image.png` });
  await page.locator('#paint-tab-colors').click();
  await page.keyboard.press('r');
  await page.screenshot({ path: `${SHOTS}/24-${v.name}-shape-tool.png` });
  const overflow = await page.evaluate(() => {
    const m = document.querySelector('.modal.size-xl').getBoundingClientRect();
    const body = document.querySelector('.paint-main').getBoundingClientRect();
    const stage = document.querySelector('.paint-stage-wrap').getBoundingClientRect();
    const footer = document.querySelector('.modal.size-xl footer').getBoundingClientRect();
    return { modal: [Math.round(m.width), Math.round(m.height)], stageH: Math.round(stage.height), withinViewport: m.bottom <= innerHeight && m.right <= innerWidth, footerBelow: footer.bottom <= m.bottom + 1, hScroll: document.documentElement.scrollWidth > innerWidth };
  });
  check(`${v.name}：ダイアログが画面に収まり、横にあふれない`, overflow.withinViewport && overflow.footerBelow && !overflow.hScroll, JSON.stringify(overflow));
  console.log('     ', JSON.stringify(overflow));
  await page.context().close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 8. 第 2 段階：図形・選択範囲だけの色の変更・色の置き換え・反転・ブラシ・楕円');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 700 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { localStorage.setItem('sash.paint.guide', '1'); window.__mod = (name) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/' + name)) ?? '/src/' + name); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await page.goto(`${BASE}/?sample`);
  await page.waitForTimeout(2200);
  await openIconEditor(page);
  await drawNew(page, 32);
  const S = 32;
  const settings = page.locator('.paint-tool-settings');
  // 四角形（塗りだけ）：赤と緑
  await setPrimary(page, '#ff0000');
  await page.keyboard.press('r');
  await settings.locator('select[aria-label="塗り"], select[aria-label="Fill"]').selectOption('fill');
  await drag(page, S, [[2, 2], [9, 9]]);
  await setPrimary(page, '#00ff00');
  await page.keyboard.press('r');
  await drag(page, S, [[12, 2], [19, 9]]);
  await page.screenshot({ path: `${SHOTS}/30-rects.png` });
  // 選択（赤い四角を含む範囲）→ 色相を +120 回す（赤 → 緑）。プレビューが見え、適用で 1 手になる
  await page.keyboard.press('m');
  await drag(page, S, [[0, 0], [10, 10]]);
  await page.locator('#paint-tab-adjust').click();
  const hue = page.locator('.paint-adjust input[type=range]').first();
  await hue.fill('120');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/31-hue-preview.png` });
  const histBefore = await page.locator('.paint-undo').isEnabled();
  await page.locator('.paint-adjust button:has-text("適用"), .paint-adjust button:has-text("Apply")').first().click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/32-hue-applied.png` });
  check('色相のプレビューと適用ができる（元に戻すが使える）', histBefore && (await page.locator('.paint-undo').isEnabled()));
  // 選択を外し、色の置き換え：緑 → 青（絵全体）
  await page.keyboard.press('Control+d');
  const fromHex = page.locator('.paint-adjust input.paint-hex').first();
  await fromHex.fill('#00ff00');
  await fromHex.press('Tab');
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${SHOTS}/33-replace-preview.png` });
  const toHex = page.locator('.paint-adjust input.paint-hex').nth(1);
  await toHex.fill('#0000ff');
  await toHex.press('Tab');
  await page.locator('.paint-adjust button:has-text("適用"), .paint-adjust button:has-text("Apply")').nth(1).click();
  await page.waitForTimeout(150);
  // 楕円（線だけ・前景色 赤）
  await setPrimary(page, '#ff0000');
  await page.keyboard.press('o');
  await settings.locator('select[aria-label="塗り"], select[aria-label="Fill"]').selectOption('outline');
  await drag(page, S, [[22, 22], [30, 30]]);
  // ブラシ（太さ 2・硬さ 100・ぼかしなし）
  await page.keyboard.press('b');
  await settings.locator('select[aria-label="太さ"], select[aria-label="Thickness"]').first().selectOption('2').catch(() => undefined);
  await drag(page, S, [[2, 26], [8, 26]]);
  await page.screenshot({ path: `${SHOTS}/34-ellipse-brush.png` });
  // 画像の左右反転（選択なし）
  await page.locator('#paint-tab-image').click();
  await page.locator('.paint-image button:has-text("左右反転"), .paint-image button:has-text("Flip horizontally")').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/35-flipped.png` });
  await finishPaint(page);
  await apply(page);
  const out = await storedPixels(page);
  const BLUE = [0, 0, 255, 255];
  const at = (x, y) => rgbaAt(out, x, y);
  check('色相 +120（選択範囲だけ）と置き換え（緑 → 青）の結果：左右反転後、(25,5) が青', same(at(25, 5), BLUE), String(at(25, 5)));
  check('置き換え（緑 → 青）：もう一方の四角形も青 (15,5)', same(at(15, 5), BLUE), String(at(15, 5)));
  check('反転して、元の左の位置 (5,5) は透明', at(5, 5)[3] === 0, String(at(5, 5)));
  check('楕円（線だけ）：反転後の左右の縁は赤、中心は透明', same(at(1, 26), RED) && same(at(9, 26), RED) && at(5, 26)[3] === 0 && at(5, 22)[3] > 0, `${at(1, 26)} ${at(5, 26)}`);
  check('ブラシの線（太さ 2）：反転後 (26,26) が赤、離れた (26,20) は透明', same(at(26, 26), RED) && at(26, 20)[3] === 0, `${at(26, 26)} ${at(26, 20)}`);
  const legacy = await legacyOutput(page, 'img_btnSummary', 32);
  check('互換：第 2 段階の絵も 0.3.1 の手順で画素が一致する', same(legacy, out.data));
  await ctx.close();
}

console.log('== 9. 見直し 9 件：フォーカスが外にあるときのショートカット・Enter・確認・blur');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 700 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { localStorage.setItem('sash.paint.guide', '1'); window.__mod = (name) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/' + name)) ?? '/src/' + name); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await page.goto(`${BASE}/?sample`);
  await page.waitForTimeout(2200);
  await openIconEditor(page);
  await drawNew(page, 32);
  const S = 32;
  await drag(page, S, [[3, 3], [8, 3]]);
  const open = () => page.locator('.paint-canvas').count();
  // 「丸い筆先」のチェックボックスにフォーカスして Enter：［完了］は押されない
  const roundBox = page.locator('.paint-tool-settings input[type=checkbox]').first();
  await roundBox.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('チェックボックスの上で Enter を押しても、［完了］は押されない', (await open()) === 1);
  // そこで E キー：ショートカットが効く
  await page.keyboard.press('e');
  check('チェックボックスにフォーカスがあっても、ショートカット（E）が効く', (await page.locator('.paint-tool[data-tool="eraser"]').getAttribute('aria-pressed')) === 'true');
  // スライダーの上で Ctrl+Z：元に戻る
  await page.keyboard.press('Control+z');
  check('フォーカスがキャンバスの外でも Ctrl+Z が効く', (await page.locator('.paint-undo').isDisabled()));
  // 見出し（フォーカスを持たない所）を押すと、フォーカスがキャンバスに戻る
  await page.locator('.paint-side h3').first().click();
  await page.keyboard.press('p');
  check('見出しを押してもショートカットが効く（フォーカスがキャンバスへ戻る）', (await page.locator('.paint-tool[data-tool="pencil"]').getAttribute('aria-pressed')) === 'true');
  // ダイアログ本体（DIV.modal）にフォーカスがあるとき Enter：［完了］は押されない
  await page.evaluate(() => [...document.querySelectorAll('.modal')].at(-1).focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('ダイアログ本体で Enter を押しても［完了］は押されない', (await open()) === 1);
  // blur：Space を押したまま別のウィンドウへ移ると、パンのまま残らない
  await page.locator('.paint-stage').focus();
  await page.keyboard.down(' ');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const spaceClass = await page.evaluate(() => document.querySelector('.paint-stage').classList.contains('space'));
  await page.keyboard.up(' ');
  check('別のウィンドウへ移ったあと、Space（パン）の状態が残らない', !spaceClass);
  // ウィンドウの × で終わる前に、描いた内容を確かめる
  await drag(page, S, [[3, 6], [8, 6]]);
  const asked = page.evaluate(async () => (await window.__mod('dialogs/modal.ts')).confirmOpenDialogs());
  await page.waitForTimeout(400);
  check('終了の前に、描いた内容を捨てる確認が出る', /捨てますか|Discard/.test(await topModal(page).textContent()));
  await topModal(page).locator('footer button.primary').click();
  check('［戻る］を選ぶと、終了をやめる（confirmOpenDialogs が false）', (await asked) === false);
  // 完了 → アイコンエディタを Esc で閉じようとすると、描いた絵を捨てる確認が出る
  await finishPaint(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('［設定する］の前に Esc で閉じようとすると、描いた絵を捨てる確認が出る', /描いた絵を捨てますか|Discard the picture/.test(await topModal(page).textContent()));
  await topModal(page).locator('footer button.primary').click();
  await page.waitForTimeout(200);
  check('［戻る］でアイコンエディタに戻る（開いたまま）', (await page.locator('.icon-editor').count()) === 1);
  await apply(page);
  check('［設定する］のあとは確認なしで閉じる', (await page.locator('.modal').count()) === 0);
  await ctx.close();
}

console.log('== 10. キーボードのカーソルで描く・OS のクリップボードへのコピー・描き直しでの半透明の往復');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 700 }, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(() => { localStorage.setItem('sash.paint.guide', '1'); window.__mod = (name) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/' + name)) ?? '/src/' + name); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await page.goto(`${BASE}/?sample`);
  await page.waitForTimeout(2200);
  await openIconEditor(page);
  await drawNew(page, 32);
  await page.locator('.paint-stage').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Enter');
  await page.screenshot({ path: `${SHOTS}/40-keyboard-draw.png` });
  // 半透明の色（不透明度 50%）で、ブラシを 1 点
  await page.keyboard.press('b');
  await page.locator('.paint-tool-settings input[type=range][aria-label="不透明度"], .paint-tool-settings input[type=range][aria-label="Opacity"]').last().fill('50');
  await page.locator('.paint-stage').focus();
  await click(page, 32, 3, 3);
  // 全体をコピー（選択なし）→ OS のクリップボードに画像が入る
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(400);
  const clip = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      const t = items[0]?.types ?? [];
      if (!t.includes('image/png')) return { types: t };
      const blob = await items[0].getType('image/png');
      const bmp = await createImageBitmap(blob);
      return { types: t, w: bmp.width, h: bmp.height };
    } catch (e) { return { error: String(e) }; }
  });
  check('Ctrl+C で、OS のクリップボードに画像（32×32）が入る', clip.w === 32 && clip.h === 32, JSON.stringify(clip));
  await finishPaint(page);
  await apply(page);
  const out = await storedPixels(page);
  const grey = [0x42, 0x42, 0x42, 255];
  check('キーボードのカーソルで描いた線（x 19〜21、y 16）', same(rgbaAt(out, 19, 16), grey) && same(rgbaAt(out, 21, 16), grey) && rgbaAt(out, 22, 16)[3] === 0, `${rgbaAt(out, 19, 16)} ${rgbaAt(out, 21, 16)}`);
  // 元画像（source）は、画素をそのまま書いた PNG：半透明の色（66,66,66,128）が丸められずに残る
  const srcPx = await page.evaluate(async () => {
    const { app } = await window.__mod('app.ts');
    const { decodePng } = await window.__mod('icon/paint/png.ts');
    const e = app.store.images.get('img_btnSummary');
    const d = decodePng(new Uint8Array(await e.edit.source.arrayBuffer()));
    return d ? Array.from(d.data.slice((3 * d.width + 3) * 4, (3 * d.width + 3) * 4 + 4)) : null;
  });
  check('元画像の PNG が、半透明の画素をそのまま保つ（66,66,66,128）', same(srcPx ?? [], [66, 66, 66, 128]), String(srcPx));
  const half = rgbaAt(out, 3, 3);
  check('ブラシの不透明度 50%：半透明の画素になる（アルファ 128 付近）', half[3] > 100 && half[3] < 150, String(half));
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 11. 第 2 段階の見直し：Space+ドラッグ（パン）で描かない・灰色の彩度・プレビュー中の完了・blur');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 700 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { localStorage.setItem('sash.paint.guide', '1'); window.__mod = (name) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/' + name)) ?? '/src/' + name); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await page.goto(`${BASE}/?sample`);
  await page.waitForTimeout(2200);
  await openIconEditor(page);
  await drawNew(page, 64);
  const S = 64;
  await page.locator('.paint-zoom').selectOption('12');
  const primaryLabel = () => page.locator('.paint-swatch[data-which="primary"]').getAttribute('aria-label');
  const label0 = await primaryLabel();
  for (const [k, name] of [['p', '鉛筆'], ['g', '塗りつぶし'], ['i', 'スポイト'], ['w', '自動選択'], ['b', 'ブラシ'], ['m', '四角形の選択']]) {
    await page.locator('.paint-stage').focus();
    await page.keyboard.press(k);
    const c0 = await cell(page, 32, 32, S);
    await page.keyboard.down(' ');
    await page.mouse.move(c0.x, c0.y);
    await page.mouse.down();
    await page.mouse.move(c0.x - 60, c0.y - 40, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up(' ');
    const untouched = await page.locator('.paint-undo').isDisabled();
    check(`Space+ドラッグ（パン）でツール「${name}」を使わない（履歴が増えない）`, untouched && (await primaryLabel()) === label0);
    await page.keyboard.press('0');
    await page.locator('.paint-zoom').selectOption('12');
  }
  // 単独の Space は、カーソルを出していないときは何もしない
  await page.locator('.paint-stage').focus();
  await page.keyboard.press('p');
  await page.keyboard.press(' ');
  check('カーソルを出していない Space 単独では描かない', await page.locator('.paint-undo').isDisabled());
  await page.screenshot({ path: `${SHOTS}/10-paint-zoom12-pan.png` });
  // 灰色の四角を描き、全体に彩度 +50：灰色のまま（赤くならない）
  await setPrimary(page, '#808080');
  await page.keyboard.press('0');
  await page.keyboard.press('r');
  await page.locator('.paint-tool-settings select[aria-label="塗り"], .paint-tool-settings select[aria-label="Fill"]').selectOption('fill');
  await drag(page, S, [[5, 5], [20, 20]]);
  // 色のある四角形（#bf4040）も置く：彩度が実際に適用されたかを、こちらの画素の変化で確かめる
  await setPrimary(page, '#bf4040');
  await page.keyboard.press('0');
  await page.keyboard.press('r');
  await drag(page, S, [[30, 5], [45, 20]]);
  await page.locator('#paint-tab-adjust').click();
  const sat = page.locator('.paint-adjust input[type=range]').nth(1);
  await sat.fill('50');
  await page.waitForTimeout(150);
  // プレビュー中に別のタブへ替えると、プレビューは捨てられる
  await page.locator('#paint-tab-image').click();
  await page.locator('#paint-tab-adjust').click();
  check('タブを替えると、プレビューが捨てられ、スライダーが 0 に戻る', (await sat.inputValue()) === '0');
  await sat.fill('50');
  await page.waitForTimeout(100);
  // プレビュー中の［完了］：適用するか尋ねる（既定は適用）
  await topModal(page).locator('footer button.primary').click();
  await page.waitForTimeout(300);
  check('プレビュー中の［完了］で、適用するかを尋ねる', /プレビュー|previewed/.test(await topModal(page).textContent()));
  await page.screenshot({ path: `${SHOTS}/36-finish-with-preview.png` });
  await topModal(page).locator('footer button.primary').click();
  await page.waitForTimeout(600);
  await apply(page);
  const out = await storedPixels(page);
  check('灰色（128,128,128）に彩度 +50 をかけても、灰色のまま', same(rgbaAt(out, 7, 7), [128, 128, 128, 255]), String(rgbaAt(out, 7, 7))); // 64 の絵は出力 32 に縮むので、四角形（5〜20）の内側の (7,7)
  const red = rgbaAt(out, 19, 7);
  check('彩度 +50 が実際に適用されている（#bf4040 の色のある四角形は、赤みが増す）', red[0] - red[1] > 191 - 64 + 5 && red[3] === 255, String(red));
  check('パンした間に、絵に何も描かれていない（四角形の外は透明）', rgbaAt(out, 25, 25)[3] === 0 && rgbaAt(out, 1, 1)[3] === 0);
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------
console.log('== 12. 最終確認の指摘：カーソルを出していない Space・Space を押したままの操作・Shift+Space・手引き・レイアウト');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { window.__mod = (name) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/' + name)) ?? '/src/' + name); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await page.goto(`${BASE}/?sample`);
  await page.waitForTimeout(2200);
  await openIconEditor(page);
  await drawNew(page, 32);
  const S = 32;
  check('新しい絵の［色］タブ：「まだ色がありません」が横に読める（幅が 100px 以上）', (await page.locator('.paint-used > span').evaluate((e) => e.getBoundingClientRect().width)) > 100);
  await page.screenshot({ path: `${SHOTS}/50-guide-768.png` });
  await click(page, S, 3, 3);
  check('最初に描いたら、初回の手引きが閉じる', (await page.locator('.paint-guide').count()) === 0);
  // 選択を矢印で動かし、Ctrl+D、Space だけを押して離す：中央 (16,16) に点が付かない
  await page.keyboard.press('m');
  await drag(page, S, [[2, 2], [4, 4]]);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+d');
  await page.keyboard.press('p');
  await page.keyboard.press(' ');
  // 矢印でカーソルを出してから、Space を押したまま数字キー（拡大）：離しても描かない
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.down(' ');
  await page.keyboard.press('1');
  await page.keyboard.up(' ');
  await page.keyboard.down(' ');
  await page.keyboard.press('b');
  await page.keyboard.up(' ');
  await page.keyboard.press('p');
  // Shift+Space：前の点から直線（カーソルを 15,20 → 19,20 へ。中央 (16,16) とは別の行）
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+ArrowRight');
  await page.keyboard.press('Control+ArrowRight');
  await page.keyboard.press('Control+ArrowRight');
  await page.keyboard.press('Control+ArrowRight');
  await page.keyboard.down('Shift');
  await page.keyboard.press(' ');
  await page.keyboard.up('Shift');
  await page.locator('#paint-tab-adjust').click();
  await page.screenshot({ path: `${SHOTS}/51-adjust-768.png` });
  const fit = await page.evaluate(() => { const b = document.querySelector('.paint-tabbody'); return { scroll: b.scrollHeight, client: b.clientHeight }; });
  console.log(`      選択範囲の色タブ（768）：中身 ${fit.scroll}px／表示 ${fit.client}px`);
  await finishPaint(page);
  await apply(page);
  const out = await storedPixels(page);
  check('Space だけを離しても、中央（16,16）に点が付かない（選択を矢印で動かしたあと・カーソルを出していない）', rgbaAt(out, 16, 16)[3] === 0 && rgbaAt(out, 16, 15)[3] === 0);
  check('選択を矢印で動かした結果（(4,3) に赤…前景色の灰）が残り、(3,3) は空', rgbaAt(out, 4, 3)[3] === 255 && rgbaAt(out, 3, 3)[3] === 0);
  const line = [15, 16, 17, 18, 19].map((x) => rgbaAt(out, x, 20)[3] === 255);
  check('Shift+Space で前の点（15,20）からカーソル（19,20）まで直線が引かれる', line.every(Boolean), String(line));
  check('Space を押したまま数字キー・ツールのキーを使っても、離したときに描かない（描かれるのは 15,20 の 1 点と直線だけ）', rgbaAt(out, 20, 20)[3] === 0 && rgbaAt(out, 15, 19)[3] === 0 && rgbaAt(out, 15, 21)[3] === 0);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? '\n全部 OK' : `\n失敗 ${failures} 件`);
process.exit(failures === 0 ? 0 : 1);
