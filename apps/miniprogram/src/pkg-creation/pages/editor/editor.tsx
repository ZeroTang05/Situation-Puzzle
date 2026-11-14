/**
 * 创作编辑页（代码级对齐 apps/web/src/creations/creation-editor-page.tsx）：
 * 无 id 参数 = 新建，?id=<puzzleId> = 编辑。分次保存草稿、提交 Jev 初审、
 * 撤回 / 重新编辑、版本与审核反馈展示，全部照搬 web。
 * 小程序差异：
 * - 长文本（汤面/汤底/提示）用 Textarea 且 maxlength={-1} 解除默认 140 字限制；
 * - 新建保存成功后 Taro.redirectTo 带 id 的编辑页（对齐 web navigate replace），
 *   行内提示会被页面重建吞掉，改用原生 toast 跨页面提示「已保存」；
 * - 校验失败自动滚动定位用 Taro.pageScrollTo(selector)（web 是 scrollIntoView + focus）；
 * - 未登录显示登录引导卡（等价 web Navigate(/login?next=…)，登录返回后自动加载）。
 */
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import { Button, Input, Text, Textarea, View } from '@tarojs/components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  creationCompleteSchema,
  creationDraftSchema,
  creationDetailSchema,
  type CreationDetail,
  type CreationDraft,
} from '@jev/contracts'
import { api } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession, type Session } from '../../../state/session'
import { goBack } from '../../../ui/back'
import { LoginPrompt } from '../../../ui/login-prompt'
import { formatDateTime } from '../../../ui/dates'
import { DialogHost, useDialog } from '../../../ui/dialog'
import { creationCopy, creationStatusLabel } from '../../copy'
import '../../creation.css'

/** 新稿只要求标题，正文可分次保存 */
function emptyDraft(language: 'zh' | 'en'): CreationDraft {
  return { title: '', surface: '', answer: '', hints: ['', '', ''], language, difficulty: 'medium', category: 'honkaku', origin: 'original', sourceUrl: '', authorDisplay: { mode: 'anonymous' } };
}

/** 把 hints 补齐到 3 项以便稳定渲染；服务端读取时只有非空条目会被保留 */
function padHints(hints: string[]): string[] {
  return [0, 1, 2].map((i) => hints[i] ?? '');
}

/** 字段错误：按 zod path 索引的字符串映射，未出现即无错 */
type FieldErrors = Partial<Record<string, string>>;

/** 把 zod 的 issues 转成字段错误 path → 用户可读文案。issues.path 形如 ['title']、['hints', 0] */
function mapIssuesToFields(issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message?: string }>, draft: CreationDraft, t: ReturnType<typeof creationCopy>): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.map((p) => String(p)).join('.');
    if (out[path]) continue;
    if (path === 'title') out.title = t.requiredField;
    else if (path === 'surface') out.surface = t.requiredField;
    else if (path === 'answer') out.answer = t.requiredField;
    else if (path === 'hints.0') out['hints.0'] = t.requiredField;
    else if (path === 'hints.1') out['hints.1'] = t.requiredField;
    else if (path === 'hints.2') out['hints.2'] = t.requiredField;
    else if (path === 'sourceUrl') {
      out.sourceUrl = draft.origin === 'repost' && !draft.sourceUrl ? t.requiredRepostUrl : t.invalidUrlField;
    } else if (path === 'authorDisplay.name') out['authorDisplay.name'] = t.invalidDisplayName;
  }
  return out;
}

/** 按视觉顺序排列的字段 id：用于首个错误自动滚动定位 */
const FIELD_ORDER = ['title', 'language', 'difficulty', 'category', 'surface', 'answer', 'hints.0', 'hints.1', 'hints.2', 'origin', 'sourceUrl', 'attribution', 'authorDisplay.name'] as const;

/** 审核结论 → 颜色：通过绿、驳回红、存疑金，其余用默认墨色 */
function reviewConclusionClass(conclusion: string) {
  switch (conclusion) {
    case 'review_pass': return 'is-pass';
    case 'review_reject': return 'is-reject';
    case 'review_uncertain': return 'is-uncertain';
    default: return '';
  }
}

