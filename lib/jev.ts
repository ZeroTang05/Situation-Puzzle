/** Jev 的统一入口：集中处理模型连接、选择题结果和置信度。 */
// OpenCode Zen 的 SystemOne 接口：Jev 是「判题模型」，传 state 和带选项的问题，返回选项+概率
const SYSTEMONE_URL = 'https://opencode.ai/zen/v1/systemone';
const MODEL_ID = 'jev-1.13-free';
const MAX_RETRIES = 2;
export const JEV_CONFIDENCE_THRESHOLD = 0.4;
export type Language = 'zh' | 'en';

type ChoiceQuestion<T extends string> = {
  type: 'choice';
  instructions: string;
  criteria: Record<T, string>;
};

type JevChoice<T extends string> = { choice: T; confidence: number };

/** Jev 请求失败时最多额外重试两次；最后一次错误原样交给调用方。 */
async function choose<T extends string>(apiKey: string, state: Record<string, unknown>, questionName: string, question: ChoiceQuestion<T>): Promise<JevChoice<T>> {
  if (!apiKey) throw new Error('缺少 Jev API 密钥');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestChoice(apiKey, state, questionName, question);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      console.warn(`Jev ${questionName} 调用失败，准备第 ${attempt + 1} 次重试`, error);
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error('Jev 重试次数异常');
}

/** 单次模型请求：核对返回选项，确保后续业务只接收有效结果。 */
async function requestChoice<T extends string>(apiKey: string, state: Record<string, unknown>, questionName: string, question: ChoiceQuestion<T>): Promise<JevChoice<T>> {
  const response = await fetch(SYSTEMONE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL_ID, state, questions: { [questionName]: question } }),
  });
  if (!response.ok) throw new Error(`Jev 请求失败：${response.status}`);
  const result = await response.json() as { answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }> };
  const answer = result.answers?.[questionName];
  if (!answer?.choice || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Jev 返回无效选项：${answer?.choice ?? '空'}`);
  const confidence = answer.probabilities?.[answer.choice] ?? 0;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`Jev 返回无效置信度：${confidence}`);
  return { choice: answer.choice as T, confidence };
}

type SoupContent = { title: string; story: string; answer: string; hints: string[] };

/** 投稿时检查色情、政治内容；只有 Jev 明确给出“通过”才公开。 */
export async function reviewSoupWithJev(apiKey: string, soup: SoupContent, language: Language = 'zh'): Promise<boolean> {
  if (language === 'en') {
    const result = await choose(apiKey, { title: soup.title, story: soup.story, answer: soup.answer, hints: soup.hints }, 'review', {
      type: 'choice',
      instructions: 'Review this entire situation puzzle for sexual or political content. Consider every field. Ordinary suspense, death, crime and police investigations are allowed.',
      criteria: {
        Approved: 'Contains no sexual content or political figures, events, advocacy or policy disputes.',
        Rejected: 'Contains sexual descriptions or acts, or political figures, events, advocacy or policy disputes.',
      },
    });
    return result.choice === 'Approved';
  }
  const result = await choose(apiKey, { 标题: soup.title, 汤面: soup.story, 汤底: soup.answer, 提示: soup.hints }, 'review', {
    type: 'choice',
    instructions: '审核整道海龟汤是否适合公开。只检查色情或政治内容；标题、汤面、汤底和提示任一处涉及这两类内容，就选不通过。普通的悬疑、死亡、犯罪和警察办案不因此被判为政治内容。',
    criteria: {
      通过: '没有色情内容，也没有政治人物、政治事件、政治宣传或政策争议等政治内容。',
      不通过: '包含色情描写或性行为内容，或者包含政治人物、政治事件、政治宣传或政策争议等政治内容。',
    },
  });
  return result.choice === '通过';
}

/** 玩家提问的三选一判断；低于阈值时统一返回“无法确定”。 */
export async function judgeQuestionWithJev(apiKey: string, story: string, answer: string, question: string, threshold = JEV_CONFIDENCE_THRESHOLD, language: Language = 'zh') {
  if (language === 'en') {
    const result = await choose(apiKey, { story, answer, playerQuestion: question }, 'verdict', {
      type: 'choice',
      instructions: 'Judge the player question against the answer. Choose only Yes, No or Irrelevant.',
      criteria: {
        Yes: 'The answer supports the claim or a reasonable inference in the question.',
        No: 'The answer contradicts the claim or a reasonable inference in the question.',
        Irrelevant: 'The question has no material connection to the answer.',
      },
    });
    return { verdict: result.confidence >= threshold ? result.choice : 'Uncertain', confidence: result.confidence, threshold };
  }
  const result = await choose(apiKey, { 汤面: story, 真相: answer, 玩家提问: question }, 'verdict', {
    type: 'choice',
    instructions: '根据真相判断玩家提问，只能选择是、否、无关。',
    criteria: {
      是: '提问的事实或合理推论被真相支持。',
      否: '提问的事实或合理推论被真相否定。',
      无关: '提问和真相没有实质关系。',
    },
  });
  return { verdict: result.confidence >= threshold ? result.choice : '无法确定', confidence: result.confidence, threshold };
}

/** 玩家还原真相的三选一判断；低于阈值时统一返回“无法确定”。 */
export async function solveWithJev(apiKey: string, story: string, answer: string, solution: string, threshold = JEV_CONFIDENCE_THRESHOLD, language: Language = 'zh') {
  if (language === 'en') {
    const result = await choose(apiKey, { story, answer, playerSolution: solution }, 'outcome', {
      type: 'choice',
      instructions: "Compare the player's reconstruction with the answer. Focus on the core event, key reasons and causal chain. Exact wording is not required.",
      criteria: {
        Solved: 'The player covers the core event, key reasons and causal connections.',
        Close: 'The player has the main idea but misses a key reason or causal step.',
        'Not yet': 'The explanation conflicts with the central facts of the answer.',
      },
    });
    return { outcome: result.confidence >= threshold ? result.choice : 'Uncertain', confidence: result.confidence, threshold };
  }
  const result = await choose(apiKey, { 汤面: story, 汤底: answer, 玩家还原: solution }, 'outcome', {
    type: 'choice',
    instructions: '判断玩家是否还原了汤底的核心事件、关键原因和因果链。仅根据汤底判断，不要求逐字一致。',
    criteria: {
      破解成功: '玩家覆盖了汤底的核心事件、关键原因与因果关系。',
      接近真相: '玩家抓住了主要方向，但遗漏一个关键原因或因果环节。',
      还没猜对: '玩家的解释与汤底核心事实不一致。',
    },
  });
  return { outcome: result.confidence >= threshold ? result.choice : '无法确定', confidence: result.confidence, threshold };
}
