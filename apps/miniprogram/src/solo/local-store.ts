/**
 * 单人本地存储（小程序版，口径对齐 apps/web/src/solo/local-store.ts）：
 * 会话、问答、进度、草稿全部保存在小程序本地存储（Taro storage），
 * 本地 ID 不发送到服务端；服务端不存任何单人对话。
 * web 端用 IndexedDB 分库分表，小程序没有 IndexedDB，改为按「类别一个 key +
 * 问答按会话分 key」的 KV 布局——单局问答独立存放，不会撞单 key 1MB 上限。
 * 发送流程与 web 一致：先写 sending 状态 → 请求模型 → 拿结果按 localTurnId 回写。
 */
import Taro from '@tarojs/taro'
import { latestSessionInLanguage } from './session-selection'

/** 与 web 端同形的会话行 */
export interface SoloSessionRow {
  localSessionId: string
  puzzleId: string
  versionId: string
  language: 'zh' | 'en'
  title: string
  surface: string
  /** 题库题才有 difficulty，玩家自创草稿预览没有 */
  difficulty?: 'easy' | 'medium' | 'hard' | null
  /** 题目类别（本格/变格），与 difficulty 一样仅题库题携带 */
  category?: 'honkaku' | 'henkaku' | null
  configVersion: string
  token: string
  startedAt: number
  status: 'active' | 'solved' | 'revealed' | 'abandoned'
  hintsUnlocked: number[]
  revealedAnswer: string | null
}

export interface SoloTurnRow {
  localTurnId: string
  localSessionId: string
  order: number
  kind: 'ask' | 'solve'
  text: string
  status: 'sending' | 'succeeded' | 'failed'
  result: string | null
  confidence?: number
  createdAt: number
  failNote?: string
}

interface ProgressRow {
  puzzleId: string
  language: string
  played: boolean
  solved: boolean
  revealed: boolean
  lastPlayedAt: number
  questionCount: number
}

/** 本地 ID：小程序没有 crypto.randomUUID，时间戳 + 随机段足够保证不碰撞 */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const SESSIONS_KEY = 'jev.mp.solo.sessions'
const TURNS_KEY_PREFIX = 'jev.mp.solo.turns.'
const PROGRESS_KEY = 'jev.mp.solo.progress'
const DRAFT_KEY_PREFIX = 'jev.mp.solo.draft.'

function readJson<T>(key: string, fallback: T): T {
  const raw = Taro.getStorageSync<string>(key)
  if (raw === '' || raw === null || raw === undefined) return fallback
  return JSON.parse(raw) as T
}

function writeJson(key: string, value: unknown): void {
  Taro.setStorageSync(key, JSON.stringify(value))
}

