/** 首页、题库与单人游戏：真实接口、固定题目版本、本地历史及逐条判题。 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  puzzleListItemSchema, authorDisplaySchema, soloSessionResponseSchema, recentQaSchema, soloSessionRequestSchema,
  soloJudgeRequestSchema, soloJudgeResponseSchema, soloSolveRequestSchema, soloSolveResponseSchema,
  soloHintRequestSchema, soloRevealRequestSchema, myRatingSchema, canRateSoloPuzzle, selectUnplayedPuzzle,
  type Language, type CreationPreview,
} from '@jev/contracts';
import { confidenceLabel, displayVerdict, t as playerCopy } from '@jev/i18n';
import { api, request } from '../api.js';
import { confirm, isForeground, useLanguage } from '../runtime.js';
import { useEndpoint, useNavigation, useSession, useTask, Status, TaskStatus, type PickTarget } from '../state.js';
import { Badge, Button, Card, Choice, Input, Row, SectionTitle, Text, View } from '../ui/components.js';
import { showGameEndAd } from '../ads.js';
import { readAllCatalogItems } from '../catalogue-pages.js';
import { beginSoloTurn, completeSoloTurn, failSoloTurn, type SavedGame } from '../solo-state.js';
import { getSoloStore } from '../solo-store.js';
import { newRequestId } from '../ids.js';

const publicPuzzleSchema = puzzleListItemSchema.extend({ authorDisplay: authorDisplaySchema, upCount: z.number(), downCount: z.number() });
const catalogueSchema = z.object({ items: z.array(publicPuzzleSchema), total: z.number(), totalPages: z.number(), page: z.number() });
const SOLO_PREFIX = 'jev.taptap.solo.';
const PLAYED_PREFIX = 'jev.taptap.played.';

/** 已玩记录只读本机键名，不把游玩记录发送给题库服务器。 */
function playedPuzzleIds(): string[] {
  const keys = tap.getStorageInfoSync().keys;
  return [...new Set(keys.flatMap((key) => key.startsWith(PLAYED_PREFIX) ? [key.slice(PLAYED_PREFIX.length)] : key.startsWith(SOLO_PREFIX) ? [key.slice(SOLO_PREFIX.length, key.lastIndexOf(':'))] : []))];
}

