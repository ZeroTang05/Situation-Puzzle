/**
 * 依赖声明检查：扫描 apps/ packages/ 下所有 src 的外部 import，
 * 与各自 package.json 的 dependencies 对比，列出「用了但没声明」的包。
 * pnpm 严格 node_modules 下未声明依赖会在容器里炸（ERR_MODULE_NOT_FOUND）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const roots = ['apps', 'packages'];

/** 递归收集目录下的 .ts/.tsx 文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const root of roots) {
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    const pkgPath = join(dir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      continue; // 没有 package.json 的目录跳过
    }
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    const files = walk(dir).filter((f) => !f.includes('drizzle/'));
    const imported = new Map(); // 包名 -> 首个文件
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (!spec || !spec.startsWith('.')) {
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          // bun/node 内置与 workspace 包不算
          if (name.startsWith('@jev/') || ['node:fs', 'node:path', 'bun'].includes(name)) continue;
          if (!imported.has(name)) imported.set(name, relative('.', file));
        }
      }
    }
    for (const [name, file] of imported) {
      if (!declared.has(name)) problems.push(`${dir}: import '${name}' (${file}) 未在 package.json 声明`);
    }
  }
}
if (problems.length === 0) console.log('OK：所有外部依赖均已声明');
else for (const p of problems) console.log(p);
