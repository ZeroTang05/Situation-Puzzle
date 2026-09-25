/**
 * 单人本地存储（docs/rebuild/08-SOLO.md §4）：
 * 会话、问答、进度、草稿全部保存在 IndexedDB；本地 ID 不发送到服务端。
 * 发送流程：先写 sending 状态 → 请求模型 → 拿结果用 localTurnId 回写。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

interface JevLocalDB extends DBSchema {
  solo_sessions: {
    key: string;
    value: {
      localSessionId: string;
      puzzleId: string;
      versionId: string;
      language: 'zh' | 'en';
      title: string;
      surface: string;
      configVersion: string;
      token: string;
      startedAt: number;
      status: 'active' | 'solved' | 'revealed' | 'abandoned';
      hintsUnlocked: number[];
      revealedAnswer: string | null;
    };
    indexes: { 'by-puzzle': string };
  };
  solo_turns: {
    key: string;
    value: {
      localTurnId: string;
      localSessionId: string;
      order: number;
      kind: 'ask' | 'solve';
      text: string;
      status: 'sending' | 'succeeded' | 'failed';
      result: string | null;
      createdAt: number;
      failNote?: string;
    };
    indexes: { 'by-session': string };
  };
  solo_progress: {
    key: string;
    value: {
      puzzleId: string;
      language: string;
      played: boolean;
      solved: boolean;
      revealed: boolean;
      lastPlayedAt: number;
      questionCount: number;
    };
  };
  solo_drafts: {
    key: string;
    value: { localSessionId: string; inputMode: 'ask' | 'solve'; text: string };
  };
  local_meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

const DB_NAME = 'jev-solo';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<JevLocalDB>> | null = null;

function getDB(): Promise<IDBPDatabase<JevLocalDB>> {
  if (!dbPromise) {
    dbPromise = openDB<JevLocalDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const sessions = db.createObjectStore('solo_sessions', { keyPath: 'localSessionId' });
        sessions.createIndex('by-puzzle', 'puzzleId');
        const turns = db.createObjectStore('solo_turns', { keyPath: 'localTurnId' });
        turns.createIndex('by-session', 'localSessionId');
        db.createObjectStore('solo_progress', { keyPath: 'puzzleId' });
        db.createObjectStore('solo_drafts', { keyPath: 'localSessionId' });
        db.createObjectStore('local_meta', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

function localId(): string {
  return crypto.randomUUID();
}

export type SoloSessionRow = JevLocalDB['solo_sessions']['value'];

export const soloStore = {
  async createSession(input: {
    puzzleId: string;
    versionId: string;
    language: 'zh' | 'en';
    title: string;
    surface: string;
    token: string;
    configVersion: string;
  }): Promise<SoloSessionRow> {
    const db = await getDB();
    const session: SoloSessionRow = {
      localSessionId: localId(),
      ...input,
      startedAt: Date.now(),
      status: 'active',
      hintsUnlocked: [],
      revealedAnswer: null,
    };
    await db.put('solo_sessions', session);
    await db.put('solo_progress', {
      puzzleId: input.puzzleId,
      language: input.language,
      played: true,
      solved: false,
      revealed: false,
      lastPlayedAt: Date.now(),
      questionCount: 0,
    });
    return session;
  },

  async getSession(localSessionId: string): Promise<SoloSessionRow | undefined> {
    const db = await getDB();
    return db.get('solo_sessions', localSessionId);
  },

  async latestSessionForPuzzle(puzzleId: string): Promise<SoloSessionRow | undefined> {
    const db = await getDB();
    const rows = await db.getAllFromIndex('solo_sessions', 'by-puzzle', puzzleId);
    return rows.sort((a, b) => b.startedAt - a.startedAt)[0];
  },

  async listSessions(limit = 50): Promise<SoloSessionRow[]> {
    const db = await getDB();
    const rows = await db.getAll('solo_sessions');
    return rows.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  },

  async updateSession(localSessionId: string, patch: Partial<SoloSessionRow>): Promise<void> {
    const db = await getDB();
    const session = await db.get('solo_sessions', localSessionId);
    if (!session) return;
    await db.put('solo_sessions', { ...session, ...patch });
  },

  async addTurn(input: { localSessionId: string; kind: 'ask' | 'solve'; text: string }): Promise<string> {
    const db = await getDB();
    const existing = await db.getAllFromIndex('solo_turns', 'by-session', input.localSessionId);
    const localTurnId = localId();
    await db.put('solo_turns', {
      localTurnId,
      localSessionId: input.localSessionId,
      order: existing.length,
      kind: input.kind,
      text: input.text,
      status: 'sending',
      result: null,
      createdAt: Date.now(),
    });
    return localTurnId;
  },

  async finishTurn(
    localTurnId: string,
    patch: { status: 'succeeded' | 'failed'; result?: string | null; failNote?: string },
  ): Promise<void> {
    const db = await getDB();
    const turn = await db.get('solo_turns', localTurnId);
    if (!turn) return;
    await db.put('solo_turns', {
      ...turn,
      status: patch.status,
      result: patch.result ?? null,
      ...(patch.failNote !== undefined ? { failNote: patch.failNote } : {}),
    });
  },

  async listTurns(localSessionId: string): Promise<JevLocalDB['solo_turns']['value'][]> {
    const db = await getDB();
    const rows = await db.getAllFromIndex('solo_turns', 'by-session', localSessionId);
    return rows.sort((a, b) => a.order - b.order);
  },

  async saveDraft(localSessionId: string, inputMode: 'ask' | 'solve', text: string): Promise<void> {
    const db = await getDB();
    await db.put('solo_drafts', { localSessionId, inputMode, text });
  },

  async loadDraft(localSessionId: string): Promise<{ inputMode: 'ask' | 'solve'; text: string } | undefined> {
    const db = await getDB();
    return db.get('solo_drafts', localSessionId);
  },

  async bumpProgress(puzzleId: string, patch: { solved?: boolean; revealed?: boolean; questionDelta?: number }): Promise<void> {
    const db = await getDB();
    const row = await db.get('solo_progress', puzzleId);
    if (!row) return;
    await db.put('solo_progress', {
      ...row,
      solved: patch.solved ?? row.solved,
      revealed: patch.revealed ?? row.revealed,
      questionCount: row.questionCount + (patch.questionDelta ?? 0),
      lastPlayedAt: Date.now(),
    });
  },

  async exportAll(): Promise<string> {
    const db = await getDB();
    const [sessions, turns, progress] = await Promise.all([db.getAll('solo_sessions'), db.getAll('solo_turns'), db.getAll('solo_progress')]);
    return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), sessions, turns, progress }, null, 2);
  },

  /** 导入：标准 JSON + 结构校验失败就地报错；不把导入数据当作多人记录。 */
  async importAll(json: string): Promise<void> {
    const data = JSON.parse(json) as {
      schemaVersion: number;
      sessions: SoloSessionRow[];
      turns: JevLocalDB['solo_turns']['value'][];
      progress: JevLocalDB['solo_progress']['value'][];
    };
    if (data.schemaVersion !== 1 || !Array.isArray(data.sessions) || !Array.isArray(data.turns)) {
      throw new Error('导入文件结构不正确');
    }
    const db = await getDB();
    for (const row of data.sessions) {
      if (!row.localSessionId || !row.puzzleId) throw new Error('导入文件包含不完整的会话记录');
      await db.put('solo_sessions', row);
    }
    for (const row of data.turns) {
      if (!row.localTurnId || !row.localSessionId) throw new Error('导入文件包含不完整的问答记录');
      await db.put('solo_turns', row);
    }
    for (const row of data.progress ?? []) {
      await db.put('solo_progress', row);
    }
  },

  /** 删除单局：连带问答与草稿。 */
  async deleteSession(localSessionId: string): Promise<void> {
    const db = await getDB();
    const turns = await db.getAllFromIndex('solo_turns', 'by-session', localSessionId);
    for (const turn of turns) await db.delete('solo_turns', turn.localTurnId);
    await db.delete('solo_sessions', localSessionId);
    await db.delete('solo_drafts', localSessionId);
  },

  /** 清空全部本地记录（二次确认由 UI 负责）。 */
  async clearAll(): Promise<void> {
    const db = await getDB();
    await Promise.all([
      db.clear('solo_sessions'),
      db.clear('solo_turns'),
      db.clear('solo_progress'),
      db.clear('solo_drafts'),
    ]);
  },
};