/** 在当前语言的全部公开题目中排除已玩作品，全部玩过时明确提示。 */
async function unplayedPuzzle(language: Language, currentId = ''): Promise<string> {
  const pageSchema = z.object({ items: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() });
  const items = await readAllCatalogItems((cursor) => {
    const params = new URLSearchParams({ language, sort: 'latest', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    return api(`/puzzles?${params.toString()}`, { anonymous: true }, pageSchema);
  });
  const id = selectUnplayedPuzzle(items.map((item) => item.id), playedPuzzleIds(), currentId);
  if (id === null) throw new Error(playerCopy(language).noOtherPuzzle);
  return id;
}

export function Home() {
  const { t, language } = useLanguage(); const { go } = useNavigation(); const { session } = useSession();
  const [help, setHelp] = useState(false); const copy = playerCopy(language);
  const rooms = useEndpoint<{ rooms: Array<{ roomId: string; title: string | null; createdAt: string }> }>('/me/active-rooms', { enabled: Boolean(session), interval: 5000 });
  const entitlement = useEndpoint<{ sponsored: boolean; freeRemaining: number }>('/rooms/entitlement-preview', { enabled: Boolean(session) });
  return <View>
    <Card style={{ padding: 18, backgroundColor: '#102b3b', borderColor: '#31586a' }}>
      <Text size={16} style={{ color: '#7dd8c6', fontWeight: 'bold' }}>{t('问出线索，还原真相。', 'Ask for clues. Uncover the truth.')}</Text>
      <Text muted size={14}>{t('一碗汤，一群人，一场推理。', 'One puzzle, one group, one mystery.')}</Text>
      <Button primary style={{ minHeight: 52, fontSize: 17 }} onPress={() => go({ page: 'library' })}>{t('一个人喝汤 · 挑一碗汤', 'Play solo · Choose a puzzle')}</Button>
      <Button style={{ minHeight: 52, fontSize: 17 }} onPress={() => go({ page: 'open-lobby' })}>{t('和朋友一起推理 · 开房间', 'Solve with friends · Create a room')}</Button>
      <Row style={{ flexWrap: 'nowrap' }}>
        <View style={{ flex: 1, marginRight: 6 }}><Button style={{ minHeight: 38, padding: 6 }} onPress={() => go({ page: 'hall' })}>{t('大厅', 'Lobby')}</Button></View>
        <View style={{ flex: 1, marginRight: 6 }}><Button style={{ minHeight: 38, padding: 6 }} onPress={() => go({ page: 'friends' })}>{t('好友', 'Friends')}</Button></View>
        <View style={{ flex: 1 }}><Button style={{ minHeight: 38, padding: 6 }} onPress={() => go({ page: 'creations' })}>{t('创作', 'Create')}</Button></View>
      </Row>
    </Card>
    {session && <View><Status query={rooms} />{rooms.data && rooms.data.rooms.length > 0 && <View><SectionTitle>{copy.activeRooms}</SectionTitle><Card style={{ padding: 8 }}>{rooms.data.rooms.map((room) => <Button key={room.roomId} style={{ textAlign: 'left', marginBottom: 4 }} onPress={() => go({ page: 'room', id: room.roomId })}>{room.title ?? new Date(room.createdAt).toLocaleString()}</Button>)}</Card></View>}
      <Status query={entitlement} />{entitlement.data && <Card style={{ padding: 12 }}><Row style={{ alignItems: 'center', justifyContent: 'space-between' }}><Text muted size={13}>{copy.freeRooms}</Text><Badge tone={entitlement.data.sponsored ? 'accent' : 'muted'}>{entitlement.data.sponsored ? copy.unlimited : `${entitlement.data.freeRemaining} / 10`}</Badge></Row></Card>}
    </View>}
    <SectionTitle action={<Button style={{ minHeight: 32, padding: 4, paddingLeft: 10, paddingRight: 10, marginBottom: 0 }} onPress={() => setHelp(!help)}>{copy.howToPlay}</Button>}>{t('继续探索', 'Explore')}</SectionTitle>
    {help && <Card><Text>{copy.introWhat}</Text><Text>{copy.introGoal}</Text><Text>{copy.introAdvice}</Text><Button onPress={() => setHelp(false)}>{copy.gotIt}</Button></Card>}
  </View>;
}

export function Library({ pick }: { pick?: PickTarget }) {
  const { language, t } = useLanguage(); const { go, resetScroll } = useNavigation(); const task = useTask();
  const [page, setPage] = useState(1); const [sort, setSort] = useState<'popular' | 'latest'>('popular');
  const [pageInput, setPageInput] = useState('1'); const [pageError, setPageError] = useState('');
  const [difficulty, setDifficulty] = useState(''); const [category, setCategory] = useState(''); const [played, setPlayed] = useState<'all' | 'unplayed' | 'played'>('all');
  // 切页或改变筛选后从首题开始显示，同时同步页码输入和校验信息。
  useEffect(() => { setPageInput(String(page)); setPageError(''); resetScroll(); }, [page, sort, difficulty, category, played, language, resetScroll]);
  const path = `/puzzles?language=${language}&sort=${sort}&page=${page}&limit=20${difficulty ? `&difficulty=${difficulty}` : ''}${category ? `&category=${category}` : ''}`;
  const query = useEndpoint<z.infer<typeof catalogueSchema>>(path, { enabled: played === 'all' }); const playedIds = new Set(playedPuzzleIds());
  // 已玩筛选需要先取全量公开候选，再在本机筛选、分页，避免只筛当前二十题。
  const fullCatalogue = useQuery({ queryKey: ['catalogue-filter', language, sort, difficulty, category], enabled: played !== 'all', retry: false,
    queryFn: () => readAllCatalogItems((cursor) => {
      const params = new URLSearchParams({ language, sort, limit: '100' });
      if (difficulty) params.set('difficulty', difficulty);
      if (category) params.set('category', category);
      if (cursor) params.set('cursor', cursor);
      return api(`/puzzles?${params.toString()}`, { anonymous: true }, z.object({ items: z.array(publicPuzzleSchema), nextCursor: z.string().nullable() }));
    }),
  });
  const filteredItems = fullCatalogue.data?.filter((item) => (played === 'played') === playedIds.has(item.id));
  const listQuery = played === 'all' ? query : fullCatalogue;
  const listing = played === 'all' ? query.data : filteredItems && {
    items: filteredItems.slice((page - 1) * 20, page * 20), total: filteredItems.length, totalPages: Math.max(1, Math.ceil(filteredItems.length / 20)), page,
  };
  const jump = (value: string) => {
    if (!listing) return;
    const next = Number(value);
    if (!Number.isSafeInteger(next) || next < 1 || next > listing.totalPages) {
      setPageError(t(`请输入 1 到 ${listing.totalPages} 之间的整数页码`, `Enter a whole page number from 1 to ${listing.totalPages}`)); return;
    }
    setPage(next); setPageInput(String(next)); setPageError('');
  };
  const select = (id: string) => task.run(async () => {
    if (pick && 'lobbyId' in pick) { await api(`/lobbies/${pick.lobbyId}/select`, { body: { puzzleId: id, language } }); go({ page: 'lobby', id: pick.lobbyId }, true); }
    else if (pick && 'sourceRoomId' in pick) {
      const result = await api<{ targetRoomId: string }>('/rooms/followup', { body: { sourceRoomId: pick.sourceRoomId, puzzleId: id, language } }); go({ page: 'room', id: result.targetRoomId }, true);
    } else go({ page: 'solo', id, language }, true);
  });
  return <View>
    <Text size={24} style={{ fontWeight: 'bold' }}>{t('题库', 'Puzzle library')}</Text>
    <Text muted size={14}>{t('挑一碗适合今天的汤。', 'Pick a mystery for today.')}</Text>
    <Choice value={sort} options={[[ 'popular', t('热门', 'Popular') ], [ 'latest', t('最新', 'Latest') ]]} onChange={(value) => { setSort(value); setPage(1); }} />
    <Choice value={difficulty} options={[[ '', t('全部难度', 'All levels') ], [ 'easy', t('简单', 'Easy') ], [ 'medium', t('普通', 'Medium') ], [ 'hard', t('困难', 'Hard') ]]} onChange={(value) => { setDifficulty(value); setPage(1); }} />
    <Choice value={category} options={[[ '', t('全部类别', 'All types') ], [ 'honkaku', t('本格', 'Realistic') ], [ 'henkaku', t('变格', 'Supernatural') ]]} onChange={(value) => { setCategory(value); setPage(1); }} />
    <Choice<'all' | 'unplayed' | 'played'> value={played} options={[[ 'all', t('全部', 'All') ], [ 'unplayed', t('未玩', 'Unplayed') ], [ 'played', t('已玩', 'Played') ]]} onChange={(value) => { setPlayed(value); setPage(1); }} />
    <TaskStatus task={task} /><Status query={listQuery} />
    {listing?.items.length === 0 && <Text muted>{t('没有符合条件的题目。', 'No puzzles match these filters.')}</Text>}
    {listing?.items.map((item) => <Card key={item.id} style={{ padding: 14 }}>
      <Text size={19} style={{ fontWeight: 'bold' }}>{item.title}</Text><Text muted size={14}>{item.surface.slice(0, 100) + (item.surface.length > 100 ? '…' : '')}</Text>
      <Text muted size={12}>{[item.category ? item.category === 'honkaku' ? t('本格', 'Realistic') : t('变格', 'Supernatural') : '', item.difficulty ? item.difficulty === 'easy' ? t('简单', 'Easy') : item.difficulty === 'hard' ? t('困难', 'Hard') : t('普通', 'Medium') : '', playedIds.has(item.id) ? t('已玩', 'Played') : '', item.durationMinutes ? `${item.durationMinutes} ${t('分钟', 'min')}` : ''].filter(Boolean).join(' · ')}</Text>
      <Text muted size={12}>{`${item.authorDisplay.mode === 'anonymous' ? t('匿名', 'Anonymous') : item.authorDisplay.name === '初始题库' ? t('初始题库', 'Starter library') : item.authorDisplay.name} · ${t('赞', 'Likes')} ${item.upCount} · ${t('踩', 'Dislikes')} ${item.downCount}`}</Text>
      {item.contentWarnings.length > 0 && <Badge tone="danger">{item.contentWarnings.join(' · ')}</Badge>}
      <Button primary disabled={task.busy} onPress={() => { void select(item.id); }}>{pick ? t('选这碗汤', 'Select puzzle') : t('开始推理', 'Play')}</Button>
      {!pick && <Button disabled={task.busy} onPress={() => go({ page: 'open-lobby', puzzleId: item.id, language })}>{t('用这碗汤开房间', 'Create a room with this puzzle')}</Button>}
    </Card>)}
    {listing && <View><Text muted>{`${page} / ${listing.totalPages} · ${listing.total}`}</Text>
      <Row><Button disabled={page <= 1} onPress={() => setPage(page - 1)}>{t('上一页', 'Previous')}</Button><Button disabled={page >= listing.totalPages} onPress={() => setPage(page + 1)}>{t('下一页', 'Next')}</Button></Row>
      <Input label={t('跳转到页码', 'Go to page')} value={pageInput} maxLength={6} onChange={(value) => { setPageInput(value); setPageError(''); }} onSubmit={jump} />
      <Button disabled={!pageInput.trim()} onPress={() => jump(pageInput)}>{t('跳转', 'Go to page')}</Button>{pageError && <Text>{pageError}</Text>}
    </View>}
    {!pick && <Button disabled={task.busy} onPress={() => { void task.run(async () => { const id = await unplayedPuzzle(language); go({ page: 'solo', id, language }, true); }); }}>{t('随机来一碗', 'Random puzzle')}</Button>}
  </View>;
}

export function Solo({ id, puzzleLanguage, preview }: { id: string; puzzleLanguage?: Language; preview?: CreationPreview }) {
  const { language, t } = useLanguage(); const targetLanguage = preview?.language ?? puzzleLanguage ?? language;
  const key = preview ? `jev.taptap.preview.${id}:${preview.contentHash}` : `${SOLO_PREFIX}${id}:${targetLanguage}`;
  const freshPreview = (): SavedGame | null => preview ? { session: { ...preview, puzzleId: id, category: null, difficulty: null }, turns: [], answer: null, drafts: { ask: '', solve: '' }, mode: 'ask', hintsUsed: 0, useLargeModel: false } : null;
  const store = useMemo(() => getSoloStore(key, freshPreview()), [key]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const game = snapshot.game;
  const task = useTask(); const { go, back } = useNavigation();
  const busy = snapshot.busy || task.busy;
  const puzzle = useEndpoint<z.infer<typeof puzzleListItemSchema>>(`/puzzles/${id}?language=${targetLanguage}`, { enabled: game === null && !preview });
  const persist = (next: SavedGame) => store.update(() => next);
  useEffect(() => {
    if (preview && game && !snapshot.busy && game.session.token !== preview.token) store.update((current) => current && ({ ...current, session: { ...current.session, token: preview.token } }));
  }, [store, preview?.token, snapshot.busy]);
  const wasFinished = useRef(Boolean(game?.answer));
  useEffect(() => {
    const ended = Boolean(game?.answer);
    if (ended && !wasFinished.current && !preview && isForeground()) void showGameEndAd();
    wasFinished.current = ended;
  }, [game?.answer]);
  const start = async () => {
    if (!puzzle.data) throw new Error(t('题目尚未加载', 'The puzzle has not loaded'));
    const session = await request('/solo/sessions', soloSessionResponseSchema, soloSessionRequestSchema.parse({ puzzleId: id, versionId: puzzle.data.versionId, language: targetLanguage }));
    tap.setStorageSync(`${PLAYED_PREFIX}${id}`, true);
    persist({ session, turns: [], answer: null, drafts: { ask: '', solve: '' }, mode: 'ask', hintsUsed: 0, useLargeModel: false });
  };
  const submit = (value?: string) => store.run(async () => {
    const submitted = store.getSnapshot().game;
    if (!submitted || submitted.answer) return;
    const text = (value ?? submitted.drafts[submitted.mode]).trim(); if (!text) return;
    const turnId = newRequestId();
    store.update((current) => { if (!current) throw new Error('单人记录不存在'); return beginSoloTurn(current, turnId, text); });
    try {
      const recentQas = submitted.turns.filter((turn) => turn.kind === 'ask' && turn.status === 'succeeded' && recentQaSchema.shape.verdict.safeParse(turn.result).success).slice(-10).map((turn) => recentQaSchema.parse({ question: turn.text, verdict: turn.result }));
      const result = submitted.mode === 'ask'
        ? await request('/solo/judge', soloJudgeResponseSchema, soloJudgeRequestSchema.parse({ token: submitted.session.token, question: text, recentQas }))
        : await request('/solo/solve', soloSolveResponseSchema, soloSolveRequestSchema.parse({ token: submitted.session.token, solution: text, useLargeModel: submitted.useLargeModel }));
      store.update((current) => { if (!current) throw new Error('单人记录不存在'); return completeSoloTurn(current, turnId, result); });
    } catch (error) {
      store.update((current) => { if (!current) throw new Error('单人记录不存在'); return failSoloTurn(current, turnId, error instanceof Error ? error.message : String(error)); });
      throw error;
    }
  });
  if (!game) return <View><Status query={puzzle} />{snapshot.error && <Text>{snapshot.error}</Text>}{snapshot.busy && <Text muted>{t('正在开局…', 'Starting…')}</Text>}{puzzle.data && <Card style={{ padding: 18, backgroundColor: '#102b3b' }}><Badge tone="accent">{t('单人推理', 'Solo puzzle')}</Badge><Text size={24} style={{ fontWeight: 'bold' }}>{puzzle.data.title}</Text><Text>{puzzle.data.surface}</Text><Button primary disabled={busy} onPress={() => { void store.run(start); }}>{t('开始推理', 'Start solving')}</Button></Card>}</View>;
  return <View><Badge tone="accent">{t('单人推理', 'Solo puzzle')}</Badge><Text size={24} style={{ fontWeight: 'bold' }}>{game.session.title}</Text><Card style={{ padding: 14, backgroundColor: '#102b3b' }}><Text>{game.session.surface}</Text></Card>
    {game.turns.map((turn) => <Card key={turn.id} style={{ padding: 13, backgroundColor: turn.kind === 'ask' || turn.kind === 'solve' ? '#173446' : '#142b3a' }}><Text muted size={12}>{turn.kind === 'hint' ? t('提示', 'Hint') : turn.kind === 'solve' ? t('还原真相', 'Solution') : t('问 Jev', 'Ask Jev')}</Text><Text>{turn.text}</Text>
      {turn.status === 'sending' && <Text muted>{t('正在判定…', 'Judging…')}</Text>}
      {turn.status === 'interrupted' && <Text>{t('上次请求未收到结果，请核对后重新发送。', 'The previous request was interrupted. Review and send again.')}</Text>}
      {turn.error && <Text>{turn.error}</Text>}{turn.result && <Text style={{ color: '#7dd8c6' }}>{displayVerdict(turn.result, language)}</Text>}{turn.confidence !== undefined && <Text muted size={12}>{confidenceLabel(turn.confidence, language)}</Text>}
      {!game.answer && (turn.status === 'failed' || turn.status === 'interrupted') && <Button disabled={busy} onPress={() => {
        if (turn.kind === 'hint') return;
        const mode = turn.kind; store.update((current) => current && ({ ...current, mode, drafts: { ...current.drafts, [mode]: turn.text } }));
      }}>{t('恢复到输入框', 'Restore to input')}</Button>}
    </Card>)}
    <TaskStatus task={task} />{snapshot.error && <Text>{snapshot.error}</Text>}
    {game.answer ? <Card><Text size={22}>{t('汤底', 'The truth')}</Text><Text>{game.answer}</Text></Card> : <View>
      <Choice disabled={busy} value={game.mode} options={[[ 'ask', t('问 Jev', 'Ask Jev') ], [ 'solve', t('还原真相', 'Solve') ]]} onChange={(mode) => persist({ ...game, mode })} />
      {game.mode === 'solve' && <Button disabled={busy} onPress={() => persist({ ...game, useLargeModel: !game.useLargeModel })}>{`${game.useLargeModel ? '✓ ' : ''}${t('使用大模型判定', 'Use the large model')}`}</Button>}
      <Input key={game.mode} label={game.mode === 'ask' ? t('你的问题', 'Your question') : t('你的还原', 'Your solution')} value={game.drafts[game.mode]} maxLength={game.mode === 'ask' ? 500 : 1500} multiline disabled={busy}
        onChange={(value) => persist({ ...game, drafts: { ...game.drafts, [game.mode]: value } })} onSubmit={(value) => { void submit(value); }} />
      <Button primary disabled={busy || !game.drafts[game.mode].trim()} onPress={() => { void submit(); }}>{t('发送', 'Send')}</Button>
      <Button disabled={busy || game.hintsUsed >= game.session.hintsTotal} onPress={() => { void store.run(async () => {
        const result = await request('/solo/hints', z.object({ text: z.string() }), soloHintRequestSchema.parse({ token: game.session.token, index: game.hintsUsed }));
        store.update((current) => current && ({ ...current, hintsUsed: current.hintsUsed + 1, turns: [...current.turns, { id: newRequestId(), kind: 'hint', status: 'succeeded', text: result.text }] }));
      }); }}>{`${t('提示', 'Hint')} ${game.hintsUsed}/${game.session.hintsTotal}`}</Button>
      <Button disabled={busy} onPress={() => { void store.run(async () => {
        if (!await confirm(t('揭晓汤底', 'Reveal answer'), t('揭晓后本局结束，确定查看吗？', 'Revealing ends this game. Continue?'))) return;
        const result = await request('/solo/reveal', z.object({ answer: z.string() }), soloRevealRequestSchema.parse({ token: game.session.token, confirmed: true })); store.update((current) => current && ({ ...current, answer: result.answer }));
      }); }}>{t('揭晓汤底', 'Reveal answer')}</Button>
    </View>}
    {!preview && canRateSoloPuzzle(game.answer, game.turns) && <Rating puzzleId={id} puzzleLanguage={game.session.language} />}
    <Button disabled={busy} onPress={() => { void store.run(async () => { if (await confirm(t('重新开始', 'Restart'), t('清空本局记录并重新开始吗？', 'Clear this game and restart?'))) store.update(() => freshPreview()); }); }}>{t('重新开始', 'Restart')}</Button>
    <Button onPress={() => preview ? back() : go({ page: 'library' })}>{preview ? t('返回编辑', 'Back to editor') : t('返回题库', 'Puzzle library')}</Button>
    {!preview && <Button disabled={busy} onPress={() => { void task.run(async () => { const selectedId = await unplayedPuzzle(targetLanguage, id); go({ page: 'solo', id: selectedId, language: targetLanguage }, true); }); }}>{t('换一碗汤', 'Another puzzle')}</Button>}
  </View>;
}

export function Rating({ puzzleId, puzzleLanguage }: { puzzleId: string; puzzleLanguage?: Language }) {
  const { t, language } = useLanguage(); const { session } = useSession(); const { go, route } = useNavigation(); const task = useTask(); const client = useQueryClient();
  const query = useEndpoint<z.infer<typeof myRatingSchema>>(`/ratings/${puzzleId}`, { enabled: Boolean(session) });
  const publicStats = useEndpoint<{ upCount: number; downCount: number }>(`/puzzles/${puzzleId}?language=${puzzleLanguage ?? language}`, { enabled: !session });
  const stats = session ? query.data : publicStats.data;
  return <View><Status query={session ? query : publicStats} /><TaskStatus task={task} />{stats && <Row>{(['up', 'down'] as const).map((value) => <View key={value} style={{ marginRight: 8 }}><Button disabled={task.busy} primary={Boolean(session && query.data?.choice === value)} onPress={() => {
    if (!session) { go({ page: 'login', next: route }); return; }
    void task.run(async () => {
    await api(`/ratings/${puzzleId}`, { method: query.data?.choice === value ? 'DELETE' : 'PUT', ...(query.data?.choice !== value && { body: { value } }) }, myRatingSchema);
    await client.invalidateQueries({ queryKey: ['api'] });
  }); }}>{`${value === 'up' ? t('赞', 'Like') : t('踩', 'Dislike')} ${value === 'up' ? stats.upCount : stats.downCount}`}</Button></View>)}</Row>}</View>;
}