export const soloStore = {
  async createSession(input: {
    puzzleId: string
    versionId: string
    language: 'zh' | 'en'
    title: string
    surface: string
    difficulty?: 'easy' | 'medium' | 'hard' | null
    category?: 'honkaku' | 'henkaku' | null
    token: string
    configVersion: string
  }): Promise<SoloSessionRow> {
    const session: SoloSessionRow = {
      localSessionId: localId(),
      ...input,
      startedAt: Date.now(),
      status: 'active',
      hintsUnlocked: [],
      revealedAnswer: null,
    }
    const sessions = readJson<SoloSessionRow[]>(SESSIONS_KEY, [])
    writeJson(SESSIONS_KEY, [...sessions, session])
    const progress = readJson<ProgressRow[]>(PROGRESS_KEY, [])
    const next: ProgressRow[] = [
      ...progress.filter((row) => row.puzzleId !== input.puzzleId),
      {
        puzzleId: input.puzzleId,
        language: input.language,
        played: true,
        solved: false,
        revealed: false,
        lastPlayedAt: Date.now(),
        questionCount: 0,
      },
    ]
    writeJson(PROGRESS_KEY, next)
    return session
  },

  async latestSessionForPuzzle(puzzleId: string, language: 'zh' | 'en'): Promise<SoloSessionRow | undefined> {
    const sessions = readJson<SoloSessionRow[]>(SESSIONS_KEY, [])
    const rows = sessions.filter((row) => row.puzzleId === puzzleId)
    return latestSessionInLanguage(rows, language)
  },

  async listSessions(limit = 50): Promise<SoloSessionRow[]> {
    const sessions = readJson<SoloSessionRow[]>(SESSIONS_KEY, [])
    return sessions.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  },

  /** 随机换题读取全部已玩编号，不受历史列表显示数量限制。 */
  async listPlayedPuzzleIds(): Promise<string[]> {
    const progress = readJson<ProgressRow[]>(PROGRESS_KEY, [])
    return progress.map((row) => row.puzzleId)
  },

  async updateSession(localSessionId: string, patch: Partial<SoloSessionRow>): Promise<void> {
    const sessions = readJson<SoloSessionRow[]>(SESSIONS_KEY, [])
    writeJson(
      SESSIONS_KEY,
      sessions.map((row) => (row.localSessionId === localSessionId ? { ...row, ...patch } : row)),
    )
  },

  async addTurn(input: { localSessionId: string; kind: 'ask' | 'solve'; text: string }): Promise<string> {
    const key = TURNS_KEY_PREFIX + input.localSessionId
    const existing = readJson<SoloTurnRow[]>(key, [])
    const localTurnId = localId()
    writeJson(key, [
      ...existing,
      {
        localTurnId,
        localSessionId: input.localSessionId,
        order: existing.length,
        kind: input.kind,
        text: input.text,
        status: 'sending',
        result: null,
        createdAt: Date.now(),
      },
    ])
    return localTurnId
  },

  async finishTurn(
    localTurnId: string,
    patch: { status: 'succeeded' | 'failed'; result?: string | null; confidence?: number; failNote?: string },
  ): Promise<void> {
    // finishTurn 只有 localTurnId：遍历各会话的问答 key 定位（单人页同一时刻只有一个活跃会话，量级可控）
    const sessions = readJson<SoloSessionRow[]>(SESSIONS_KEY, [])
    for (const session of sessions) {
      const key = TURNS_KEY_PREFIX + session.localSessionId
      const turns = readJson<SoloTurnRow[]>(key, [])
      if (!turns.some((turn) => turn.localTurnId === localTurnId)) continue
      writeJson(
        key,
        turns.map((turn) =>
          turn.localTurnId === localTurnId
            ? {
                ...turn,
                status: patch.status,
                result: patch.result ?? null,
                ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
                ...(patch.failNote !== undefined ? { failNote: patch.failNote } : {}),
              }
            : turn,
        ),
      )
      return
    }
  },

  async listTurns(localSessionId: string): Promise<SoloTurnRow[]> {
    return readJson<SoloTurnRow[]>(TURNS_KEY_PREFIX + localSessionId, [])
  },

  async saveDraft(localSessionId: string, inputMode: 'ask' | 'solve', text: string): Promise<void> {
    writeJson(DRAFT_KEY_PREFIX + localSessionId, { localSessionId, inputMode, text })
  },

  async loadDraft(localSessionId: string): Promise<{ inputMode: 'ask' | 'solve'; text: string } | undefined> {
    return readJson<{ inputMode: 'ask' | 'solve'; text: string } | undefined>(
      DRAFT_KEY_PREFIX + localSessionId,
      undefined,
    )
  },

  async bumpProgress(puzzleId: string, patch: { solved?: boolean; revealed?: boolean; questionDelta?: number }): Promise<void> {
    const progress = readJson<ProgressRow[]>(PROGRESS_KEY, [])
    const row = progress.find((item) => item.puzzleId === puzzleId)
    if (!row) return
    writeJson(PROGRESS_KEY, [
      ...progress.filter((item) => item.puzzleId !== puzzleId),
      {
        ...row,
        solved: patch.solved ?? row.solved,
        revealed: patch.revealed ?? row.revealed,
        questionCount: row.questionCount + (patch.questionDelta ?? 0),
        lastPlayedAt: Date.now(),
      },
    ])
  },
}
