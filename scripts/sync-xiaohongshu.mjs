/** 将 Web 的题库和界面文案同步为小红书开发工具可直接读取的模块。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'platforms', 'xiaohongshu', 'shared');
await mkdir(target, { recursive: true });

const zh = JSON.parse(await readFile(join(root, 'data', 'library.json'), 'utf8'));
const en = JSON.parse(await readFile(join(root, 'data', 'library.en.json'), 'utf8'));
await writeFile(join(target, 'library.js'), `/** 由 pnpm sync:xiaohongshu 从 Web 题库生成，请修改 data/library*.json。 */\nmodule.exports = ${JSON.stringify({ zh, en })};\n`);

const source = await readFile(join(root, 'lib', 'i18n.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
await writeFile(join(target, 'i18n.js'), `/** 由 pnpm sync:xiaohongshu 从 Web 文案生成，请修改 lib/i18n.ts。 */\n${output.outputText}`);
