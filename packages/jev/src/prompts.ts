/**
 * 判题提示词：从旧 lib/jev.ts 提取，保留三项用途与中英文规则原文。
 * 调整提示词必须换 promptVersion 并先过评测（docs/rebuild/04-ROOM-JEV.md §8）。
 *
 * state 的键名与旧系统逐字段一致（保留判题语义），ask/solve 新增可选的核心事实。
 */
import type { Language } from './types.js';

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface AskInput {
  title: string;
  surface: string;
  answer: string;
  coreFacts?: string[];
  question: string;
}

export interface SolveInput {
  title: string;
  surface: string;
  answer: string;
  coreFacts?: string[];
  solution: string;
}

export interface ReviewInput {
  title: string;
  surface: string;
  answer: string;
  hints: string[];
}

export function askQuestion(language: Language): ChoiceQuestion {
  if (language === 'en') {
    return {
      type: 'choice',
      instructions: 'Judge the player question against the answer. Choose only Yes, No or Irrelevant.',
      criteria: {
        Yes: 'The answer supports the claim or a reasonable inference in the question.',
        No: 'The answer contradicts the claim or a reasonable inference in the question.',
        Irrelevant: 'The question has no material connection to the answer.',
      },
    };
  }
  return {
    type: 'choice',
    instructions: '根据真相判断玩家提问，只能选择是、否、无关。',
    criteria: {
      是: '提问的事实或合理推论被真相支持。',
      否: '提问的事实或合理推论被真相否定。',
      无关: '提问和真相没有实质关系。',
    },
  };
}

export function solveQuestion(language: Language): ChoiceQuestion {
  if (language === 'en') {
    return {
      type: 'choice',
      instructions:
        "Compare the player's reconstruction with the answer. Focus on the core event, key reasons and causal chain. Exact wording is not required.",
      criteria: {
        Solved: 'The player covers the core event, key reasons and causal connections.',
        Close: 'The player has the main idea but misses a key reason or causal step.',
        'Not yet': 'The explanation conflicts with the central facts of the answer.',
      },
    };
  }
  return {
    type: 'choice',
    instructions: '判断玩家是否还原了汤底的核心事件、关键原因和因果链。仅根据汤底判断，不要求逐字一致。',
    criteria: {
      破解成功: '玩家覆盖了汤底的核心事件、关键原因与因果关系。',
      接近真相: '玩家抓住了主要方向，但遗漏一个关键原因或因果环节。',
      还没猜对: '玩家的解释与汤底核心事实不一致。',
    },
  };
}

export function reviewQuestion(language: Language): ChoiceQuestion {
  if (language === 'en') {
    return {
      type: 'choice',
      instructions:
        'Review this entire situation puzzle for sexual or political content. Consider every field. Ordinary suspense, death, crime and police investigations are allowed.',
      criteria: {
        Approved: 'Contains no sexual content or political figures, events, advocacy or policy disputes.',
        Rejected: 'Contains sexual descriptions or acts, or political figures, events, advocacy or policy disputes.',
      },
    };
  }
  return {
    type: 'choice',
    instructions:
      '审核整道海龟汤是否适合公开。只检查色情或政治内容；标题、汤面、汤底和提示任一处涉及这两类内容，就选不通过。普通的悬疑、死亡、犯罪和警察办案不因此被判为政治内容。',
    criteria: {
      通过: '没有色情内容，也没有政治人物、政治事件、政治宣传或政策争议等政治内容。',
      不通过: '包含色情描写或性行为内容，或者包含政治人物、政治事件、政治宣传或政策争议等政治内容。',
    },
  };
}

export function askState(input: AskInput, language: Language): Record<string, unknown> {
  if (language === 'en') {
    return {
      story: input.surface,
      answer: input.answer,
      ...(input.coreFacts?.length ? { coreFacts: input.coreFacts } : {}),
      playerQuestion: input.question,
    };
  }
  return {
    汤面: input.surface,
    真相: input.answer,
    ...(input.coreFacts?.length ? { 核心事实: input.coreFacts } : {}),
    玩家提问: input.question,
  };
}

export function solveState(input: SolveInput, language: Language): Record<string, unknown> {
  if (language === 'en') {
    return {
      story: input.surface,
      answer: input.answer,
      ...(input.coreFacts?.length ? { coreFacts: input.coreFacts } : {}),
      playerSolution: input.solution,
    };
  }
  return {
    汤面: input.surface,
    汤底: input.answer,
    ...(input.coreFacts?.length ? { 核心事实: input.coreFacts } : {}),
    玩家还原: input.solution,
  };
}

export function reviewState(input: ReviewInput, language: Language): Record<string, unknown> {
  if (language === 'en') {
    return { title: input.title, story: input.surface, answer: input.answer, hints: input.hints };
  }
  return { 标题: input.title, 汤面: input.surface, 汤底: input.answer, 提示: input.hints };
}
