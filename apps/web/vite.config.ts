import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 本地开发时代理到的 API 地址；8080 被占用时用 API_PROXY_TARGET 换端口。
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 本地开发代理到 API 进程，浏览器同源携带会话 Cookie
    proxy: {
      '/api/v1': { target: apiTarget, changeOrigin: false, ws: true },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
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
