import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 本地开发时代理到的 API 地址；8080 被占用时用 API_PROXY_TARGET 换端口。
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig(({ mode, command }) => {
  const h5 = mode === 'taptap' || mode === 'taptap-debug';
  const debug = mode === 'taptap-debug';
  const env = loadEnv(mode, process.cwd());
  const apiBase = env.VITE_API_BASE_URL ?? 'https://sp.xiaobaozi.cn';
  const proxyTarget = h5 ? apiBase : apiTarget;
  const proxyChangesHost = new URL(proxyTarget).protocol === 'https:';
  if (h5) {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:' || url.origin !== apiBase) throw new Error('H5 API 地址必须是 HTTPS 来源，不能带路径或末尾斜杠');
  }
  return {
    base: h5 ? './' : '/',
    define: {
      'import.meta.env.VITE_TAPTAP_H5': JSON.stringify(String(h5)),
      'import.meta.env.VITE_TAPTAP_DEBUG': JSON.stringify(String(debug)),
      ...(h5 ? { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(command === 'serve' ? '' : apiBase) } : {}),
    },
    plugins: [react()],
    server: {
      port: 5173,
      // 本地开发时代理到 API，验证页面使用真实服务。
      proxy: {
        '/api/v1': { target: proxyTarget, changeOrigin: proxyChangesHost, ws: true },
        '/ws': { target: proxyTarget.replace(/^http/, 'ws'), changeOrigin: proxyChangesHost, ws: true },
      },
    },
    build: {
      outDir: h5 ? (debug ? 'dist-taptap-debug' : 'dist-taptap') : 'dist',
      sourcemap: debug,
      // 文件名带内容摘要，更新构建后浏览器重新获取对应资源。
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
