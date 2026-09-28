import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // /admin 由宿主 Nginx 反代到 admin:80；前端资源必须以 /admin/ 为基础路径，
  // 否则 HTML 引用的 /assets/* 会被宿主 ^~ / 抓到 web 容器引起 404。
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api/v1': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
});
