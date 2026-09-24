import type { NextConfig } from 'next';

// B站 Toy 静态包构建：由 scripts/build-toy.mjs 传入 TOY_BUILD=1 和 TOY_SLUG（Toy 上自定义的 /toy/<slug> 路径）。
// 静态导出不支持 proxy.ts 与依赖请求体的 API 路由，构建脚本会先把 app/api、app/admin、proxy.ts 临时移出再构建。
const toyBuild = process.env.TOY_BUILD === '1';
const toySlug = process.env.TOY_SLUG ?? '';
if (toyBuild && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(toySlug)) {
  throw new Error('TOY_BUILD 需要 TOY_SLUG：小写字母/数字/连字符，与 B站 Toy 上填写的自定义路径一致');
}

const nextConfig: NextConfig = toyBuild
  ? {
      // 静态导出到 out/：B站 Toy 只托管静态文件
      output: 'export',
      // 页面最终挂在 https://www.bilibili.com/toy/<slug>/ 子路径下，
      // 资源引用前缀必须与之对齐，否则加载 /_next/... 时按站点根解析导致白屏
      basePath: `/toy/${toySlug}`,
    }
  : {};

export default nextConfig;
