// 原生小组件页面：题库、判题、投稿和个人记录共用 Cloudflare Worker。
const copy = {
  zh: { library: '题库', play: '开局', records: '记录', create: '出题', next: '换一题', share: '分享', tagline: '读汤面 · 向 Jev 提问 · 还原真相', hostIntro: '我是 Jev。请问一个可以用「是 / 否 / 无关」回答的问题。', askPlaceholder: '向 Jev 提一个问题…', solvePlaceholder: '写出你推断的完整真相…', send: '发送', hint: '提示', reveal: '看汤底', solve: '还原真相', exitSolve: '返回提问', answer: '汤底', confidence: '置信度', judging: 'Jev 正在判断…', reviewing: 'Jev 正在审核…', loading: '正在加载题库…', noSoups: '题库暂时为空', retry: '重试', played: '已答', completed: '已解出', attempted: '已尝试', total: '总题数', questions: '提问', times: '次', progressEmpty: '还没有答题记录，先选一道题吧。', title: '标题', story: '汤面', answerField: '汤底', hint1: '提示 1', hint2: '提示 2', hint3: '提示 3', submitReview: '提交并等待审核', createIntro: '写下谜面和真相，Jev 审核通过后会立刻公开。', revealConfirm: '看过汤底后，这道题的悬念就揭晓了。确定查看？', close: '很接近了，再想想关键原因。', notYet: '还没有猜到，继续提问吧。', uncertain: '这次无法确定，换个说法试试。', solved: '你还原了真相！', missing: '请填完标题、汤面、汤底和第一条提示。', authFailed: '小红书身份连接失败，请重试。', requestFailed: '连接失败，请重试。' },
  en: { library: 'Library', play: 'Play', records: 'History', create: 'Create', next: 'Next', share: 'Share', tagline: 'Read the setup · Ask Jev · Solve the mystery', hostIntro: 'I am Jev. Ask questions I can answer Yes, No, or Irrelevant.', askPlaceholder: 'Ask Jev a question…', solvePlaceholder: 'Explain the whole mystery…', send: 'Send', hint: 'Hint', reveal: 'Reveal', solve: 'Solve', exitSolve: 'Back to questions', answer: 'Solution', confidence: 'Confidence', judging: 'Jev is thinking…', reviewing: 'Jev is reviewing…', loading: 'Loading puzzles…', noSoups: 'No puzzles yet', retry: 'Retry', played: 'Played', completed: 'Solved', attempted: 'Attempted', total: 'Total', questions: 'Questions', times: '', progressEmpty: 'No history yet. Pick a puzzle to start.', title: 'Title', story: 'Setup', answerField: 'Solution', hint1: 'Hint 1', hint2: 'Hint 2', hint3: 'Hint 3', submitReview: 'Submit for review', createIntro: 'Write a setup and solution. Jev will review it before publication.', revealConfirm: 'This will reveal the solution. Continue?', close: 'Very close. Think about the key cause.', notYet: 'Not quite. Keep asking questions.', uncertain: 'Jev cannot tell this time. Try another wording.', solved: 'You solved the mystery!', missing: 'Fill in the title, setup, solution, and first hint.', authFailed: 'Xiaohongshu sign-in failed. Please retry.', requestFailed: 'Connection failed. Please retry.' },
};

// 把平台网络回调转换成 Promise；请求失败时保留服务器给出的原因。
function request(path, method, data, token) {
  return new Promise((resolve, reject) => xhs.request({
    url: `${getApp().globalData.apiBaseUrl}${path}`, method, data,
    header: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    success(response) {
      if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(response.data?.error || `HTTP ${response.statusCode}`));
      resolve(response.data);
    },
    fail: reject,
  }));
}

function login() {
  return new Promise((resolve, reject) => xhs.login({
    success(result) { result.code ? resolve(result.code) : reject(new Error('小红书未返回登录 code')); },
    fail: reject,
  }));
}

// 题库与记录使用同一份已答状态。
function decorate(soups, progress) {
  const byId = {};
  (progress?.soups || []).forEach((entry) => { byId[entry.soup_id] = entry; });
  return soups.map((soup) => ({ ...soup, state: byId[soup.id]?.solved_at ? 'solved' : byId[soup.id] ? 'played' : '' }));
}

