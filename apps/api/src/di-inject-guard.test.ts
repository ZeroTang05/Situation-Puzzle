/**
 * 显式依赖注入守卫。
 *
 * tsx(esbuild) 不生成构造参数元数据，Nest 依赖注入必须显式 `@Inject(Token)`，
 * 否则运行时 `this.xxx` 为 undefined（AGENTS.md「踩坑点」第一条）。
 * 这个 bug 只有在请求真正走到那一行时才炸，接口测试很容易漏掉，
 * 所以把约定做成可执行的门禁：Nest 管理的类，其构造参数属性必须带 @Inject。
 *
 * 只检查 @Injectable / @Controller 装饰的类——手工 new 出来的普通类不需要。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('.', import.meta.url));

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* tsFiles(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/** 按顶层逗号切分构造参数（跳过尖括号与括号内部的逗号）。 */
function splitParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === '>' || char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** 取出每个 Nest 类（@Injectable / @Controller）的类体。 */
function nestClassBodies(source: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  const classRe = /@(?<kind>Injectable|Controller)\([^)]*\)(?:\s*\n\s*@[\w.]+\([^)]*\))*\s*(?:export\s+)?class\s+(?<name>\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(source)) !== null) {
    const name = match.groups!.name!;
    const start = match.index + match[0].length;
    const end = source.indexOf('\n}', start);
    results.push({ name, body: source.slice(start, end === -1 ? source.length : end) });
  }
  return results;
}

describe('显式依赖注入守卫', () => {
  // 守卫要扫全部 API 源文件，并行跑 CI 时会逼近默认 5s 超时，这里放宽到 30s
  it('Nest 类的构造参数属性必须带 @Inject', async () => {
    const offenders: string[] = [];
    for await (const file of tsFiles(srcDir)) {
      const source = await readFile(file, 'utf8');
      for (const klass of nestClassBodies(source)) {
        const constructorMatch = /constructor\s*\(([\s\S]*?)\)\s*\{/.exec(klass.body);
        if (!constructorMatch) continue;
        for (const param of splitParams(constructorMatch[1]!)) {
          // 只管参数属性（private/protected/public 修饰的构造注入）
          if (!/\b(private|protected|public)\b/.test(param)) continue;
          if (param.includes('@Inject(')) continue;
          const name =
            param.replace(/^\s*(private|protected|public)?\s*(readonly)?\s*/, '').split(':')[0]?.trim() || '(未命名)';
          offenders.push(`${path.relative(srcDir, file)}: ${klass.name} 的构造参数 ${name} 缺少 @Inject(...)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 30_000);
});
