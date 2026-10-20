/**
 * 小红书评论区机器人 · 状态存储
 *
 * 全部状态放 data/xhs/bot/ 下，纯 JSON，原子写入（先写 .tmp 再 rename）。
 * 记三类东西：
 *  - processed：已处理过的评论（键 = 笔记ID:评论ID），防重复回复
 *  - qa：每篇笔记的最近问答，供判题接口做代词消解（recentQas）
 *  - tokens / puzzleIds：solo 凭证与题库 UUID 映射的缓存
 */
import fs from 'node:fs';
import path from 'node:path';

const EMPTY_STATE = {
  processed: {},
  qa: {},
  dailyCount: {},
  tokens: {},
  puzzleIds: {},
  linkedNotes: {},
};

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function createStore({ root, config }) {
  const statePath = path.resolve(root, config.stateFile);
  const notesPath = path.resolve(root, config.notesFile);

  const state = readJsonSafe(statePath, EMPTY_STATE);
  const notes = readJsonSafe(notesPath, {});

  const today = () => new Date().toISOString().slice(0, 10);

  const store = {
    paths: { statePath, notesPath },

    save() {
      writeJsonAtomic(statePath, state);
      writeJsonAtomic(notesPath, notes);
    },

    /** 笔记绑定：noteId → { day, legacyId, title, url } */
    notes() {
      return notes;
    },
    bindNote(noteId, info) {
      notes[noteId] = { ...(notes[noteId] ?? {}), ...info, boundAt: new Date().toISOString() };
      writeJsonAtomic(notesPath, notes);
    },
    unbindNote(noteId) {
      delete notes[noteId];
      writeJsonAtomic(notesPath, notes);
    },

    isProcessed(key) {
      return Boolean(state.processed[key]);
    },
    processedInfo(key) {
      return state.processed[key] ?? null;
    },
    markProcessed(key, info) {
      state.processed[key] = { at: new Date().toISOString(), ...info };
    },
    processedCount() {
      return Object.keys(state.processed).length;
    },
    /** 某篇笔记已实际回复的条数（processed 里 reply 非空的才算真发出去了） */
    repliedCountFor(noteId) {
      const prefix = `${noteId}:`;
      let n = 0;
      for (const [key, v] of Object.entries(state.processed)) {
        if (key.startsWith(prefix) && v?.reply) n += 1;
      }
      return n;
    },

    /** 每篇笔记的最近问答（旧在前），供判题接口消解「他/她/那个」 */
    qaFor(noteId, limit = 10) {
      const list = state.qa[noteId] ?? [];
      return list.slice(-limit);
    },
    pushQa(noteId, entry) {
      const list = state.qa[noteId] ?? [];
      list.push(entry);
      state.qa[noteId] = list.slice(-20);
    },

    todayCount() {
      return state.dailyCount[today()] ?? 0;
    },
    bumpToday(n = 1) {
      const d = today();
      state.dailyCount[d] = (state.dailyCount[d] ?? 0) + n;
    },

    /** solo 凭证缓存（服务端 24h 过期，提前 4h 刷新） */
    getToken(puzzleId) {
      const row = state.tokens[puzzleId];
      if (!row) return null;
      const ageMs = Date.now() - new Date(row.at).getTime();
      if (ageMs > 20 * 3600 * 1000) return null;
      return row.token;
    },
    setToken(puzzleId, token) {
      state.tokens[puzzleId] = { token, at: new Date().toISOString() };
    },

    /** 题库 legacyId（data/library.json 的 id）→ 数据库 puzzle UUID */
    getPuzzleId(legacyId) {
      return state.puzzleIds[legacyId] ?? null;
    },
    setPuzzleId(legacyId, puzzleId) {
      state.puzzleIds[legacyId] = puzzleId;
    },
  };

  return store;
}
