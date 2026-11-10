/** 作者创作完整流程：草稿、真实试题、版本条件保存、初审提交、撤回和重修。 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { creationCompleteSchema, creationDetailSchema, creationDraftSchema, creationPreviewSchema, creationSummarySchema, type CreationDraft, type CreationDetail } from '@jev/contracts';
import { api } from '../api.js';
import { confirm, useLanguage } from '../runtime.js';
import { useEndpoint, useNavigation, useSession, useTask, Status, TaskStatus } from '../state.js';
import { Button, Card, Choice, Input, Text, View } from '../ui/components.js';
import { Solo } from './catalog.js';
import { localCreationSchema, persistCreation, transitionCreation, updateCreationAuthor, type CreationBase } from '../creation-save.js';

function statusLabel(status: string, language: 'zh' | 'en'): string {
  const labels: Record<string, [string, string]> = { draft: ['草稿', 'Draft'], submitted: ['已提交', 'Submitted'], checking: ['初审中', 'Checking'], pending_review: ['人工审核中', 'In review'], published: ['已发布', 'Published'], changes_requested: ['待修改', 'Changes requested'], taken_down: ['已下架', 'Taken down'], review_pass: ['初审通过', 'Review passed'], review_reject: ['初审未通过', 'Review rejected'], review_uncertain: ['需要人工审核', 'Manual review needed'], withdrawn: ['已撤回', 'Withdrawn'], check_failed: ['自动检查失败', 'Automatic check failed'], pending: ['授权待审核', 'Rights awaiting review'], approved: ['授权已通过', 'Rights approved'], rejected: ['授权未通过', 'Rights rejected'] };
  return labels[status]?.[language === 'zh' ? 0 : 1] ?? status;
}
export function Creations() {
  const { language, t } = useLanguage(); const { go } = useNavigation();
  const query = useEndpoint<{ items: z.infer<typeof creationSummarySchema>[] }>('/creations');
  const [filter, setFilter] = useState<'all' | 'draft' | 'review' | 'published'>('all');
  const bucket = (status: string) => status === 'draft' ? 'draft' : ['published', 'taken_down'].includes(status) ? 'published' : 'review';
  return <View><Button primary onPress={() => go({ page: 'editor', id: 'new' })}>{t('创作新汤', 'New puzzle')}</Button><Text muted>{t('作品经人工审核通过后，可获得 10 次开房奖励。', 'Earn 10 room credits when a community submission passes manual review.')}</Text>
    <Choice<'all' | 'draft' | 'review' | 'published'> value={filter} options={[[ 'all', t('全部', 'All') ], [ 'draft', t('草稿', 'Drafts') ], [ 'review', t('审核中', 'In review') ], [ 'published', t('已发布', 'Published') ]]} onChange={setFilter} />
    <Status query={query} />{query.data?.items.length === 0 && <Text muted>{t('还没有作品，来写第一碗汤。', 'Write your first puzzle.')}</Text>}
    {query.data?.items.filter((item) => filter === 'all' || bucket(item.status) === filter).map((work) => <Card key={work.puzzleId}><Text size={20}>{work.title}</Text><Text muted>{`${statusLabel(work.status, language)} · v${work.versionNo} · ${work.upCount} / ${work.downCount}`}</Text>{work.pendingName && <Text muted>{`${t('署名待审', 'Name pending review')}：${work.pendingName}`}</Text>}
      <Button onPress={() => go({ page: 'editor', id: work.puzzleId })}>{t('打开作品', 'Open work')}</Button>
      {work.published && <Button onPress={() => go({ page: 'solo', id: work.puzzleId, language: work.publishedLanguage ?? work.language })}>{t('游玩公开版本', 'Play published version')}</Button>}
    </Card>)}
  </View>;
}

export function CreationEditor({ id }: { id: string }) {
  const query = useEndpoint<CreationDetail>(`/creations/${id}`, { enabled: id !== 'new', interval: 5000 });
  if (id !== 'new' && !query.data) return <Status query={query} />;
  return <View>{id !== 'new' && <Status query={query} />}<Editor key={id} id={id} initial={query.data} /></View>;
}

function Editor({ id, initial }: { id: string; initial: CreationDetail | undefined }) {
  const { language, t } = useLanguage(); const { session } = useSession(); const { go } = useNavigation(); const task = useTask();
  const client = useQueryClient();
  const storageKey = `jev.taptap.creation.${session!.user.id}:${id}`;
  const [local] = useState(() => { const value = tap.getStorageSync(storageKey); return value ? localCreationSchema.parse(value) : null; });
  const [draft, setDraft] = useState<CreationDraft>(() => {
    if (local) return local.draft;
    return initial?.draft ?? { title: '', surface: '', answer: '', hints: ['', '', ''], language, difficulty: 'medium', category: 'honkaku', origin: 'original', sourceUrl: '', authorDisplay: { mode: 'anonymous' } };
  });
  const [saved, setSaved] = useState(initial); const version = useRef<CreationBase | undefined>(local?.base ?? initial); const [dirty, setDirty] = useState(Boolean(local));
  const editable = !saved || saved.status === 'draft'; const [notice, setNotice] = useState('');
  // 审核中的状态可更新；本地尚未保存的正文保持作者当前输入。
  useEffect(() => { if (!dirty && initial && initial.updatedAt !== version.current?.updatedAt) { version.current = initial; setSaved(initial); setDraft(initial.draft); } else if (initial && initial.status !== saved?.status) { setSaved(initial); } }, [initial]);
  const change = <K extends keyof CreationDraft>(key: K, value: CreationDraft[K]) => {
    const next = { ...draft, [key]: value }; setDraft(next); setDirty(true); setNotice('');
    tap.setStorageSync(storageKey, localCreationSchema.parse({ draft: next, ...(version.current && { base: version.current }) }));
  };
  /** 采用实际保存结果并更新同一份查询缓存，返回编辑页可立即看到该版本。 */
  const adopt = (result: CreationDetail) => {
    version.current = result; setSaved(result); setDraft(result.draft); setDirty(false); tap.removeStorageSync(storageKey);
    client.setQueryData(['api', session!.user.id, language, `/creations/${result.puzzleId}`], result);
    void client.invalidateQueries({ queryKey: ['api', session!.user.id, language, '/creations'] });
  };
  const save = async (): Promise<CreationDetail> => {
    const parsed = creationDraftSchema.safeParse({ ...draft, hints: draft.hints.map((hint) => hint.trim()).filter(Boolean) });
    if (!parsed.success) throw new Error(t('请检查标题、正文长度、来源链接和公开署名。标题不能为空。', 'Check the title, text length, source URL and author name. A title is required.'));
    if (id !== 'new' && !version.current) throw new Error(t('作品版本尚未加载', 'Work version has not loaded'));
    const result = await persistCreation(api, parsed.data, version.current); adopt(result);
    setNotice(t('已保存', 'Saved')); return result;
  };
  const revise = (action: 'revise' | 'withdraw') => task.run(async () => {
    if (action === 'withdraw' && !await confirm(t('撤回投稿', 'Withdraw submission'), t('确定撤回并继续编辑吗？', 'Withdraw and keep editing?'))) return;
    if (!version.current) throw new Error(t('作品版本尚未加载', 'Work version has not loaded'));
    adopt(await transitionCreation(api, version.current, action));
  });
  return <View>{saved && <Text muted>{`${statusLabel(saved.status, language)} · v${saved.versionNo}`}</Text>}
    {dirty && initial && version.current && (initial.updatedAt !== version.current.updatedAt || initial.versionId !== version.current.versionId) && <Text>{t('服务器上的作品已更新。当前输入仍保留，保存时会检查版本。', 'The server version has changed. Your text is kept, and saving will check the version.')}</Text>}
    <Input label={t('标题', 'Title')} value={draft.title} onChange={(value) => change('title', value)} maxLength={60} disabled={!editable || task.busy} />
    {editable && <View><Choice disabled={task.busy} value={draft.language} options={[[ 'zh', '中文' ], [ 'en', 'English' ]]} onChange={(value) => change('language', value)} />
      <Choice disabled={task.busy} value={draft.difficulty} options={[[ 'easy', t('简单', 'Easy') ], [ 'medium', t('普通', 'Medium') ], [ 'hard', t('困难', 'Hard') ]]} onChange={(value) => change('difficulty', value)} />
      <Choice disabled={task.busy} value={draft.category} options={[[ 'honkaku', t('本格', 'Realistic') ], [ 'henkaku', t('变格', 'Supernatural') ]]} onChange={(value) => change('category', value)} /></View>}
    <Input label={t('汤面', 'Story')} value={draft.surface} multiline maxLength={2000} disabled={!editable || task.busy} onChange={(value) => change('surface', value)} />
    <Input label={t('汤底', 'Truth')} value={draft.answer} multiline maxLength={4000} disabled={!editable || task.busy} onChange={(value) => change('answer', value)} />
    {[0, 1, 2].map((index) => <Input key={index} label={`${t('提示', 'Hint')} ${index + 1}`} value={draft.hints[index] ?? ''} multiline maxLength={500} disabled={!editable || task.busy} onChange={(value) => change('hints', [0, 1, 2].map((i) => i === index ? value : draft.hints[i] ?? ''))} />)}
    {editable && <View><Choice disabled={task.busy} value={draft.origin} options={[[ 'original', t('自制', 'Original') ], [ 'repost', t('转载', 'Repost') ]]} onChange={(value) => change('origin', value)} />
      {draft.origin === 'repost' && <Input disabled={task.busy} label={t('原作者链接', 'Original author link')} value={draft.sourceUrl} onChange={(value) => change('sourceUrl', value)} maxLength={2000} />}
    </View>}
    <Choice disabled={task.busy} value={draft.authorDisplay.mode} options={[[ 'anonymous', t('匿名', 'Anonymous') ], [ 'signature', t('署名', 'Signature') ]]} onChange={(mode) => change('authorDisplay', mode === 'anonymous' ? { mode } : { mode, name: session!.user.name })} />
    {draft.authorDisplay.mode === 'signature' && <Input disabled={task.busy} label={t('公开署名', 'Public author name')} value={draft.authorDisplay.name} maxLength={30} onChange={(name) => change('authorDisplay', { mode: 'signature', name })} />}
    {saved?.authorDisplay.name && <Text muted>{`${t('当前公开署名', 'Public author name')}：${saved.authorDisplay.name}`}</Text>}
    {saved?.authorDisplay.pendingName && <Text muted>{`${t('署名待审核', 'Name awaiting review')}：${saved.authorDisplay.pendingName}`}</Text>}
    {!editable && saved && <Button disabled={task.busy} onPress={() => { void task.run(async () => { adopt(await updateCreationAuthor(api, saved.puzzleId, draft.authorDisplay)); setNotice(t('署名已保存', 'Author name saved')); }); }}>{t('保存署名', 'Save author name')}</Button>}
    {notice && <Text>{notice}</Text>}<TaskStatus task={task} />
    {editable && <View><Button disabled={task.busy || !draft.title.trim()} onPress={() => { void task.run(async () => { const result = await save(); if (id === 'new') go({ page: 'editor', id: result.puzzleId }, true); }); }}>{t('保存草稿', 'Save draft')}</Button>
      <Button primary disabled={task.busy} onPress={() => { void task.run(async () => {
        const parsed = creationCompleteSchema.safeParse(draft);
        if (!parsed.success) throw new Error(t('请补齐标题、汤面、汤底和第一条提示；转载作品需填写有效来源链接。', 'Complete the title, story, truth and first hint. Reposts need a valid source URL.'));
        if (!await confirm(t('提交审核', 'Submit for review'), t('提交后将由 Jev 初审，确定继续吗？', 'Submit this version for Jev review?'))) return;
        const result = await save(); adopt(await transitionCreation(api, result, 'submit')); go({ page: 'editor', id: result.puzzleId }, true);
      }); }}>{t('提交审核', 'Submit for review')}</Button></View>}
    <Button disabled={task.busy} onPress={() => { void task.run(async () => {
      const result = editable ? await save() : saved;
      if (!result) throw new Error(t('作品尚未保存', 'Work has not been saved'));
      go({ page: 'editor', id: result.puzzleId }, true); go({ page: 'preview', id: result.puzzleId });
    }); }}>{t('真实试题', 'Test puzzle')}</Button>
    {saved && ['submitted', 'checking', 'pending_review'].includes(saved.status) && <Button disabled={task.busy} onPress={() => { void revise('withdraw'); }}>{t('撤回投稿', 'Withdraw submission')}</Button>}
    {saved && ['changes_requested', 'published', 'taken_down'].includes(saved.status) && <Button disabled={task.busy} onPress={() => { void revise('revise'); }}>{t('创建修订草稿', 'Create revision')}</Button>}
    {saved && <Button disabled={task.busy} onPress={() => { void task.run(async () => {
      if (dirty && !await confirm(t('刷新作品', 'Refresh work'), t('加载服务器版本会替换当前未保存的输入，确定继续吗？', 'Loading the server version replaces your unsaved text. Continue?'))) return;
      adopt(await api(`/creations/${saved.puzzleId}`, {}, creationDetailSchema)); setNotice(t('已刷新', 'Refreshed'));
    }); }}>{t('刷新作品与审核记录', 'Refresh work and reviews')}</Button>}
    {saved?.reviews.map((review, index) => <Card key={index}><Text>{statusLabel(review.conclusion, language)}</Text><Text muted size={12}>{new Date(review.createdAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</Text>{review.reason && <Text>{review.reason}</Text>}</Card>)}
    {saved && <Card><Text size={19}>{t('版本记录', 'Versions')}</Text>{saved.versions.map((item) => <Text key={item.versionId}>{`v${item.versionNo} · ${statusLabel(item.status, language)}`}</Text>)}</Card>}
  </View>;
}

export function CreationPreview({ id }: { id: string }) {
  const { session } = useSession();
  const query = useQuery({ queryKey: ['preview', session!.user.id, id], queryFn: () => api(`/creations/${id}/test-session`, { method: 'POST' }, creationPreviewSchema), retry: false, staleTime: 0, refetchOnMount: 'always' });
  return <View><Status query={query} />{query.data && <Solo key={`${id}:${query.data.contentHash}`} id={id} preview={query.data} />}</View>;
}
