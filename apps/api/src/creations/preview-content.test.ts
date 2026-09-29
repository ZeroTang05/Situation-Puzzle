/** 内容摘要的真实计算：修改正文后，原试题凭证无法继续使用旧快照。 */
import { describe, expect, it } from 'vitest';
import { previewContentHash } from './preview-content.js';

describe('私人试题内容摘要', () => {
  const content = { title: '标题', surface: '汤面', answer: '汤底', hints: ['一', '二', '三'], coreFacts: ['事实'] };
  it('相同内容始终得到相同摘要', () => {
    expect(previewContentHash({ ...content })).toBe(previewContentHash(content));
  });
  it('正文、答案、提示和核心事实修改后都使摘要改变', () => {
    for (const change of [{ title: '新标题' }, { surface: '新汤面' }, { answer: '新汤底' }, { hints: ['新提示'] }, { coreFacts: ['新事实'] }]) {
      expect(previewContentHash({ ...content, ...change })).not.toBe(previewContentHash(content));
    }
  });
});
