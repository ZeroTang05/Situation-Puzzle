// 原生小组件页面：内置题库先显示，公开题目与 Jev 请求交给 Worker。
const library = require('../../shared/library.js');
const { copy } = require('../../shared/i18n.js');
const legacyCopy = {
  zh: { library: '题库', records: '记录', create: '出题', share: '分享', tagline: '读汤面 · 向 Jev 提问 · 还原真相', hostIntro: '我是 Jev。请问一个可以用「是 / 否 / 无关」回答的问题。', askPlaceholder: '向 Jev 提一个问题…', solvePlaceholder: '写出你推断的完整真相…', send: '发送', hint: '提示', reveal: '看汤底', solve: '还原真相', exitSolve: '返回提问', answer: '汤底', confidence: '置信度', judging: 'Jev 正在判断…', reviewing: 'Jev 正在审核…', loading: '正在加载题库…', noSoups: '题库暂时为空', retry: '重试', played: '已答', completed: '已解出', attempted: '已尝试', total: '总题数', questions: '提问', times: '次', progressEmpty: '还没有答题记录，先选一道题吧。', title: '标题', story: '汤面', answerField: '汤底', hint1: '提示 1', hint2: '提示 2（选填）', hint3: '提示 3（选填）', submitReview: '提交并等待审核', createIntro: '写下谜面和真相，Jev 审核通过后会立刻公开。', revealConfirm: '看过汤底后，这道题的悬念就揭晓了。确定查看？', close: '很接近了，再想想关键原因。', notYet: '还没有猜到，继续提问吧。', uncertain: '这次无法确定，换个说法试试。', solved: '你还原了真相！', missing: '请填完标题、汤面、汤底和第一条提示。', requestFailed: '连接失败，请重试。' },
  en: { library: 'Library', records: 'History', create: 'Create', share: 'Share', tagline: 'Read the setup · Ask Jev · Solve the mystery', hostIntro: 'I am Jev. Ask questions I can answer Yes, No, or Irrelevant.', askPlaceholder: 'Ask Jev a question…', solvePlaceholder: 'Explain the whole mystery…', send: 'Send', hint: 'Hint', reveal: 'Reveal', solve: 'Solve', exitSolve: 'Back to questions', answer: 'Solution', confidence: 'Confidence', judging: 'Jev is thinking…', reviewing: 'Jev is reviewing…', loading: 'Loading puzzles…', noSoups: 'No puzzles yet', retry: 'Retry', played: 'Played', completed: 'Solved', attempted: 'Attempted', total: 'Total', questions: 'Questions', times: '', progressEmpty: 'No history yet. Pick a puzzle to start.', title: 'Title', story: 'Setup', answerField: 'Solution', hint1: 'Hint 1', hint2: 'Hint 2 (optional)', hint3: 'Hint 3 (optional)', submitReview: 'Submit for review', createIntro: 'Write a setup and solution. Jev will review it before publication.', revealConfirm: 'This will reveal the solution. Continue?', close: 'Very close. Think about the key cause.', notYet: 'Not quite. Keep asking questions.', uncertain: 'Jev cannot tell this time. Try another wording.', solved: 'You solved the mystery!', missing: 'Fill in the title, setup, solution, and first hint.', requestFailed: 'Connection failed. Please retry.' },
};

// 把平台网络回调转换成 Promise；请求失败时保留服务器给出的原因。
function request(path, method, data) {
  return new Promise((resolve, reject) => xhs.request({
    url: `${getApp().globalData.apiBaseUrl}${path}`, method, data,
    header: { 'content-type': 'application/json' },
    success(response) {
      if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(response.data?.error || `HTTP ${response.statusCode}`));
      resolve(response.data);
    },
    fail: reject,
  }));
}

// 答题记录只写入当前设备的小组件存储，不创建平台用户。
function readStorage(key) {
  return new Promise((resolve) => xhs.getStorage({ key, success: (result) => resolve(result.data), fail: () => resolve(null) }));
}
function writeStorage(key, data) {
  return new Promise((resolve, reject) => xhs.setStorage({ key, data, success: resolve, fail: reject }));
}

// 题库与记录使用同一份已答状态。
function decorate(soups, records) {
  return soups.map((soup) => ({ ...soup, state: records[soup.id]?.solved_at ? 'solved' : records[soup.id] ? 'played' : '' }));
}

const seedSoups = (language) => library[language].map(({ answer, ...soup }) => soup);

