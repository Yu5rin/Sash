import { defineConfig } from 'vite';

// ビルド成果物はホスト（Sash.App）の wwwroot に出力し、埋め込みリソースとして exe に入れる
export default defineConfig({
  base: './',
  build: {
    outDir: '../src/Sash.App/wwwroot',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
