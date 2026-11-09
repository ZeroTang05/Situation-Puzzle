/**
 * 创作预览私测的本地存储（口径对齐 apps/web/src/solo/local-store.ts 的预览用法）：
 * 预览会话 key = `preview:<userId>:<puzzleId>`，带 previewDigest（服务端 contentHash），
 * 作品内容没变就复用本地对局只换新 token，变了就开新对局——与 web 端一致。
 * 不复用主包 soloStore 的原因：它的 SoloSessionRow 没有 previewDigest 字段，
 * 而主包文件本分包不许改；存储布局（会话一个 key、问答按会话分 key）与 soloStore 相同。
 */
import Taro from '@tarojs/taro'
import { latestSessionInLanguage } from '../solo/session-selection'

/** 预览会话行：与主包 SoloSessionRow 同形，多一个 previewDigest */
export interface PreviewSessionRow {
  localSessionId: string
  /** 预览 key（preview:<userId>:<puzzleId>），不是真实 puzzleId */
  puzzleId: string
  versionId: string
  language: 'zh' | 'en'
  title: string
  surface: string
  configVersion: string
  token: string
  /** 作品内容的 contentHash：决定本地对局能否续用 */
  previewDigest: string
  startedAt: number
  status: 'active' | 'solved' | 'revealed' | 'abandoned'
  hintsUnlocked: number[]
  revealedAnswer: string | null
}

/** 预览问答行：与主包 SoloTurnRow 同形 */
export interface PreviewTurnRow {
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

/** 本地 ID：时间戳 + 随机段（同主包 soloStore 的做法） */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const SESSIONS_KEY = 'jev.mp.preview.sessions'
const TURNS_KEY_PREFIX = 'jev.mp.preview.turns.'
const DRAFT_KEY_PREFIX = 'jev.mp.preview.draft.'

function readJson<T>(key: string, fallback: T): T {
  const raw = Taro.getStorageSync<string>(key)
  if (raw === '' || raw === null || raw === undefined) return fallback
  return JSON.parse(raw) as T
}

function writeJson(key: string, value: unknown): void {
  Taro.setStorageSync(key, JSON.stringify(value))
}

export const previewStore = {
  /** 建预览对局：服务端不存任何预览对话，全部只落本地 */
  async createSession(input: {
    puzzleId: string
    versionId: string
    language: 'zh' | 'en'
    title: string
    surface: string
    token: string
    configVersion: string
    previewDigest: string
  }): Promise<PreviewSessionRow> {
    const session: PreviewSessionRow = {
      localSessionId: localId(),
      ...input,
      startedAt: Date.now(),
      status: 'active',
      hintsUnlocked: [],
      revealedAnswer: null,
    }
    const sessions = readJson<PreviewSessionRow[]>(SESSIONS_KEY, [])
    writeJson(SESSIONS_KEY, [...sessions, session])
    return session
  },

  /** 按预览 key + 语言取最近一次对局（复用判断的第一步） */
  async latestSessionForPuzzle(puzzleId: string, language: 'zh' | 'en'): Promise<PreviewSessionRow | undefined> {
    const sessions = readJson<PreviewSessionRow[]>(SESSIONS_KEY, [])
    return latestSessionInLanguage(sessions.filter((row) => row.puzzleId === puzzleId), language)
  },

  async updateSession(localSessionId: string, patch: Partial<PreviewSessionRow>): Promise<void> {
    const sessions = readJson<PreviewSessionRow[]>(SESSIONS_KEY, [])
    writeJson(
      SESSIONS_KEY,
      sessions.map((row) => (row.localSessionId === localSessionId ? { ...row, ...patch } : row)),
    )
  },

  /** 先写 sending 状态的回合，返回本地回合 ID 供回写结果 */
  async addTurn(input: { localSessionId: string; kind: 'ask' | 'solve'; text: string }): Promise<string> {
    const key = TURNS_KEY_PREFIX + input.localSessionId
    const existing = readJson<PreviewTurnRow[]>(key, [])
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

  /** 请求回来后按 localTurnId 回写结果（遍历各会话 key 定位，同 soloStore） */
  async finishTurn(
    localTurnId: string,
    patch: { status: 'succeeded' | 'failed'; result?: string | null; confidence?: number; failNote?: string },
  ): Promise<void> {
    const sessions = readJson<PreviewSessionRow[]>(SESSIONS_KEY, [])
    for (const session of sessions) {
      const key = TURNS_KEY_PREFIX + session.localSessionId
      const turns = readJson<PreviewTurnRow[]>(key, [])
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

  async listTurns(localSessionId: string): Promise<PreviewTurnRow[]> {
    return readJson<PreviewTurnRow[]>(TURNS_KEY_PREFIX + localSessionId, [])
  },

  /** 输入草稿随输入即时落盘：退出预览再回来不丢输入（web 预览同款） */
  async saveDraft(localSessionId: string, inputMode: 'ask' | 'solve', text: string): Promise<void> {
    writeJson(DRAFT_KEY_PREFIX + localSessionId, { localSessionId, inputMode, text })
  },

  async loadDraft(localSessionId: string): Promise<{ inputMode: 'ask' | 'solve'; text: string } | undefined> {
    return readJson<{ inputMode: 'ask' | 'solve'; text: string } | undefined>(
      DRAFT_KEY_PREFIX + localSessionId,
      undefined,
    )
  },
}
