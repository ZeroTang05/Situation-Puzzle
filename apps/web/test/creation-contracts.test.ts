/** 使用真实共享契约检查草稿、投稿材料和明确授权的边界。 */
import { describe, expect, it } from 'vitest';
import { creationDraftSchema, creationCompleteSchema, creationSubmitRequestSchema, creationTestCaseSchema, creationLicenseVersion } from '@jev/contracts';

const draft = { title: '邮差', surface: '', answer: '', hints: [], language: 'zh', difficulty: 'medium', licenseBasis: '', sourceUrl: '', coreFacts: [], causalChain: '', testCases: [], authorDisplay: { mode: 'anonymous' } };
const complete = { ...draft, surface: '邮差每天送信。今天他没有送信，却救了一条命。', answer: '他发现有人煤气中毒并立即报警。', hints: ['异常气味', '屋里有人', '煤气泄漏'], coreFacts: ['邮差发现煤气泄漏'], causalChain: '闻到煤气→发现昏迷者→报警救人', licenseBasis: '本人原创', testCases: [{ kind: 'ask', input: '有人煤气中毒吗？', expected: 'yes', criticality: 'critical', reason: '核心事实' }] };

describe('作者投稿契约', () => {
  it('允许保存只有标题的草稿，同时拒绝将其直接投稿', () => {
    expect(creationDraftSchema.safeParse(draft).success).toBe(true);
    expect(creationCompleteSchema.safeParse(draft).success).toBe(false);
  });
  it('完整稿件包含事实、因果链、三条提示与标准用例', () => {
    expect(creationCompleteSchema.safeParse(complete).success).toBe(true);
    for (const change of [{ hints: ['提示'] }, { coreFacts: [] }, { causalChain: '' }, { testCases: [] }, { licenseBasis: '' }]) {
      expect(creationCompleteSchema.safeParse({ ...complete, ...change }).success).toBe(false);
    }
  });
  it('提交必须明确同意当前授权文本并携带保存版本条件', () => {
    const request = { expectedVersionId: crypto.randomUUID(), expectedUpdatedAt: new Date().toISOString(), agreementAccepted: true, agreementVersion: creationLicenseVersion };
    expect(creationSubmitRequestSchema.safeParse(request).success).toBe(true);
    expect(creationSubmitRequestSchema.safeParse({ ...request, agreementAccepted: false }).success).toBe(false);
    expect(creationSubmitRequestSchema.safeParse({ ...request, agreementVersion: 'old' }).success).toBe(false);
    expect(creationSubmitRequestSchema.safeParse({ agreementAccepted: true, agreementVersion: creationLicenseVersion }).success).toBe(false);
  });
  it('提问和还原只能选择各自的判定类型', () => {
    expect(creationTestCaseSchema.safeParse({ kind: 'ask', input: '问题', expected: 'solved' }).success).toBe(false);
    expect(creationTestCaseSchema.safeParse({ kind: 'solve', input: '还原', expected: 'yes' }).success).toBe(false);
    expect(creationTestCaseSchema.safeParse({ kind: 'ask', input: '问'.repeat(501), expected: 'yes' }).success).toBe(false);
  });
  it('来源链接只允许网页地址，署名必须填写展示名', () => {
    expect(creationDraftSchema.safeParse({ ...draft, sourceUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(creationDraftSchema.safeParse({ ...draft, authorDisplay: { mode: 'signature', name: ' ' } }).success).toBe(false);
  });
});
