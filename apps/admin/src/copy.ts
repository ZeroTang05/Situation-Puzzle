/** 管理端文案：复用 @jev/i18n 的语言枚举与通用术语。 */
import { copy as webCopy, type Language } from '@jev/i18n';

export function copy(language: Language) {
  const w = webCopy[language];
  return {
    // resources / 列标题
    puzzleCol: language === 'zh' ? '标题' : 'Title',
    languageCol: w.language,
    versionCol: language === 'zh' ? '版号' : 'Version',
    statusCol: language === 'zh' ? '状态' : 'Status',
    disabledCol: language === 'zh' ? '已停用' : 'Disabled',
    rightsCol: language === 'zh' ? '授权' : 'Rights',
    upCol: language === 'zh' ? '赞' : 'Up',
    downCol: language === 'zh' ? '踩' : 'Down',
    nicknameCol: language === 'zh' ? '昵称' : 'Nickname',
    emailCol: 'Email',
    roomIdCol: language === 'zh' ? '房间' : 'Room',
    memberCol: language === 'zh' ? '成员' : 'Members',
    closeReasonCol: language === 'zh' ? '关闭原因' : 'Close reason',
    objectCol: language === 'zh' ? '对象' : 'Object',
    reasonCol: language === 'zh' ? '原因' : 'Reason',
    detailCol: language === 'zh' ? '详情' : 'Detail',
    orderIdCol: language === 'zh' ? '订单' : 'Order',
    amountCol: language === 'zh' ? '金额（分）' : 'Amount (minor)',
    channelCol: language === 'zh' ? '渠道' : 'Channel',

    // 资源菜单
    menuPuzzles: language === 'zh' ? '题库与投稿' : 'Puzzles & submissions',
    menuUsers: w.me,
    menuRooms: language === 'zh' ? '房间' : 'Rooms',
    menuReports: language === 'zh' ? '举报' : 'Reports',
    menuOrders: w.orders,
    menuOverview: language === 'zh' ? '总览' : 'Overview',
    dashboardTitle: language === 'zh' ? '运营总览' : 'Operations dashboard',

    // 列表操作
    suspend: language === 'zh' ? '停用' : 'Suspend',
    unsuspend: language === 'zh' ? '恢复' : 'Restore',
    testSponsor: w.testSponsor,
    forceClose: language === 'zh' ? '强制关闭' : 'Force close',
    markResolved: language === 'zh' ? '标记处理' : 'Mark resolved',
    reviewRefund: language === 'zh' ? '审核退款' : 'Review refund',
    approveLanguage: language === 'zh' ? '批准当前语言' : 'Approve this language',
    reject: language === 'zh' ? '退回' : 'Reject',
    takedown: language === 'zh' ? '下架' : 'Take down',
    approveAttribution: language === 'zh' ? '署名批准' : 'Approve attribution',
    rejectAttribution: language === 'zh' ? '署名拒绝' : 'Reject attribution',
    approveRights: language === 'zh' ? '批准授权' : 'Approve rights',
    rejectRights: language === 'zh' ? '拒绝授权' : 'Reject rights',
    approveAllLanguages: language === 'zh' ? '批准同版全部语言' : 'Approve all languages',

    // 列表 / 详情
    authorSignature: language === 'zh' ? '署名' : 'Signature',
    authorAnonymous: language === 'zh' ? '匿名' : 'Anonymous',
    authorPending: language === 'zh' ? '待审' : 'Pending review',
    authorBy: (name: string) => language === 'zh' ? `署名：${name}` : `By ${name}`,
    authorPendingSuffix: (name: string) => language === 'zh' ? `（待审：${name}）` : ` (pending: ${name})`,
    surfaceLabel: language === 'zh' ? '汤面' : 'Story',
    answerLabel: w.answer,
    sectionAuthorMaterials: language === 'zh' ? '审核材料' : 'Review materials',
    sectionReviews: language === 'zh' ? '检查与审核记录' : 'Check & review history',
    sectionRights: language === 'zh' ? '作品授权' : 'Rights',
    sectionSameRevision: language === 'zh' ? '同版语言审核' : 'Same-revision languages',
    rightsStatusLabel: language === 'zh' ? '状态' : 'Status',
    rightsBasisLabel: language === 'zh' ? '授权依据' : 'License basis',
    rightsViewSource: language === 'zh' ? '查看来源' : 'View source',
    rightsAgreementVersion: language === 'zh' ? '授权文本版本' : 'Agreement version',
    rightsAgreedAt: language === 'zh' ? '同意时间' : 'Agreed at',
    rightsNotAgreed: language === 'zh' ? '尚未同意' : 'Not yet agreed',
    testCaseExpected: language === 'zh' ? '预期判定' : 'Expected',
    testCaseCritical: language === 'zh' ? '关键用例' : 'Critical',
    testCaseNormal: language === 'zh' ? '普通用例' : 'Normal',

    // 通知 / 提示
    done: language === 'zh' ? '已完成' : 'Done',
    forceCloseDone: language === 'zh' ? '已关闭' : 'Closed',
    resolveDone: language === 'zh' ? '已处理' : 'Resolved',
    refundDone: language === 'zh' ? '已登记退款并冻结授权' : 'Refund queued, entitlement frozen',
    rightsSaved: language === 'zh' ? '授权审核已保存' : 'Rights decision saved',
    revisionApproved: language === 'zh' ? '同版全部语言已发布' : 'All languages of this revision published',
    promptReason: language === 'zh' ? '请输入操作理由' : 'Reason for this action',
    promptReasonSuspend: language === 'zh' ? '停用理由' : 'Reason to suspend',
    promptReasonUnsuspend: language === 'zh' ? '恢复理由' : 'Reason to restore',
    promptTestSponsor: language === 'zh' ? '发放几个月的测试赞助？' : 'How many months of test sponsorship?',
    promptForceClose: language === 'zh' ? '强制关闭理由' : 'Reason to force-close',
    promptResolve: language === 'zh' ? '处理结论' : 'Resolution note',
    promptRefund: language === 'zh' ? '退款理由' : 'Reason for refund',
    promptRights: language === 'zh' ? '请输入授权审核理由' : 'Reason for rights decision',
    promptRevision: language === 'zh' ? '请输入同版全部语言的审核理由' : 'Reason for cross-language approval',

    // 通用错误
    requestFailed: (status: number) => language === 'zh' ? `请求失败：${status}` : `Request failed: ${status}`,

    // 顶部语言切换
    switchTo: language === 'zh' ? 'EN' : '中文',
  };
}

export type AdminCopy = ReturnType<typeof copy>;