export default function CreationEditor(): ReactNode {
  const router = useRouter();
  const puzzleId = router.params.id ?? '';
  const { language, copy } = useLanguage();
  const text = creationCopy(language);
  const { session, isPending } = useJevSession();
  const query = useQuery({
    queryKey: ['creation', session?.user.id, puzzleId],
    enabled: !!session && !!puzzleId,
    queryFn: async () => creationDetailSchema.parse(await api(`/creations/${puzzleId}`)),
    retry: false,
    refetchInterval: (q) => (['submitted', 'checking', 'pending_review'].includes((q.state.data as CreationDetail | undefined)?.status ?? '') ? 5000 : false),
  });

  // 未登录：web 端 replace 到 /login?next=…；小程序显示引导卡，登录返回后 onShow 自动重拉
  if (isPending && !session) return <View className="page"><View className="page-loading">{text.loading}</View></View>;
  if (!session) {
    return (
      <View className="page">
        <View className="topbar topbar-title">
          <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack('/pkg-creation/pages/list/list')}>{copy.back}</Button>
          <Text className="brand brand-sm creation-title">{text.create}</Text>
        </View>
        <LoginPrompt text={text.login} />
      </View>
    );
  }
  if (puzzleId && query.isPending) return <View className="page page-loading">{text.loading}</View>;
  if (puzzleId && query.error) {
    return (
      <View className="page">
        <Button className="btn" onClick={() => goBack('/pkg-creation/pages/list/list')}>{text.works}</Button>
        <Text className="error-text">{query.error.message}</Text>
      </View>
    );
  }
  // key 对齐 web：versionId:updatedAt:status 变化即重挂表单（轮询刷状态时不重挂，除非状态翻转）
  return <Editor key={query.data ? `${query.data.versionId}:${query.data.updatedAt}:${query.data.status}` : 'new'} session={session} detail={query.data} />;
}

