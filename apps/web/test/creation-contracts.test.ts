/** 投稿只要求题目与来源，转载链接和版本条件由共享契约检查。 */
import { describe, expect, it } from 'vitest';
import { creationDraftSchema, creationCompleteSchema, creationSubmitRequestSchema } from '@jev/contracts';
const draft = { title: '邮差', surface: '', answer: '', hints: [], language: 'zh', difficulty: 'medium', category: 'honkaku', origin: 'original', sourceUrl: '', authorDisplay: { mode: 'anonymous' } };
const complete = { ...draft, surface: '邮差没有送信，却救了一条命。', answer: '他发现有人煤气中毒并报警。', hints: ['异常气味', '屋里有人', '煤气泄漏'] };
describe('简化投稿契约', () => {
  it('允许只保存标题，提交仍需完整题目和首条提示', () => {
    expect(creationDraftSchema.safeParse(draft).success).toBe(true);
    expect(creationCompleteSchema.safeParse(draft).success).toBe(false);
    expect(creationCompleteSchema.safeParse({ ...complete, hints: [] }).success).toBe(false);
    expect(creationCompleteSchema.safeParse({ ...complete, hints: [' '] }).success).toBe(false);
  });
  it('自制无需链接、协议或审核补充材料', () => {
    expect(creationCompleteSchema.parse(complete)).toEqual(complete);
    const condition = { expectedVersionId: crypto.randomUUID(), expectedUpdatedAt: new Date().toISOString() };
    expect(creationSubmitRequestSchema.parse(condition)).toEqual(condition);
    expect(creationSubmitRequestSchema.safeParse({}).success).toBe(false);
  });
  it('转载可先保存草稿，提交必须填写原作者网页链接', () => {
    expect(creationDraftSchema.safeParse({ ...draft, origin: 'repost' }).success).toBe(true);
    expect(creationCompleteSchema.safeParse({ ...complete, origin: 'repost' }).success).toBe(false);
    expect(creationCompleteSchema.safeParse({ ...complete, origin: 'repost', sourceUrl: 'https://example.com/author/story' }).success).toBe(true);
    for (const sourceUrl of ['javascript:alert(1)', 'ftp://example.com/story']) expect(creationCompleteSchema.safeParse({ ...complete, origin: 'repost', sourceUrl }).success).toBe(false);
  });
  it('来源类型、类别和署名必须有效', () => {
    expect(creationDraftSchema.safeParse({ ...draft, origin: 'other' }).success).toBe(false);
    expect(creationDraftSchema.safeParse({ ...draft, category: 'mystery' }).success).toBe(false);
    expect(creationDraftSchema.safeParse({ ...draft, authorDisplay: { mode: 'signature', name: ' ' } }).success).toBe(false);
  });
});
