/** 创作界面的中英文案，正文语言由作品单独选择。 */
import { copy, type Language } from '@jev/i18n';

/** 创作专属文案：从全局 copy 中按 key 抽取；不在 copy 中的作品状态、署名展示另行提供。 */
export function creationCopy(language: Language) {
  return {
    center: copy[language].creationCenter,
    works: copy[language].myWorks,
    create: copy[language].createNew,
    edit: copy[language].editWork,
    empty: copy[language].creationEmpty,
    title: copy[language].titleField,
    surface: copy[language].surfaceField,
    answer: copy[language].answerField,
    hint: copy[language].hintField,
    language: copy[language].languageField,
    difficulty: copy[language].difficultyField,
    easy: copy[language].easy,
    medium: copy[language].medium,
    hard: copy[language].hard,
    story: copy[language].storyField,
    truth: copy[language].truthField,
    origin: language === 'zh' ? '题目来源' : 'Puzzle origin',
    original: language === 'zh' ? '自制' : 'Original',
    repost: language === 'zh' ? '转载' : 'Repost',
    facts: copy[language].factsField,
    factHelp: copy[language].factHelp,
    chain: copy[language].chainField,
    cases: copy[language].casesField,
    caseHelp: copy[language].caseHelp,
    addCase: copy[language].addCase,
    remove: copy[language].removeCase,
    question: copy[language].questionField,
    expected: copy[language].expectedField,
    reason: copy[language].reasonField,
    critical: copy[language].criticalField,
    rights: copy[language].rightsField,
    licenseBasis: copy[language].licenseBasisField,
    sourceUrl: language === 'zh' ? '原作者链接' : 'Original author link',
    attribution: copy[language].attributionField,
    anonymous: copy[language].anonymousAuthorOption,
    signature: copy[language].signatureAuthor,
    displayName: copy[language].displayNameField,
    save: copy[language].saveDraft,
    saving: copy[language].saving,
    submit: copy[language].submitForReview,
    submitting: copy[language].submittingForReview,
    preview: copy[language].privateTest,
    withdraw: copy[language].withdrawEdit,
    revise: copy[language].reviseWork,
    refresh: copy[language].reload,
    review: copy[language].reviewField,
    noReviews: copy[language].noReviews,
    versions: copy[language].versionsField,
    saved: copy[language].draftSavedToast,
    pendingName: copy[language].pendingNameField,
    publishedName: copy[language].publicNameField,
    cancel: copy[language].cancelButton,
    leaveConfirm: copy[language].leaveConfirm,
    withdrawConfirm: copy[language].withdrawConfirm,
    submitConfirm: copy[language].submitConfirm,
    login: copy[language].loginToCreate,
    loading: copy[language].loadingField,
    public: copy[language].playPublished,
    feedback: copy[language].feedbackField,
    version: copy[language].versionField,
    previewTitle: copy[language].previewTitle,
    backEditor: copy[language].backEditor,
    /** 字段级校验错误文案：按字段直接显示 */
    requiredField: language === 'zh' ? '不能为空' : 'Required',
    tooLongField: (label: string) => language === 'zh' ? `${label}过长` : `${label} is too long`,
    invalidUrlField: language === 'zh' ? '请填写正确的网址' : 'Please enter a valid URL',
    requiredRepostUrl: language === 'zh' ? '转载作品请填写原作者链接' : 'Repost needs original author link',
    invalidDisplayName: language === 'zh' ? '展示名不能为空' : 'Display name required',
    ask: copy[language].askShort,
    solve: copy[language].solveShort,
    send: copy[language].sendShort,
    judging: copy[language].judgingShort,
    placeholder: copy[language].placeholderShort,
    solvePlaceholder: copy[language].solvePlaceholderShort,
    failed: copy[language].failedShort,
    reset: copy[language].resetTest,
    reveal: copy[language].revealShort,
    agreement: copy[language].confirmPermission,
  };
}

/** 作品状态枚举 → 用户能理解的文案。 */
export function creationStatusLabel(status: string, language: Language): string {
  const c = copy[language];
  switch (status) {
    case 'check_failed': return c.workStatusCheckFailed;
    case 'draft': return c.workStatusDraft;
    case 'submitted': return c.workStatusSubmitted;
    case 'checking': return c.workStatusChecking;
    case 'pending_review': return c.workStatusPendingReview;
    case 'published': return c.workStatusPublished;
    case 'changes_requested': return c.workStatusChangesRequested;
    case 'taken_down': return c.workStatusTakenDown;
    case 'withdrawn': return c.workStatusWithdrawn;
    case 'review_pass': return c.workStatusReviewPass;
    case 'review_reject': return c.workStatusReviewReject;
    case 'review_uncertain': return c.workStatusReviewUncertain;
    // 商业授权状态（独立于审核状态）
    case 'pending': return c.rightsStatusPending;
    case 'approved': return c.rightsStatusApproved;
    case 'rejected': return c.rightsStatusRejected;
    default: return status;
  }
}