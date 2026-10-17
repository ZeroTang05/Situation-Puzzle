/**
 * Jev 的中英文判题提示词：提问、还原和审核；还原允许省略不影响真相的细节。
 * 调整提示词必须换 promptVersion 并先过评测（docs/rebuild/04-ROOM-JEV.md §8）。
 *
 * state 的键名与旧系统逐字段一致（保留判题语义），ask/solve 新增可选的核心事实。
 */
import type { AskVerdict, Language } from './types.js';

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** 题目类别：honkaku=本格（汤底须现实合理），henkaku=变格（允许超自然设定）。 */
export type PuzzleCategory = 'honkaku' | 'henkaku';

/** 类别注记：把这类汤底的现实性边界写进判题上下文，辅助判定涉及超自然的提问。null/undefined（未分类）不写入。 */
function categoryEntry(category: PuzzleCategory | null | undefined, language: Language): Record<string, unknown> {
  if (!category) return {};
  const note =
    category === 'honkaku'
      ? language === 'en'
        ? 'Honkaku: the answer is a realistic explanation with no supernatural forces.'
        : '本格：汤底是现实合理的解释，不存在超自然力量。'
      : language === 'en'
        ? 'Henkaku: the answer may include supernatural or unrealistic elements.'
        : '变格：汤底可以包含超自然或非现实设定。';
  return language === 'en' ? { category: note } : { 类别: note };
}

/** 一轮已判定的问答，作为判题上下文：question=玩家原句，verdict=当时的判定。 */
export interface RecentQa {
  question: string;
  verdict: AskVerdict;
}

export interface AskInput {
  title: string;
  surface: string;
  answer: string;
  coreFacts?: string[];
  category?: PuzzleCategory | null;
  /** 最近几轮已判定的问答（旧在前），帮助解析当前问题里的代词指代；可省略。 */
  recentQas?: RecentQa[];
  question: string;
}

export interface SolveInput {
  title: string;
  surface: string;
  answer: string;
  coreFacts?: string[];
  category?: PuzzleCategory | null;
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
        "Compare the player's reconstruction with the answer. Focus on the core event, key reasons and causal chain that explain the mystery. Accept equivalent wording, different narrative order and omission of details that do not affect the core truth. Names, exact times and locations are required only when essential to the explanation. A complete core causal chain counts as solved even if incidental details are omitted.",
      criteria: {
        Solved: 'The player covers the core event, key reasons and causal connections; incidental detail omissions and differences are allowed.',
        Close: 'The player has the main idea but misses a fact, reason or causal step essential to explaining the mystery.',
        'Not yet': 'The explanation conflicts with central facts. Incidental detail differences alone do not qualify.',
      },
    };
  }
  return {
    type: 'choice',
    instructions: '根据汤底判断玩家是否还原了解释谜团所需的核心事件、关键原因和因果链。允许同义表达、不同叙述顺序，以及省略不影响核心真相的细节。姓名、时间、地点等仅在影响核心解释时才需覆盖。核心因果链完整时，即使省略装饰细节也应判成功。',
    criteria: {
      破解成功: '玩家覆盖了汤底的核心事件、关键原因与因果关系；允许省略不影响真相的细节或存在装饰细节差异。',
      接近真相: '玩家抓住主要方向，但遗漏了解释谜团必需的关键事实、原因或因果环节。',
      还没猜对: '玩家的解释与汤底核心事实冲突。仅有装饰细节差异不足以判为还没猜对。',
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

/** 判定值转展示标签：与玩家看到的判定文案一致，帮助模型对齐历史轮次的语义。 */
const verdictLabels: Record<AskVerdict, Record<Language, string>> = {
  yes: { zh: '是', en: 'yes' },
  no: { zh: '否', en: 'no' },
  irrelevant: { zh: '无关', en: 'irrelevant' },
  uncertain: { zh: '无法确定', en: 'uncertain' },
};

/** 最近问答条目（旧在前）：「问题」→ 判定。空数组不写入任何键。 */
function recentQaEntry(recentQas: RecentQa[] | undefined, language: Language): Record<string, unknown> {
  if (!recentQas?.length) return {};
  const items = recentQas.map(({ question, verdict }) =>
    language === 'en' ? `"${question}" -> ${verdictLabels[verdict][language]}` : `「${question}」→ ${verdictLabels[verdict][language]}`,
  );
  return language === 'en' ? { recentQAs: items } : { 历史问答: items };
}

export function askState(input: AskInput, language: Language): Record<string, unknown> {
  if (language === 'en') {
    return {
      story: input.surface,
      answer: input.answer,
      ...categoryEntry(input.category, language),
      ...(input.coreFacts?.length ? { coreFacts: input.coreFacts } : {}),
      ...recentQaEntry(input.recentQas, language),
      playerQuestion: input.question,
    };
  }
  return {
    汤面: input.surface,
    真相: input.answer,
    ...categoryEntry(input.category, language),
    ...(input.coreFacts?.length ? { 核心事实: input.coreFacts } : {}),
    ...recentQaEntry(input.recentQas, language),
    玩家提问: input.question,
  };
}

export function solveState(input: SolveInput, language: Language): Record<string, unknown> {
  if (language === 'en') {
    return {
      story: input.surface,
      answer: input.answer,
      ...categoryEntry(input.category, language),
      ...(input.coreFacts?.length ? { coreFacts: input.coreFacts } : {}),
      playerSolution: input.solution,
    };
  }
  return {
    汤面: input.surface,
    汤底: input.answer,
    ...categoryEntry(input.category, language),
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
