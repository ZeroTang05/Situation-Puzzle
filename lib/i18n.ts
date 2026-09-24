/** 玩家界面的固定文案；题目正文另存在两份完整题库中。 */
export const copy = {
  zh: {
    brand: '海龟汤', next: '换一题', share: '分享给朋友', tagline: '一问一答，接近真相',
    solve: '还原真相', exitSolve: '退出还原', solveIntro: '写下你认为完整的故事，Jev 会对照汤底校验。可以多次提交，每次都会给出判断。',
    confidence: '置信度', solved: '破解成功', close: '接近真相', notYet: '还没猜对', uncertain: '无法确定',
    solvedDetail: '恭喜，你已经抓住这碗汤的核心真相。', closeDetail: '方向对了，再补齐关键原因。', notYetDetail: '漏了关键事实，换个思路再提交一次。', uncertainDetail: 'Jev 对这次判断没有足够把握，请换一种说法。',
    answer: '汤底', checking: 'Jev 正在校验…', hostIntro: '我是 Jev，这碗汤的主持人。大胆提问，我只回答「是、否、无关」。', judging: 'Jev 正在判断…',
    hint: '提示', reveal: '公布答案', askPlaceholder: '问问 Jev…', solvePlaceholder: '写下你还原的真相…', send: '发送',
    revealConfirm: '看到汤底这局就没悬念了，确定公布吗？', cancel: '取消', library: '题库', libraryIntro: '选一题，和朋友一起慢慢推理。', played: '已玩',
    progress: '我的答题记录', progressLoading: '正在读取答题记录…', completed: '已解出', attempted: '已尝试', total: '公开题目', progressEmpty: '还没有答题记录，去题库挑一碗汤吧。', questions: '提问', times: '次', recent: '最近判定',
    createTitle: '出一道海龟汤', createRemote: '提交后先审核，通过即可分享。', createLocal: '本地创建的题目仅在当前页面可用。', title: '题目名称', titleExample: '例如：消失的钥匙', story: '汤面', storyPlaceholder: '玩家最先看到的故事', answerField: '汤底', answerPlaceholder: '完整真相', hint1: '提示一', hint1Placeholder: '给卡住的玩家一点方向', hint2: '提示二（选填）', hint2Placeholder: '换个角度再给一条', hint3: '提示三（选填）', hint3Placeholder: '最后一条提示', reviewing: '审核中…', submitReview: '提交审核', createOffline: '本地创建', play: '游玩', records: '记录', create: '出题',
    questionFailed: '判断失败，稍后再试。', unsureReply: '这题我拿不准，换个问法试试。', shareUnavailable: '这道题只保存在当前页面，连接后端保存后才能分享。', shared: '分享链接已复制，发给朋友即可游玩。', answerFailed: '汤底获取失败，稍后再试。', createLocalNotice: '本地题目已创建，连接后端后才能公开。', reviewFailed: '审核暂时失败，题目没有公开，请稍后再试。', feedFailed: '公开题库加载失败，请刷新页面重试。', sharedMissing: '分享的题目不存在或已下架。', localMissing: '这道题尚未保存到题库，无法通过链接打开。', },
  en: {
    brand: 'Situation Puzzles', next: 'New puzzle', share: 'Share', tagline: 'One question at a time, uncover the truth',
    solve: 'Solve the mystery', exitSolve: 'Back to questions', solveIntro: 'Write out your full theory. Jev will compare it with the answer. You can try more than once.',
    confidence: 'Confidence', solved: 'Solved', close: 'Close', notYet: 'Not yet', uncertain: 'Uncertain',
    solvedDetail: 'You have uncovered the heart of the story.', closeDetail: 'You are on the right track. Find the missing link.', notYetDetail: 'A key fact is missing. Try another angle.', uncertainDetail: 'Jev is not confident enough. Try saying it another way.',
    answer: 'Answer', checking: 'Jev is checking…', hostIntro: 'I am Jev, your host. Ask anything—I will answer Yes, No or Irrelevant.', judging: 'Jev is thinking…',
    hint: 'Hint', reveal: 'Reveal answer', askPlaceholder: 'Ask Jev…', solvePlaceholder: 'Write your theory…', send: 'Send',
    revealConfirm: 'Revealing the answer ends the mystery. Continue?', cancel: 'Cancel', library: 'Library', libraryIntro: 'Pick a mystery and work through it together.', played: 'Played',
    progress: 'My progress', progressLoading: 'Loading progress…', completed: 'Solved', attempted: 'Attempted', total: 'Published puzzles', progressEmpty: 'No puzzles played yet. Choose one from the library.', questions: 'Questions', times: '', recent: 'Last result',
    createTitle: 'Create a puzzle', createRemote: 'Your puzzle is reviewed before it goes live.', createLocal: 'A local puzzle is only available on this page.', title: 'Title', titleExample: 'e.g. The Missing Key', story: 'Story', storyPlaceholder: 'What players see first', answerField: 'Answer', answerPlaceholder: 'The full explanation', hint1: 'First hint', hint1Placeholder: 'Give stuck players a direction', hint2: 'Second hint (optional)', hint2Placeholder: 'Offer another angle', hint3: 'Third hint (optional)', hint3Placeholder: 'One final clue', reviewing: 'Reviewing…', submitReview: 'Submit for review', createOffline: 'Create locally', play: 'Play', records: 'Progress', create: 'Create',
    questionFailed: 'Jev could not decide. Please try again later.', unsureReply: 'I am not sure. Try asking another way.', shareUnavailable: 'This puzzle exists only on this page. Save it online before sharing.', shared: 'Link copied. Send it to a friend!', answerFailed: 'Could not load the answer. Please try again.', createLocalNotice: 'Local puzzle created. Connect a backend to publish it.', reviewFailed: 'Review is temporarily unavailable. Your puzzle was not published.', feedFailed: 'Could not load the library. Please refresh.', sharedMissing: 'This shared puzzle is unavailable.', localMissing: 'This puzzle is not saved in the library.', },
} as const;

/** 历史记录保存的是判定原值，展示时按当前语言翻译。 */
export function displayOutcome(value: string | null, language: 'zh' | 'en'): string {
  if (!value) return '';
  const index = ['破解成功', '接近真相', '还没猜对', '无法确定', 'Solved', 'Close', 'Not yet', 'Uncertain'].indexOf(value);
  if (index < 0) return value;
  return [copy[language].solved, copy[language].close, copy[language].notYet, copy[language].uncertain][index % 4];
}