Page({
  data: {
    language: 'zh', t: copy.zh, view: 'play', soups: [], currentId: '', soup: null,
    messages: [], solveMessages: [], solveOpen: false, question: '',
    hintCount: 0, hintIndex: 0, answer: '', notice: '', loading: true, busy: false,
    records: {}, progress: null, form: { title: '', story: '', answer: '', hint1: '', hint2: '', hint3: '' },
  },

  onLoad(options) {
    this.sharedId = options.soup || '';
    this.initialize(options.lang);
  },

  async initialize(sharedLanguage) {
    try {
      const savedLanguage = await readStorage('jev-language');
      const language = sharedLanguage === 'en' || sharedLanguage === 'zh' ? sharedLanguage : savedLanguage === 'en' ? 'en' : 'zh';
      const records = (await readStorage('jev-browser-progress')) || {};
      const soups = decorate(seedSoups(language), records);
      const chosen = soups.find((item) => item.id === this.sharedId) || soups[0] || null;
      this.setData({ language, t: { ...copy[language], ...legacyCopy[language], play: copy[language].play }, records, soups, currentId: chosen?.id || '', soup: chosen, loading: false });
      this.refreshProgress();
      try { await this.loadSoups(); }
      catch (error) { console.error('公开题库加载失败', error); this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` }); }
    } catch (error) {
      console.error('小组件初始化失败', error);
      this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}`, loading: false });
    }
  },

  async loadSoups() {
    const { language, records } = this.data;
    const result = await request(`/api/soups?lang=${language}`, 'GET');
    const soups = decorate(result.soups, records);
    if (this.sharedId && !soups.some((item) => item.id === this.sharedId)) {
      const resultById = await request(`/api/soups/${encodeURIComponent(this.sharedId)}?lang=${language}`, 'GET');
      soups.push({ ...resultById.soup, state: records[this.sharedId]?.solved_at ? 'solved' : records[this.sharedId] ? 'played' : '' });
    }
    const chosen = soups.find((item) => item.id === this.sharedId)
      || soups.find((item) => item.id === this.data.currentId) || soups[0] || null;
    this.setData({ soups, currentId: chosen?.id || '', soup: chosen, loading: false });
    this.refreshProgress();
    this.sharedId = '';
  },

  refreshProgress() {
    const { soups, records } = this.data;
    const entries = soups.filter((soup) => records[soup.id]).map((soup) => ({ soup_id: soup.id, title: soup.title, ...records[soup.id] }));
    this.setData({ soups: decorate(soups, records), progress: { total: soups.length, attempted: entries.length, solved: entries.filter((entry) => entry.solved_at).length, soups: entries } });
  },
  async recordResult(soupId, outcome, isQuestion) {
    const records = { ...this.data.records };
    const previous = records[soupId] || {};
    const now = new Date().toISOString();
    records[soupId] = { question_count: (previous.question_count || 0) + (isQuestion ? 1 : 0), last_outcome: isQuestion ? previous.last_outcome || null : outcome, solved_at: previous.solved_at || (outcome === '破解成功' || outcome === 'Solved' ? now : null), last_played_at: now };
    await writeStorage('jev-browser-progress', records);
    this.setData({ records });
    this.refreshProgress();
  },

  retry() { this.loadSoups().catch((error) => { console.error('题库刷新失败', error); this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` }); }); },
  dismissNotice() { this.setData({ notice: '' }); },
  async switchLanguage() {
    if (this.data.busy) return;
    const language = this.data.language === 'zh' ? 'en' : 'zh';
    const soups = decorate(seedSoups(language), this.data.records);
    const chosen = soups.find((item) => item.id === this.data.currentId) || soups[0] || null;
    this.setData({ language, t: { ...copy[language], ...legacyCopy[language], play: copy[language].play }, soups, soup: chosen, currentId: chosen?.id || '', notice: '', messages: [], solveMessages: [], answer: '', hintCount: 0 });
    this.refreshProgress();
    try { await writeStorage('jev-language', language); await this.loadSoups(); }
    catch (error) { console.error('切换语言失败', error); this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` }); }
  },
  changeView(event) {
    const view = event.currentTarget.dataset.view;
    this.setData({ view });
  },
  chooseSoup(event) {
    const soup = this.data.soups.find((item) => item.id === event.currentTarget.dataset.id);
    if (!soup) return;
    this.setData({ view: 'play', soup, currentId: soup.id, messages: [], solveMessages: [], solveOpen: false, question: '', hintCount: 0, hintIndex: 0, answer: '', notice: '' });
  },
  // 换一题：优先在没玩过的题里随机抽；都玩过就退回在其余题里随机。
  nextSoup() {
    const { soups, currentId, records } = this.data;
    if (!soups.length) return;
    const others = soups.filter((item) => item.id !== currentId);
    const unplayed = others.filter((item) => !records[item.id]);
    const pool = unplayed.length > 0 ? unplayed : others;
    if (pool.length) this.chooseSoup({ currentTarget: { dataset: { id: pool[Math.floor(Math.random() * pool.length)].id } } });
  },
  questionInput(event) { this.setData({ question: event.detail.value }); },
  formInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  openSolve() { this.setData({ solveOpen: true, question: '' }); },
  closeSolve() { this.setData({ solveOpen: false, question: '' }); },

  async send() {
    const { soup, question, language, solveOpen, busy } = this.data;
    const value = question.trim();
    if (!soup || !value || busy) return;
    const key = solveOpen ? 'solveMessages' : 'messages';
    const items = [...this.data[key], { role: 'user', text: value }];
    this.setData({ [key]: items, question: '', busy: true });
    try {
      const endpoint = solveOpen ? 'solve' : 'judge';
      const payload = solveOpen ? { solution: value } : { question: value };
      const result = await request(`/api/soups/${encodeURIComponent(soup.id)}/${endpoint}?lang=${language}`, 'POST', payload);
      const verdict = solveOpen ? result.outcome : result.verdict;
      const solved = verdict === '破解成功' || verdict === 'Solved';
      const detail = solved ? this.data.t.solved
        : verdict === '接近真相' || verdict === 'Close' ? this.data.t.close
          : verdict === '还没猜对' || verdict === 'Not yet' ? this.data.t.notYet
            : verdict === '无法确定' || verdict === 'Uncertain' ? this.data.t.uncertain : '';
      this.setData({ [key]: [...items, { role: 'jev', verdict, confidence: Math.round(result.confidence * 100), detail, answer: result.answer || '' }] });
      await this.recordResult(soup.id, verdict, !solveOpen);
    } catch (error) {
      console.error('Jev 判断失败', error);
      this.setData({ [key]: [...items, { role: 'jev', detail: `${this.data.t.requestFailed} ${error.message || ''}` }] });
    } finally { this.setData({ busy: false }); }
  },
  revealHint() {
    const { soup, hintCount } = this.data;
    if (soup && hintCount < soup.hints.length) this.setData({ hintCount: hintCount + 1, hintIndex: hintCount });
  },
  previousHint() { this.setData({ hintIndex: Math.max(0, this.data.hintIndex - 1) }); },
  nextHint() { this.setData({ hintIndex: Math.min(this.data.hintCount - 1, this.data.hintIndex + 1) }); },
  revealAnswer() {
    if (!this.data.soup) return;
    xhs.showModal({ title: this.data.t.reveal, content: this.data.t.revealConfirm,
      success: async (result) => {
        if (!result.confirm) return;
        try {
          const data = await request(`/api/soups/${encodeURIComponent(this.data.soup.id)}/answer?lang=${this.data.language}`, 'GET');
          this.setData({ answer: data.answer });
        } catch (error) { console.error('汤底获取失败', error); this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` }); }
      },
    });
  },
  async submitSoup() {
    if (this.data.busy) return;
    const form = this.data.form;
    if (![form.title, form.story, form.answer, form.hint1].every((value) => value.trim())) { this.setData({ notice: this.data.t.missing }); return; }
    this.setData({ busy: true, notice: '' });
    try {
      const result = await request('/api/soups', 'POST', {
        title: form.title.trim(), story: form.story.trim(), answer: form.answer.trim(),
        hints: [form.hint1, form.hint2, form.hint3].map((value) => value.trim()).filter(Boolean), language: this.data.language,
      });
      this.setData({ notice: result.message });
      if (result.status === 'published') {
        await this.loadSoups();
        this.chooseSoup({ currentTarget: { dataset: { id: result.soup.id } } });
        this.setData({ form: { title: '', story: '', answer: '', hint1: '', hint2: '', hint3: '' }, notice: result.message });
      }
    } catch (error) { console.error('题目审核失败', error); this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` }); }
    finally { this.setData({ busy: false }); }
  },

  // 分享参数只携带后端定义的稳定题目 ID。
  shareCurrentSoup() {
    const { soup, language } = this.data;
    return { title: soup ? `Jev · ${soup.title}` : 'Jev 海龟汤', path: 'pages/index/index',
      query: soup ? `soup=${encodeURIComponent(soup.id)}&lang=${language}` : `lang=${language}`,
      content: soup?.story || '来和 Jev 玩海龟汤' };
  },
  onShareAppMessage() { return this.shareCurrentSoup(); },
  onShareChat() { return this.shareCurrentSoup(); },
});