Page({
  data: {
    language: 'zh', t: copy.zh, view: 'play', soups: [], currentId: '', soup: null,
    messages: [], solveMessages: [], solveOpen: false, question: '',
    hintCount: 0, hintIndex: 0, answer: '', notice: '', loading: true, busy: false,
    token: '', progress: null, form: { title: '', story: '', answer: '', hint1: '', hint2: '', hint3: '' },
  },

  onLoad(options) {
    const language = options.lang === 'en' ? 'en' : 'zh';
    this.sharedId = options.soup || '';
    this.setData({ language, t: copy[language] });
    this.initialize();
  },

  async initialize() {
    this.setData({ loading: true, notice: '' });
    try {
      const code = await login();
      const identity = await request('/api/auth/xiaohongshu', 'POST', { code });
      if (!identity.token) throw new Error('登录接口未返回 token');
      this.setData({ token: identity.token });
      await this.loadSoups();
      await this.loadProgress();
    } catch (error) {
      console.error('小组件初始化失败', error);
      this.setData({ notice: `${this.data.t.authFailed} ${error.message || ''}`, loading: false });
    }
  },

  async loadSoups() {
    const { language, token } = this.data;
    const result = await request(`/api/soups?lang=${language}`, 'GET', null, token);
    const soups = decorate(result.soups, this.data.progress);
    const chosen = soups.find((item) => item.id === this.sharedId)
      || soups.find((item) => item.id === this.data.currentId) || soups[0] || null;
    this.setData({ soups, currentId: chosen?.id || '', soup: chosen, loading: false });
    this.sharedId = '';
  },

  async loadProgress() {
    if (!this.data.token) return;
    try {
      const progress = await request(`/api/me/progress?lang=${this.data.language}`, 'GET', null, this.data.token);
      this.setData({ progress, soups: decorate(this.data.soups, progress) });
    } catch (error) {
      console.error('答题记录加载失败', error);
      this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` });
    }
  },

  retry() { this.initialize(); },
  dismissNotice() { this.setData({ notice: '' }); },
  async switchLanguage() {
    if (this.data.busy) return;
    const language = this.data.language === 'zh' ? 'en' : 'zh';
    this.setData({ language, t: copy[language], progress: null, notice: '', messages: [], solveMessages: [], answer: '', hintCount: 0 });
    try { await this.loadSoups(); await this.loadProgress(); }
    catch (error) { console.error('切换语言失败', error); this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` }); }
  },
  changeView(event) {
    const view = event.currentTarget.dataset.view;
    this.setData({ view });
    if (view === 'progress') this.loadProgress();
  },
  chooseSoup(event) {
    const soup = this.data.soups.find((item) => item.id === event.currentTarget.dataset.id);
    if (!soup) return;
    this.setData({ view: 'play', soup, currentId: soup.id, messages: [], solveMessages: [], solveOpen: false, question: '', hintCount: 0, hintIndex: 0, answer: '', notice: '' });
  },
  nextSoup() {
    const { soups, currentId } = this.data;
    if (!soups.length) return;
    const next = soups[(soups.findIndex((item) => item.id === currentId) + 1) % soups.length];
    this.chooseSoup({ currentTarget: { dataset: { id: next.id } } });
  },
  questionInput(event) { this.setData({ question: event.detail.value }); },
  formInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  openSolve() { this.setData({ solveOpen: true, question: '' }); },
  closeSolve() { this.setData({ solveOpen: false, question: '' }); },

  async send() {
    const { soup, question, token, language, solveOpen, busy } = this.data;
    const value = question.trim();
    if (!soup || !token || !value || busy) return;
    const key = solveOpen ? 'solveMessages' : 'messages';
    const items = [...this.data[key], { role: 'user', text: value }];
    this.setData({ [key]: items, question: '', busy: true });
    try {
      const endpoint = solveOpen ? 'solve' : 'judge';
      const payload = solveOpen ? { solution: value } : { question: value };
      const result = await request(`/api/soups/${encodeURIComponent(soup.id)}/${endpoint}?lang=${language}`, 'POST', payload, token);
      const verdict = solveOpen ? result.outcome : result.verdict;
      const solved = verdict === '破解成功' || verdict === 'Solved';
      const detail = solved ? this.data.t.solved
        : verdict === '接近真相' || verdict === 'Close' ? this.data.t.close
          : verdict === '还没猜对' || verdict === 'Not yet' ? this.data.t.notYet
            : verdict === '无法确定' || verdict === 'Uncertain' ? this.data.t.uncertain : '';
      this.setData({ [key]: [...items, { role: 'jev', verdict, confidence: Math.round(result.confidence * 100), detail, answer: result.answer || '' }] });
      await this.loadProgress();
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
          const data = await request(`/api/soups/${encodeURIComponent(this.data.soup.id)}/answer?lang=${this.data.language}`, 'GET', null, this.data.token);
          this.setData({ answer: data.answer });
        } catch (error) { console.error('汤底获取失败', error); this.setData({ notice: `${this.data.t.requestFailed} ${error.message || ''}` }); }
      },
    });
  },
  async submitSoup() {
    if (this.data.busy || !this.data.token) return;
    const form = this.data.form;
    if (![form.title, form.story, form.answer, form.hint1].every((value) => value.trim())) { this.setData({ notice: this.data.t.missing }); return; }
    this.setData({ busy: true, notice: '' });
    try {
      const result = await request('/api/soups', 'POST', {
        title: form.title.trim(), story: form.story.trim(), answer: form.answer.trim(),
        hints: [form.hint1, form.hint2, form.hint3].map((value) => value.trim()).filter(Boolean), language: this.data.language,
      }, this.data.token);
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
