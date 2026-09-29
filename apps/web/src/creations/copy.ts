/** 创作界面的中英文案，正文语言由作品单独选择。 */
const zh = {
  center: '创作中心', works: '我的作品', create: '写一碗汤', edit: '编辑作品', empty: '还没有作品，写下你的第一碗汤。',
  title: '标题', surface: '汤面', answer: '汤底', hint: '提示', language: '作品语言', difficulty: '难度', easy: '简单', medium: '适中', hard: '困难',
  story: '题目', truth: '答案与提示', materials: '审核材料', facts: '核心事实', factHelp: '每行一个事实，最多 10 条。', chain: '因果链',
  cases: '标准用例', caseHelp: '只提交这里填写的用例。私人试题对话保存在本浏览器。', addCase: '添加用例', remove: '删除', question: '问题或还原', expected: '预期判定', reason: '理由', critical: '关键事实用例',
  rights: '授权', licenseBasis: '原创或授权说明', sourceUrl: '来源或授权链接（可选）', attribution: '署名', anonymous: '匿名作者', signature: '署名', displayName: '展示名',
  save: '保存草稿', saving: '保存中…', submit: '提交审核', submitting: '提交中…', preview: '私人试题', withdraw: '撤回并编辑', revise: '创建新草稿',
  refresh: '重新载入', review: '审核反馈', noReviews: '还没有审核记录。', versions: '版本记录', saved: '草稿已保存', pendingName: '署名待审核', publishedName: '公开署名',
  cancel: '取消', leaveConfirm: '还有未保存的内容，确定离开？', withdrawConfirm: '撤回当前投稿并创建新草稿？', submitConfirm: '确认提交这些审核材料？提交后如需修改，可以撤回并创建新草稿。',
  login: '登录后创作', loading: '加载中…', public: '游玩已发布版本', feedback: '净支持', version: '版本', previewTitle: '私人试题', backEditor: '回到编辑',
  ask: '提问', solve: '还原真相', send: '发送', judging: 'Jev 正在判断…', placeholder: '向 Jev 提问', solvePlaceholder: '写下你的还原', failed: '判断失败', reset: '重新试题', reveal: '查看汤底', agreement: '提交前请确认授权声明',
} as const;
const en: Record<keyof typeof zh, string> = {
  center: 'Creation studio', works: 'My puzzles', create: 'Write a puzzle', edit: 'Edit puzzle', empty: 'No puzzles yet. Write your first story.',
  title: 'Title', surface: 'Story', answer: 'Answer', hint: 'Hint', language: 'Puzzle language', difficulty: 'Difficulty', easy: 'Easy', medium: 'Medium', hard: 'Hard',
  story: 'Puzzle', truth: 'Answer and hints', materials: 'Review materials', facts: 'Core facts', factHelp: 'One fact per line, up to 10.', chain: 'Causal chain',
  cases: 'Standard cases', caseHelp: 'Only these cases are submitted. Private test conversations stay in this browser.', addCase: 'Add case', remove: 'Remove', question: 'Question or solution', expected: 'Expected verdict', reason: 'Reason', critical: 'Critical fact',
  rights: 'Permissions', licenseBasis: 'Original work or permission statement', sourceUrl: 'Source or permission link (optional)', attribution: 'Authorship', anonymous: 'Anonymous author', signature: 'Named author', displayName: 'Display name',
  save: 'Save draft', saving: 'Saving…', submit: 'Submit for review', submitting: 'Submitting…', preview: 'Private test', withdraw: 'Withdraw and edit', revise: 'Create a new draft',
  refresh: 'Reload', review: 'Review feedback', noReviews: 'No review history yet.', versions: 'Version history', saved: 'Draft saved', pendingName: 'Name awaiting review', publishedName: 'Public name',
  cancel: 'Cancel', leaveConfirm: 'Leave with unsaved changes?', withdrawConfirm: 'Withdraw this submission and create a new draft?', submitConfirm: 'Submit these review materials? To edit later, withdraw and create a new draft.',
  login: 'Sign in to create', loading: 'Loading…', public: 'Play published version', feedback: 'Net votes', version: 'Version', previewTitle: 'Private test', backEditor: 'Back to editor',
  ask: 'Ask', solve: 'Solve', send: 'Send', judging: 'Jev is judging…', placeholder: 'Ask Jev a question', solvePlaceholder: 'Write your solution', failed: 'Judging failed', reset: 'Start a new test', reveal: 'Reveal answer', agreement: 'Confirm permission before submitting',
};
export const creationCopy = (language: 'zh' | 'en') => language === 'en' ? en : zh;

/** 作品和授权状态转换为用户能理解的文字。 */
export function creationStatusLabel(status: string, language: 'zh' | 'en'): string {
  if (status === 'check_failed') return language === 'en' ? 'Checks failed to run' : '自动检查服务失败';
  const labels: Record<string, [string, string]> = { draft: ['草稿', 'Draft'], submitted: ['等待自动检查', 'Waiting for checks'], checking: ['自动检查中', 'Checking'], pending_review: ['待人工审核', 'Awaiting review'], published: ['已发布', 'Published'], changes_requested: ['退回修改', 'Changes requested'], taken_down: ['已下架', 'Taken down'], pending: ['待审核', 'Pending'], approved: ['已通过', 'Approved'], rejected: ['未通过', 'Rejected'], withdrawn: ['已撤回', 'Withdrawn'], review_pass: ['自动检查通过', 'Checks passed'], review_reject: ['自动检查未通过', 'Checks failed'], review_uncertain: ['需人工复核', 'Human review needed'] };
  return labels[status]?.[language === 'zh' ? 0 : 1] ?? status;
}
