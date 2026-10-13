/** 判题路由规则：提问低置信度自动补判，还原按玩家开关选择模型。 */
import { judgeQuestionWithJev, solveWithJev, JEV_CONFIDENCE_THRESHOLD, type Language } from './jev';
import { judgeQuestionWithMiniMax, solveWithMiniMax, type MiniMaxConfig } from './minimax';

type JudgmentConfig = MiniMaxConfig & { OPENCODE_API_KEY?: string };

/** 从 Node 环境中显式读取模型配置，便于类型检查并避免携带无关变量。 */
export function judgmentConfigFromEnv(env: Record<string, string | undefined>): JudgmentConfig {
  return { OPENCODE_API_KEY: env.OPENCODE_API_KEY, MINIMAX_API_KEY: env.MINIMAX_API_KEY, MINIMAX_BASE_URL: env.MINIMAX_BASE_URL, MINIMAX_MODEL: env.MINIMAX_MODEL };
}

/** Jev 调用成功但置信度低时，等待 MiniMax 给出最终回答。 */
export async function judgeQuestion(config: JudgmentConfig, story: string, answer: string, question: string, threshold = JEV_CONFIDENCE_THRESHOLD, language: Language = 'zh') {
  const result = await judgeQuestionWithJev(config.OPENCODE_API_KEY ?? '', story, answer, question, threshold, language);
  if (result.confidence < threshold) return judgeQuestionWithMiniMax(config, story, answer, question, language);
  return { ...result, model: 'jev' as const };
}

/** 开关开启后直接用 MiniMax 比较完整还原，避免 Jev 的判定影响结果。 */
export async function solve(config: JudgmentConfig, story: string, answer: string, solution: string, useLargeModel: boolean, threshold = JEV_CONFIDENCE_THRESHOLD, language: Language = 'zh') {
  if (useLargeModel) return solveWithMiniMax(config, story, answer, solution, language);
  return { ...await solveWithJev(config.OPENCODE_API_KEY ?? '', story, answer, solution, threshold, language), model: 'jev' as const };
}
