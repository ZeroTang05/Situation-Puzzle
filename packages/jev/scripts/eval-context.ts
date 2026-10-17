/**
 * 判题上下文评测：同一道题、同一句代词提问，对比「无历史问答」与「带最近问答」的判定。
 * 用法（密钥在根 .env.local）：
 *   cd apps/api && pnpm exec tsx --env-file=../../.env.local ../../packages/jev/scripts/eval-context.ts
 * 结论记录在 docs/rebuild/04-ROOM-JEV.md §8。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JevClient, jevConfigFromEnv } from '../src/index.js';
import type { AskInput, RecentQa } from '../src/prompts.js';
import type { AskVerdict } from '../src/types.js';

interface LibraryPuzzle {
  id: string;
  title: string;
  story: string;
  answer: string;
  category?: string;
}

interface Case {
  puzzleId: string;
  /** 模拟玩家此前几轮已判定的问答（旧在前） */
  recent: RecentQa[];
  question: string;
  /** 带上下文时的预期判定 */
  expectWithCtx: AskVerdict;
  note: string;
}

const zhCategory = (raw: string | undefined): AskInput['category'] =>
  raw === '本格' ? 'honkaku' : raw === '变格' ? 'henkaku' : null;

// 用例设计：汤面里不出现该人物，代词只有靠最近问答才能落到正确对象上。
const cases: Case[] = [
  {
    puzzleId: 'real-fathers-salary',
    recent: [{ question: '爸爸打赏的那位主播是女的吗', verdict: 'no' }],
    question: '她其实是我吗',
    expectWithCtx: 'yes',
    note: '汤面只有爸妈与我；「她」= 上一轮确立的主播（我男扮女装）',
  },
  {
    puzzleId: 'real-endless-thuds',
    recent: [{ question: '咚声是尸体落地发出的吗', verdict: 'yes' }],
    question: '他正在一层一层往我的楼层下来吗',
    expectWithCtx: 'yes',
    note: '汤面只有咚声与我；「他」= 上一轮确立的抛尸者（逐层下行）',
  },
  {
    puzzleId: 'real-endless-thuds',
    recent: [{ question: '凶手是那个失去孩子的父亲吗', verdict: 'yes' }],
    question: '他还活着吗',
    expectWithCtx: 'yes',
    note: '消歧用例：汤底里有父亲和孩子两个男性，「他」无历史时两可，有历史时指向凶手（父亲）',
  },
  {
    puzzleId: 'real-fathers-salary',
    recent: [{ question: '妈妈知道打赏的钱去了哪里吗', verdict: 'no' }],
    question: '妈妈知道收钱的人是谁吗',
    expectWithCtx: 'no',
    note: '控制组：问句不用代词，历史不影响判定（收钱人=儿子，妈妈不知情）',
  },
];

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const lib = JSON.parse(readFileSync(join(here, '../../../data/library.json'), 'utf8')) as LibraryPuzzle[];

  const config = jevConfigFromEnv();
  const client = new JevClient(config);

  for (const c of cases) {
    const puzzle = lib.find((p) => p.id === c.puzzleId);
    if (!puzzle) throw new Error(`题目不存在：${c.puzzleId}`);
    const base: Omit<AskInput, 'question'> = {
      title: puzzle.title,
      surface: puzzle.story,
      answer: puzzle.answer,
      category: zhCategory(puzzle.category),
    };

    const withoutCtx = await client.ask({ ...base, question: c.question });
    const withCtx = await client.ask({ ...base, recentQas: c.recent, question: c.question });

    const ok = withCtx.result === c.expectWithCtx;
    console.log(`\n[${puzzle.title}] ${c.note}`);
    console.log(`  历史：${c.recent.map((r) => `${r.question} → ${r.verdict}`).join('；')}`);
    console.log(`  提问：${c.question}`);
    console.log(`  无上下文：${withoutCtx.result} (${withoutCtx.confidence.toFixed(2)})`);
    console.log(`  有上下文：${withCtx.result} (${withCtx.confidence.toFixed(2)})  预期 ${c.expectWithCtx} → ${ok ? 'PASS' : 'FAIL'}`);
  }
}

await main();
