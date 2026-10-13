/** 从统一题库和提示词构建小红书离线 H5，审计后生成上传 ZIP。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ZipArchive } from 'archiver';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'platforms/xiaohongshu/minitool');
const output = path.join(root, 'minitool-dist');
const app = path.join(output, 'app');
const skillAudit = path.join(root, '.codex/minitool-zip-builder/scripts/audit_artifact.mjs');
const artifact = path.join(output, 'jev-xiaohongshu-minitool.zip');

/** 使用 TypeScript 编译器读取本项目常量，避免为 TS 文件编写解析规则。 */
function readConstants(relative) {
  const filename = path.join(root, relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports }, { filename, timeout: 1000 });
  return exports;
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`构建检查失败：${command}，退出码 ${result.status}`);
}

if (!fs.existsSync(skillAudit)) throw new Error('缺少 .codex/minitool-zip-builder，请先按小红书上传页指引下载并解压 Skill');
// 只清理此脚本拥有的产物目录；解析后的路径须位于本仓库内。
if (!output.startsWith(root + path.sep) || path.basename(output) !== 'minitool-dist') throw new Error('产物清理路径越界');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(app, 'assets'), { recursive: true });

const baseCopy = readConstants('lib/i18n.ts').copy;
const extraCopy = {
  zh: {
    share: '分享', library: '题库', search: '搜索题目', previousHint: '上一条提示', nextHint: '下一条提示', noMatches: '没有找到这道题',
    judging: '正在判断…', checking: '正在校验…', uncertainDetail: '这次判断把握不足，试着换一种说法。',
    aiUnavailable: '请在支持 AI 判题的小红书小工具中打开。', aiNotAllowed: 'AI 判题尚未开通，请先为此小工具申请平台 AI 白名单。',
    storageUnavailable: '当前环境无法保存进度，关闭页面后答题记录会丢失。', storageFailed: '答题记录保存失败。',
    requestFailed: '判题请求失败，请重试。', invalidReply: 'AI 返回了无效判定，请重试。', inputTooLong: '内容过长，请缩短后再发送。',
    shareUnavailable: '当前环境暂不支持发布笔记。', shareInvitation: '来和 Jev 玩海龟汤，一起还原真相。',
  },
  en: {
    share: 'Share', library: 'Library', search: 'Search puzzles', previousHint: 'Previous hint', nextHint: 'Next hint', noMatches: 'No matching puzzles',
    judging: 'Thinking…', checking: 'Checking…', uncertainDetail: 'The judgment is uncertain. Try rephrasing.',
    aiUnavailable: 'Open this tool in a Xiaohongshu app that supports AI judging.', aiNotAllowed: 'AI access is not enabled. Apply for the platform AI allowlist for this tool.',
    storageUnavailable: 'Progress cannot be saved here and will be lost when you close the page.', storageFailed: 'Could not save progress.',
    requestFailed: 'Judgment failed. Please retry.', invalidReply: 'The AI returned an invalid judgment. Please retry.', inputTooLong: 'The text is too long. Shorten it before sending.',
    shareUnavailable: 'Posting a note is unavailable here.', shareInvitation: 'Solve this situation puzzle with Jev.',
  },
};
const copy = {};
const library = {};
for (const language of ['zh', 'en']) {
  copy[language] = Object.assign({}, baseCopy[language], extraCopy[language]);
  const filename = language === 'zh' ? 'data/library.json' : 'data/library.en.json';
  library[language] = JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')).map(({ id, title, story, answer, hints }) => ({ id, title, story, answer, hints }));
  if (!library[language].length) throw new Error(`${filename} 题库为空`);
  for (const soup of library[language]) {
    if (![soup.id, soup.title, soup.story, soup.answer].every((value) => typeof value === 'string' && value.trim()) || !Array.isArray(soup.hints) || !soup.hints.every((hint) => typeof hint === 'string')) throw new Error(`题目字段不完整：${soup.id}`);
  }
}
if (library.zh.length !== library.en.length || library.zh.some((soup, index) => soup.id !== library.en[index].id)) throw new Error('中英文题库身份或顺序不一致');
const prompts = { question: readConstants('lib/prompts/question.ts').questionPrompt, solution: readConstants('lib/prompts/solution.ts').solutionPrompt };
const labels = {
  zh: { Yes: '是', No: '否', Irrelevant: '无关', Uncertain: '无法确定', Solved: '破解成功', Close: '接近真相', 'Not yet': '还没猜对' },
  en: { Yes: 'Yes', No: 'No', Irrelevant: 'Irrelevant', Uncertain: 'Uncertain', Solved: 'Solved', Close: 'Close', 'Not yet': 'Not yet' },
};
const details = {};
for (const language of ['zh', 'en']) {
  const t = copy[language];
  details[language] = { Solved: t.solvedDetail, Close: t.closeDetail, 'Not yet': t.notYetDetail, Uncertain: t.uncertainDetail };
}
const data = JSON.stringify({ copy, library, prompts, labels, details }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
fs.writeFileSync(path.join(app, 'assets/data.js'), '/** 构建生成的离线题库、文案与提示词。 */\nwindow.JevMiniToolData = ' + data + ';\n');
fs.copyFileSync(path.join(source, 'index.html'), path.join(app, 'index.html'));
fs.copyFileSync(path.join(source, 'style.css'), path.join(app, 'assets/style.css'));
const mainSource = fs.readFileSync(path.join(source, 'main.js'), 'utf8');
const compiled = ts.transpileModule(mainSource, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2017, allowJs: true }, reportDiagnostics: true });
if (compiled.diagnostics && compiled.diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('小工具脚本编译失败');
fs.writeFileSync(path.join(app, 'assets/main.js'), compiled.outputText);

/** 用编译器 AST 核对页面元素清单，避免字符串规则误读 JavaScript。 */
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.ES2017, true, ts.ScriptKind.JS);
let ids;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'ids' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) ids = node.initializer.elements.map((element) => element.text);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!ids || !ids.length) throw new Error('缺少页面元素声明');
fs.writeFileSync(path.join(output, 'expected-dom-ids.json'), JSON.stringify(ids));
run(process.execPath, ['--check', path.join(app, 'assets/main.js')]);
run(process.execPath, ['--check', path.join(app, 'assets/data.js')]);
run('python', [path.join(root, 'scripts/validate-xiaohongshu-minitool.py'), app, path.join(output, 'expected-dom-ids.json')]);
fs.unlinkSync(path.join(output, 'expected-dom-ids.json'));
run(process.execPath, [skillAudit, app]);

