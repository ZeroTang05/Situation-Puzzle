import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 本地开发代理到 API 进程，浏览器同源携带会话 Cookie
    proxy: {
      '/api/v1': { target: 'http://localhost:8080', changeOrigin: false, ws: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 让每次构建出不同 chunk 文件名，避免 SPA HTML 在浏览器缓存期内引用旧的同名 JS。
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
