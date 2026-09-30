/** 使用真实格式化函数、状态归并和 React 渲染，不替换网络或浏览器。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomPuzzleQuerySchema, randomPuzzleResponseSchema, roomEventPayloadSchemas, soloJudgeResponseSchema, soloSolveResponseSchema, type RoomEvent } from '@jev/contracts';
import { confidenceLabel, inviteUrl } from '../src/game/game-display.js';
import { HintCapsule } from '../src/game/hint-capsule.js';
import { GameHeader } from '../src/game/game-header.js';
import { applyEvent, type RoomState } from '../src/rooms/room-state.js';
import { latestSessionInLanguage } from '../src/solo/session-selection.js';

describe('邀请链接', () => {
  it.each(['https://soup.example.com', 'https://soup.example.com/'])('域名 %s 可以直接访问邀请路由', (origin) => {
    expect(inviteUrl(origin, 'abc-123')).toBe('https://soup.example.com/invite/abc-123');
  });
  it('令牌不会变成路径或查询参数', () => {
    expect(new URL(inviteUrl('https://soup.example.com', 'a/b?c')).pathname).toBe('/invite/a%2Fb%3Fc');
  });
});

describe('模型置信度', () => {
  it('单人问答与还原响应保留置信度，缺失概率时拒绝响应', () => {
    expect(soloJudgeResponseSchema.parse({ result: 'yes', confidence: 0.8 })).toEqual({ result: 'yes', confidence: 0.8 });
    expect(soloSolveResponseSchema.parse({ result: 'solved', confidence: 0.9, answer: '汤底' })).toEqual({ result: 'solved', confidence: 0.9, answer: '汤底' });
    expect(soloJudgeResponseSchema.safeParse({ result: 'yes' }).success).toBe(false);
    expect(soloSolveResponseSchema.safeParse({ result: 'solved' }).success).toBe(false);
  });
  it('零和一均为有效概率，中文与英文显示百分比', () => {
    expect(confidenceLabel(0, 'zh')).toBe('置信度 0%');
    expect(confidenceLabel(1, 'en')).toBe('Confidence 100%');
    expect(confidenceLabel(0.876, 'zh')).toBe('置信度 88%');
    expect(confidenceLabel(null, 'zh')).toBeNull();
  });
  it.each([-1, 1.01, NaN, Infinity])('无效概率 %s 直接报错', (value) => {
    expect(() => confidenceLabel(value, 'zh')).toThrow();
    expect(roomEventPayloadSchemas['turn.completed'].safeParse({ turnId: 't', result: 'yes', confidence: value }).success).toBe(false);
  });
  it('实时完成事件保存概率，后续状态事件不会丢失它', () => {
    const state: RoomState = { roomId: 'r', roomStatus: 'playing', hostUserId: 'u', capacity: 8, selectedPuzzle: null, controlVersion: 1, lastSeq: 1, round: null, members: [], discussions: [], followupTargetRoomId: null, turns: [{ turnId: 't', seq: 1, userId: 'u', nickname: '玩家', kind: 'ask', text: '问题', status: 'processing', result: null }] };
    const event: RoomEvent<'turn.completed'> = { schemaVersion: 1, eventId: 'e', roomId: 'r', roundId: 'round', seq: 2, occurredAt: '2026-09-29T00:00:00Z', type: 'turn.completed', payload: { turnId: 't', result: 'yes', confidence: 0.87 } };
    const next = applyEvent(state, event);
    expect(next.turns[0]).toMatchObject({ result: 'yes', confidence: 0.87, status: 'succeeded' });
  });
});

describe('提示胶囊', () => {
  it('空提示不出现，已解锁提示默认展示最新一条', () => {
    expect(renderToStaticMarkup(<HintCapsule hints={[]} />)).toBe('');
    const markup = renderToStaticMarkup(<HintCapsule hints={['第一条', '第二条']} />);
    expect(markup).toContain('第二条');
    expect(markup).not.toContain('第一条');
    expect(markup).toContain('2/3');
    expect(markup).toContain('上一条提示');
    expect(markup).toContain('下一条提示');
  });
});

describe('随机换题契约', () => {
  const currentId = '00000000-0000-4000-8000-000000000001';
  it('保留当前语言与排除题目，未指定语言时使用中文', () => {
    expect(randomPuzzleQuerySchema.parse({ language: 'en', exclude: currentId })).toEqual({ language: 'en', exclude: currentId });
    expect(randomPuzzleQuerySchema.parse({})).toEqual({ language: 'zh' });
    expect(randomPuzzleResponseSchema.parse({ puzzleId: currentId })).toEqual({ puzzleId: currentId });
  });
  it('拒绝不支持的语言和无效作品编号', () => {
    expect(randomPuzzleQuerySchema.safeParse({ language: 'fr' }).success).toBe(false);
    expect(randomPuzzleQuerySchema.safeParse({ exclude: 'not-a-puzzle' }).success).toBe(false);
    expect(randomPuzzleResponseSchema.safeParse({ puzzleId: 'not-a-puzzle' }).success).toBe(false);
  });
});

describe('共用游玩顶部栏', () => {
  it('完整题目作为唯一标题，左右操作各自保留独立区域', () => {
    const markup = renderToStaticMarkup(<GameHeader title="很长的海龟汤题目" back={<button>返回</button>} action={<button>换一题</button>} />);
    expect(markup).toContain('<h1 class="brand brand-sm" title="很长的海龟汤题目">很长的海龟汤题目</h1>');
    expect(markup).toContain('game-topbar-back');
    expect(markup).toContain('game-topbar-action');
    expect(markup).toContain('换一题');
  });
});

describe('单人语言恢复', () => {
  it('更新的中文记录不会覆盖英文记录，选择最新英文局', () => {
    const rows = [{ language: 'en' as const, startedAt: 1 }, { language: 'en' as const, startedAt: 2 }, { language: 'zh' as const, startedAt: 3 }];
    expect(latestSessionInLanguage(rows, 'en')).toBe(rows[1]);
    expect(latestSessionInLanguage(rows, 'zh')).toBe(rows[2]);
    expect(latestSessionInLanguage([], 'en')).toBeUndefined();
  });
});