const archive = new ZipArchive({ zlib: { level: 9 } });
const stream = fs.createWriteStream(artifact);
const finished = new Promise((resolve, reject) => { stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject); });
archive.pipe(stream);
archive.directory(app, false);
await archive.finalize();
await finished;
run(process.execPath, [skillAudit, artifact]);
run('python', [path.join(root, '.codex/minitool-zip-builder/scripts/audit_artifact.py'), artifact]);

const zipBytes = fs.statSync(artifact).size;
const textBytes = ['index.html', 'assets/style.css', 'assets/main.js', 'assets/data.js'].reduce((total, name) => total + fs.statSync(path.join(app, name)).size, 0);
const summary = `# 小红书小工具校验摘要\n\n- 依据：下载的 minitool-zip-builder 1.7.0 及 2026-10-13 在线容器文档。\n- 结构、资源路径、脚本语法、DOM 元素、禁用能力扫描：通过。\n- 官方目录与 ZIP 体积审计：通过。\n- ZIP 根目录入口：index.html；共 4 个产物文件。\n- 中英文题库：每语言 ${library.zh.length} 题，共用题目 ID。\n- 压缩包：${zipBytes} 字节；解压后文本合计：${textBytes} 字节。\n- AI：window.xhs.AI.createModel("deepseek-v4-flash")，真实平台 API；需要 appId 内测白名单。\n- 存储：客户端 9.46+ 优先平台 Storage；低版本使用浏览器存储，存储不可用时明确提示。\n- 分享：用户点击后生成汤面图片，官方 postNote 唤起笔记发布页。\n- 提问与还原提示词复用 lib/prompts；还原允许省略不影响真相的细节。\n- 题库列表每页 20 条；无外部请求、API 密钥、内联脚本、模块脚本、WebGL 或静态 Base64 资源。\n- 待用户验证：创服平台模拟器、Android 真机扫码、iOS 真机扫码，须验证同一份 ZIP。\n- Chrome 61 JS/CSS 兼容性与真机性能未实测；普通浏览器结果不作为容器验收依据。\n\n产物：${artifact}\n`;
fs.writeFileSync(path.join(output, 'validation-summary.md'), summary);
console.log(`已生成：${artifact}（${(zipBytes / 1024 / 1024).toFixed(2)} MiB）`);
