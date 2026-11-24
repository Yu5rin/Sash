import { defineConfig } from 'vite';
import browserslist from 'browserslist';
import { browserslistToTargets } from 'lightningcss';

// 対応する WebView2 ランタイムの下限は Chromium 109（docs/SPEC.md §3）。
// light-dark()（123〜）や color-mix()、CSS の入れ子（120〜）は、古い版では宣言ごと無効になり背景が消えるため、
// lightningcss で古い版でも動く形に下げる。
const cssTargets = browserslistToTargets(browserslist('chrome >= 109'));

// ビルド成果物はホスト（Sash.App）の wwwroot に出力し、埋め込みリソースとして exe に入れる
export default defineConfig({
  base: './',
  css: {
    transformer: 'lightningcss',
    lightningcss: { targets: cssTargets },
  },
  build: {
    outDir: '../src/Sash.App/wwwroot',
    emptyOutDir: true,
    target: 'es2022',
    cssMinify: 'lightningcss',
    chunkSizeWarningLimit: 4096,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