/** 表单与已保存版本分开，后台状态刷新只发生在只读审核阶段 */
function Editor({ session, detail }: { session: Session; detail: CreationDetail | undefined }): ReactNode {
  const dialog = useDialog();
  const { language, copy } = useLanguage();
  const text = creationCopy(language);
  const client = useQueryClient();
  const [draft, setDraft] = useState<CreationDraft>(detail ? { ...detail.draft, hints: padHints(detail.draft.hints) } : emptyDraft(language));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savedVersion = useRef(detail);
  const editable = !detail || detail.status === 'draft';

  // web 用 useBeforeUnload 拦截脏表单离开；小程序页面卸载不可拦截，
  // 只能在返回按钮上确认；导航栏标题跟随作品标题（web document.title 同语义）
  useEffect(() => {
    void Taro.setNavigationBarTitle({ title: detail ? `${text.edit} · ${draft.title}` : text.create });
  }, [draft.title, detail, text.create, text.edit]);

  const change = <K extends keyof CreationDraft>(key: K, value: CreationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setNotice(null);
    // 编辑即清掉自身字段的报错，避免错误一直挂着不消失
    setFieldErrors((prev) => {
      const path = key as string;
      if (!prev[path] && !prev[`${path}.name`]) return prev;
      const next = { ...prev };
      delete next[path];
      delete next[`${path}.name`];
      return next;
    });
  };

  /** 单独清掉某个字段的报错（hints 输入等 change 之外的场景） */
  const clearField = (path: string) =>
    setFieldErrors((prev) => {
      if (!prev[path]) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });

  /** 提示等嵌套字段的 change：按索引整体替换 hints 数组 */
  const changeHint = (index: number, value: string) => {
    change('hints', [0, 1, 2].map((i) => (i === index ? value : draft.hints[i] ?? '')));
    clearField(`hints.${index}`);
  };

  const body = draft;
  const condition = detail ? { expectedVersionId: detail.versionId, expectedUpdatedAt: detail.updatedAt } : null;

  /** 把错误定位到第一个出错字段（按视觉顺序）；滚动锚点 id 把 `hints.0` 这类点号换成连字符（微信 selector 不认点号） */
  const focusFirstError = (errors: FieldErrors) => {
    const first = FIELD_ORDER.find((id) => errors[id]);
    if (!first) return;
    const anchor = first.replace(/\./g, '-');
    void Taro.pageScrollTo({ selector: `#${anchor}`, duration: 300 }).catch(() => undefined);
  };

  /** 保存成功后读取服务器版本条件，后续提交使用这次保存的版本 */
  const persist = async (): Promise<{ saved: CreationDetail; wasNew: boolean }> => {
    const parsed = creationDraftSchema.safeParse({ ...body, hints: body.hints.map((h) => h.trim()).filter(Boolean) });
    if (!parsed.success) {
      const fields = mapIssuesToFields(parsed.error.issues, draft, text);
      setFieldErrors(fields);
      focusFirstError(fields);
      throw new Error('字段未通过校验');
    }
    const wasNew = !savedVersion.current?.puzzleId;
    let puzzleId = savedVersion.current?.puzzleId;
    if (puzzleId) {
      await api(`/creations/${puzzleId}`, {
        method: 'PATCH',
        body: { ...parsed.data, expectedVersionId: savedVersion.current!.versionId, expectedUpdatedAt: savedVersion.current!.updatedAt },
      });
    } else {
      puzzleId = (await api<{ puzzleId: string }>('/creations', { method: 'POST', body: parsed.data })).puzzleId;
    }
    const saved = creationDetailSchema.parse(await api(`/creations/${puzzleId}`));
    savedVersion.current = saved;
    return { saved, wasNew };
  };

  /** 提交/撤回成功后刷新列表与详情缓存，并替换当前页为带 id 的编辑页（web navigate replace 同语义） */
  const refresh = async (puzzleId: string) => {
    await client.invalidateQueries({ queryKey: ['creations', session.user.id] });
    await client.invalidateQueries({ queryKey: ['creation', session.user.id, puzzleId] });
    void Taro.redirectTo({ url: `/pkg-creation/pages/editor/editor?id=${puzzleId}` });
  };

  const save = async () => {
    setBusy(true);
    setFieldErrors({});
    setSubmitError(null);
    try {
      const { saved, wasNew } = await persist();
      setDirty(false);
      client.setQueryData(['creation', session.user.id, saved.puzzleId], saved);
      if (wasNew) {
        // 新建保存成功后 redirectTo 带 id 的编辑页；行内提示随页面重建丢失，改用原生 toast
        Taro.showToast({ title: text.saved, icon: 'none' });
        void Taro.redirectTo({ url: `/pkg-creation/pages/editor/editor?id=${saved.puzzleId}` });
      } else {
        setNotice(text.saved);
      }
      await client.invalidateQueries({ queryKey: ['creations', session.user.id] });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '字段未通过校验') setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const parsed = creationCompleteSchema.safeParse(body);
    if (!parsed.success) {
      const fields = mapIssuesToFields(parsed.error.issues, draft, text);
      setFieldErrors(fields);
      focusFirstError(fields);
      return;
    }
    if (!(await dialog.confirm(text.submitConfirm, text.submit))) return;
    setBusy(true);
    setFieldErrors({});
    setSubmitError(null);
    try {
      const { saved } = await persist();
      setDirty(false);
      // 提交失败时保留表单与保存后的版本条件，避免重复创建作品
      await api(`/creations/${saved.puzzleId}/submit`, { method: 'POST', body: { expectedVersionId: saved.versionId, expectedUpdatedAt: saved.updatedAt } });
      await refresh(saved.puzzleId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '字段未通过校验') setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const revise = async (action: 'revise' | 'withdraw') => {
    if (!detail) return;
    if (action === 'withdraw' && !(await dialog.confirm(text.withdrawConfirm, text.withdraw))) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await api(`/creations/${detail.puzzleId}/${action}`, { method: 'POST', body: condition });
      await refresh(detail.puzzleId);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  /** 先保存并同步编辑页缓存，再进入私人试题；返回时栈上一页就是带 id 的编辑页 */
  const preview = async () => {
    setBusy(true);
    setFieldErrors({});
    setSubmitError(null);
    try {
      const { saved, wasNew } = editable ? await persist() : { saved: detail!, wasNew: false };
      setDirty(false);
      client.setQueryData(['creation', session.user.id, saved.puzzleId], saved);
      await client.invalidateQueries({ queryKey: ['creations', session.user.id] });
      // 新建场景先 redirectTo 到带 id 的编辑页（web navigate replace 同语义），再入栈预览页
      if (wasNew) await Taro.redirectTo({ url: `/pkg-creation/pages/editor/editor?id=${saved.puzzleId}` });
      await Taro.navigateTo({ url: `/pkg-creation/pages/preview/preview?id=${saved.puzzleId}` });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '字段未通过校验') setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  /** 离开前脏表单二次确认（web useBeforeUnload + 返回按钮确认中可拦截的部分） */
  const leaveEditor = async () => {
    if (!dirty || (await dialog.confirm(text.leaveConfirm, text.backEditor))) goBack('/pkg-creation/pages/list/list');
  };

  const controlDisabled = !editable || busy;

  return (
    <View className="page creation-shell">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => void leaveEditor()}>{copy.back}</Button>
        <Text className="brand brand-sm creation-title">{detail ? text.edit : text.create}</Text>
        {detail ? (
          <View className="topbar-tail creation-topbar-meta">
            <Text className="creation-version-badge">v{detail.versionNo}</Text>
            <Text className={`creation-status status-${detail.status}`}>{creationStatusLabel(detail.status, language)}</Text>
          </View>
        ) : (
          <View className="topbar-tail" />
        )}
      </View>

      <View className="creation-editor">
        <View className="creation-section">
          <Text className="creation-section-h2">{text.story}</Text>
          <View id="title">
            <Field label={text.title} required error={fieldErrors.title}>
              <Input className="field" maxlength={60} value={draft.title} disabled={controlDisabled} onInput={(e) => change('title', e.detail.value)} />
            </Field>
          </View>
          <View className="creation-fields">
            <View id="language">
              <Field label={text.language}>
                <Segmented value={draft.language} options={[{ value: 'zh', label: copy.languageZh }, { value: 'en', label: copy.languageEn }]} onChange={(value) => change('language', value as 'zh' | 'en')} />
              </Field>
            </View>
            <View id="difficulty">
              <Field label={text.difficulty}>
                <Segmented value={draft.difficulty} options={[{ value: 'easy', label: text.easy }, { value: 'medium', label: text.medium }, { value: 'hard', label: text.hard }]} onChange={(value) => change('difficulty', value as CreationDraft['difficulty'])} />
              </Field>
            </View>
            <View id="category">
              <Field label={text.category}>
                <Segmented value={draft.category} options={[{ value: 'honkaku', label: text.honkaku }, { value: 'henkaku', label: text.henkaku }]} onChange={(value) => change('category', value as CreationDraft['category'])} />
              </Field>
            </View>
          </View>
          <View id="surface">
            <Field label={text.surface} required error={fieldErrors.surface}>
              {/* 长文本：maxlength={-1} 解除小程序默认 140 字限制，固定高度框内滚动 */}
              <Textarea className="field creation-textarea-surface" maxlength={-1} value={draft.surface} disabled={controlDisabled} onInput={(e) => change('surface', e.detail.value)} />
            </Field>
          </View>
        </View>

        <View className="creation-section">
          <Text className="creation-section-h2">{text.truth}</Text>
          <View id="answer">
            <Field label={text.answer} required error={fieldErrors.answer}>
              <Textarea className="field creation-textarea-answer" maxlength={-1} value={draft.answer} disabled={controlDisabled} onInput={(e) => change('answer', e.detail.value)} />
            </Field>
          </View>
          {[0, 1, 2].map((index) => (
            <View key={index} id={`hints-${index}`}>
              <Field
                label={`${text.hint} ${index + 1}${index === 0 ? (language === 'zh' ? '（必填）' : ' (required)') : language === 'zh' ? '（可选）' : ' (optional)'}`}
                required={index === 0}
                error={fieldErrors[`hints.${index}`]}
              >
                <Textarea className="field field-hint" maxlength={-1} autoHeight value={draft.hints[index] ?? ''} disabled={controlDisabled} onInput={(e) => changeHint(index, e.detail.value)} />
              </Field>
            </View>
          ))}
        </View>

        <View className="creation-section">
          <Text className="creation-section-h2">{text.origin}</Text>
          <View id="origin">
            <Field label={text.origin}>
              <Segmented
                value={draft.origin}
                options={[{ value: 'original', label: text.original }, { value: 'repost', label: text.repost }]}
                onChange={(value) => {
                  change('origin', value as CreationDraft['origin']);
                  if (value === 'original') change('sourceUrl', '');
                }}
              />
            </Field>
          </View>
          {draft.origin === 'repost' && (
            <View id="sourceUrl">
              <Field label={text.sourceUrl} required error={fieldErrors.sourceUrl}>
                <Input className="field" maxlength={-1} value={draft.sourceUrl} disabled={controlDisabled} onInput={(e) => change('sourceUrl', e.detail.value)} />
              </Field>
            </View>
          )}
          <View id="attribution">
            <Field label={text.attribution}>
              <Segmented
                value={draft.authorDisplay.mode}
                options={[{ value: 'anonymous', label: text.anonymous }, { value: 'signature', label: text.signature }]}
                onChange={(value) => change('authorDisplay', value === 'anonymous' ? { mode: 'anonymous' } : { mode: 'signature', name: session.user.name })}
              />
            </Field>
          </View>
          {draft.authorDisplay.mode === 'signature' && (
            <View id="authorDisplay-name">
              <Field label={text.displayName} required error={fieldErrors['authorDisplay.name']}>
                <Input className="field" maxlength={30} value={draft.authorDisplay.name} disabled={controlDisabled} onInput={(e) => change('authorDisplay', { mode: 'signature', name: e.detail.value })} />
              </Field>
            </View>
          )}
          {/* 署名现状跟署名字段放在一起：已生效的展示名 + 待审核的改名 */}
          {(detail?.authorDisplay.name || detail?.authorDisplay.pendingName) && (
            <View className="creation-attribution-note">
              {detail?.authorDisplay.name && (
                <Text className="muted">
                  {text.publishedName}
                  {language === 'zh' ? '：' : ': '}
                  {detail.authorDisplay.name}
                </Text>
              )}
              {detail?.authorDisplay.pendingName && (
                <Text className="creation-item-pending">
                  {text.pendingName}
                  {language === 'zh' ? '：' : ': '}
                  {detail.authorDisplay.pendingName}
                </Text>
              )}
            </View>
          )}
        </View>

        {submitError && <Text className="error-text creation-error">{submitError}</Text>}
        {notice && <Text className="accent">{notice}</Text>}

        <View className="creation-actions">
          {editable && (
            <>
              <Button className="btn creation-action-btn" disabled={busy} onClick={() => void save()}>{busy ? text.saving : text.save}</Button>
              <Button className="btn btn-primary creation-action-btn" disabled={busy} onClick={() => void submit()}>{text.submit}</Button>
            </>
          )}
          <Button className="btn btn-ghost creation-action-btn" disabled={busy} onClick={() => void preview()}>{text.preview}</Button>
          {detail && ['submitted', 'checking', 'pending_review'].includes(detail.status) && (
            <Button className="btn creation-action-btn" disabled={busy} onClick={() => void revise('withdraw')}>{text.withdraw}</Button>
          )}
          {detail && ['changes_requested', 'published', 'taken_down'].includes(detail.status) && (
            <Button className="btn btn-primary creation-action-btn" disabled={busy} onClick={() => void revise('revise')}>{text.revise}</Button>
          )}
        </View>
      </View>

      {detail && (
        <View className="creation-section">
          <View className="creation-section-head">
            <Text className="creation-section-head-title">{text.review}</Text>
            <Button
              className="btn btn-sm btn-ghost creation-section-refresh"
              disabled={busy}
              onClick={async () => {
                if (!dirty || (await dialog.confirm(text.leaveConfirm))) void client.invalidateQueries({ queryKey: ['creation', session.user.id, detail.puzzleId] });
              }}
            >
              {text.refresh}
            </Button>
          </View>
          {detail.reviews.length === 0 && <Text className="muted creation-review-empty">{text.noReviews}</Text>}
          {detail.reviews.map((review, index) => (
            <View className="creation-review" key={`${review.versionId}:${index}`}>
              <View className="creation-review-head">
                <Text className={`creation-review-conclusion ${reviewConclusionClass(review.conclusion)}`}>{creationStatusLabel(review.conclusion, language)}</Text>
                <Text className="muted creation-review-time">{formatDateTime(review.createdAt, language)}</Text>
              </View>
              {review.reason && <Text className="creation-review-reason">{review.reason}</Text>}
            </View>
          ))}
          <Text className="creation-versions-title">{text.versions}</Text>
          <View className="creation-versions">
            {detail.versions.map((version) => (
              <View className="creation-versions-row" key={version.versionId}>
                <Text className="creation-versions-no">v{version.versionNo}</Text>
                <Text className={`creation-status status-sm status-${version.status}`}>{creationStatusLabel(version.status, language)}</Text>
                <Text className="creation-versions-lang muted">{version.language === 'zh' ? copy.languageZh : copy.languageEn}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
      <DialogHost />
    </View>
  );
}

/** 字段容器：标签 + 控件 + 字段级错误（web 用后代选择器染红控件，WXSS 不支持，改为克隆控件注入 field-invalid 类） */
function Field({ label, required, error, children }: { label: string; required?: boolean; error?: string | undefined; children: ReactNode }) {
  let control = children;
  if (error && React.isValidElement(children)) {
    const element = children as React.ReactElement<{ className?: string }>;
    const className = element.props.className ?? '';
    if (!className.includes('field-invalid')) {
      control = React.cloneElement(element, { className: className ? `${className} field-invalid` : 'field-invalid' });
    }
  }
  return (
    <View className={`field-label creation-field${error ? ' creation-field-invalid' : ''}`}>
      <Text>
        {label}
        {required && <Text className="creation-required"> *</Text>}
      </Text>
      {control}
      {error && <Text className="creation-field-error">{error}</Text>}
    </View>
  );
}

/** 分段按钮组：web 同款（避免原生选择弹窗，选项少时更直观） */
function Segmented({ value, options, onChange }: { value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <View className="creation-segmented">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Button
            key={option.value}
            className={`creation-segmented-item${active ? ' active' : ''}`}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            {option.label}
          </Button>
        );
      })}
    </View>
  );
}
