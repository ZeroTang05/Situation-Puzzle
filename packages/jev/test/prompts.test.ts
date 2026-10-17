/** askState 的历史问答注入：有则写入、空则不占键，判定标签按语言本地化。 */
import { describe, expect, it } from 'vitest';
import { askState, type RecentQa } from '../src/prompts.js';

const base = { title: '终点线', surface: '汤面', answer: '汤底', question: '他后悔了吗' };
const recentQas: RecentQa[] = [
  { question: '凶手是男人的兄弟吗', verdict: 'yes' },
  { question: '兄弟认识死者吗', verdict: 'irrelevant' },
];

describe('askState 历史问答', () => {
  it('zh：写入「历史问答」，判定用中文标签，顺序保持旧在前', () => {
    const state = askState({ ...base, recentQas }, 'zh');
    expect(state['历史问答']).toEqual(['「凶手是男人的兄弟吗」→ 是', '「兄弟认识死者吗」→ 无关']);
  });

  it('en：写入 recentQAs，判定用英文枚举', () => {
    const state = askState({ ...base, recentQas }, 'en');
    expect(state.recentQAs).toEqual(['"凶手是男人的兄弟吗" -> yes', '"兄弟认识死者吗" -> irrelevant']);
  });

  it('未提供或空数组时不写入对应键', () => {
    for (const recentQas of [undefined, []]) {
      expect('历史问答' in askState({ ...base, recentQas }, 'zh')).toBe(false);
      expect('recentQAs' in askState({ ...base, recentQas }, 'en')).toBe(false);
    }
  });
});
