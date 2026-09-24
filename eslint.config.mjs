import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// 检查应用源码，忽略 Next.js 构建产物。
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'worker/.wrangler/**']),
  {
    files: ['app/page.tsx'],
    // 首次进入时需要把 URL 中的一次性分享题目和平台身份写入页面状态。
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
]);
