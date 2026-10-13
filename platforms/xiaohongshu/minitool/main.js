/** 小红书小工具入口：离线题库、真实平台 AI、本地进度及用户主动分享。 */
(function () {
  'use strict';
  const data = window.JevMiniToolData;
  const PAGE_SIZE = 20;
  const STORAGE_MIN_VERSION = 9460;
  const LANGUAGE_KEY = 'jev-minitool-language';
  const PROGRESS_KEY = 'jev-minitool-progress';
  const ids = ['brand-name', 'language-button', 'library-button', 'next-button', 'share-button', 'library-dismiss', 'library-panel', 'library-search', 'library-list', 'library-page', 'previous-page', 'next-page', 'notice', 'tagline', 'soup-title', 'soup-story', 'solve-head', 'solve-title', 'exit-solve', 'chat', 'hint-card', 'hint-title', 'previous-hint', 'next-hint', 'hint-text', 'actions', 'hint-button', 'reveal-button', 'solve-button', 'composer', 'question', 'send-button'];
  const elements = {};
  ids.forEach(function (id) {
    elements[id] = document.getElementById(id);
    if (!elements[id]) throw new Error('缺少页面元素：' + id);
  });
  const state = { language: 'zh', soupId: '', messages: [], solutions: [], solveOpen: false, hintCount: 0, hintIndex: 0, revealed: false, busy: false, libraryPage: 0, records: {}, storage: 'memory', storageKeys: [], model: null };

  /** 所有模型输出按纯文本显示，避免把故事或回复当作页面代码。 */
  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }
  function copy() { return data.copy[state.language]; }
  function soups() { return data.library[state.language]; }
  function currentSoup() { return soups().find(function (soup) { return soup.id === state.soupId; }); }
  function notice(text) { elements.notice.textContent = text; elements.notice.hidden = !text; }
  function label(value) { return data.labels[state.language][value]; }
  function errorText(error) {
    if (error && (error.code === 'AI_NOT_ALLOWED' || error.errCode === 'AI_NOT_ALLOWED' || String(error.message || error.errMsg).indexOf('AI_NOT_ALLOWED') >= 0)) return copy().aiNotAllowed;
    return copy().requestFailed + ' ' + (error && (error.message || error.errMsg) || '');
  }

  /** 9.46+ 优先使用平台缓存；低版本按官方约定使用实际浏览器存储。 */
  async function initializeStorage() {
    const xhs = window.xhs;
    const miniTool = xhs && xhs.miniTool;
    let launchOptions = xhs && xhs.launchOptions;
    let buildVersion = Number(launchOptions && launchOptions.miniToolEnv && launchOptions.miniToolEnv.buildVersion) || 0;
    if (!buildVersion && miniTool && typeof miniTool.getLaunchOptions === 'function') {
      launchOptions = await miniTool.getLaunchOptions();
      buildVersion = Number(launchOptions && launchOptions.miniToolEnv && launchOptions.miniToolEnv.buildVersion) || 0;
    }
    if (Math.floor(buildVersion / 1000) >= STORAGE_MIN_VERSION && miniTool && typeof miniTool.getStorageInfo === 'function' && typeof miniTool.getStorage === 'function' && typeof miniTool.setStorage === 'function') {
      state.storage = 'platform';
      state.storageKeys = (await miniTool.getStorageInfo()).keys;
      return;
    }
    // 存储能力不可用时只保留本次页面进度，并明确告知玩家。
    try {
      const probe = 'jev-minitool-storage-probe';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      state.storage = 'browser';
    } catch (error) { console.error('本地存储不可用', error); notice(copy().storageUnavailable); }
  }
  async function readLocal(key) {
    if (state.storage === 'memory') return null;
    if (state.storage === 'platform') {
      if (state.storageKeys.indexOf(key) < 0) return null;
      const result = await window.xhs.miniTool.getStorage({ key: key });
      return result.data === null ? null : JSON.parse(result.data);
    }
    const serialized = window.localStorage.getItem(key);
    return serialized === null ? null : JSON.parse(serialized);
  }
  async function writeLocal(key, value) {
    if (state.storage === 'memory') return;
    const serialized = JSON.stringify(value);
    if (state.storage === 'platform') await window.xhs.miniTool.setStorage({ key: key, data: serialized });
    else window.localStorage.setItem(key, serialized);
  }

  /** 题库分页创建 DOM，每次最多显示二十条，避免一次渲染全部题目。 */
  function renderLibrary() {
    const query = elements['library-search'].value.trim().toLowerCase();
    const items = soups().filter(function (soup) { return soup.title.toLowerCase().indexOf(query) >= 0; });
    const pages = Math.ceil(items.length / PAGE_SIZE);
    state.libraryPage = Math.min(state.libraryPage, Math.max(0, pages - 1));
    const fragment = document.createDocumentFragment();
    items.slice(state.libraryPage * PAGE_SIZE, (state.libraryPage + 1) * PAGE_SIZE).forEach(function (soup) {
      const record = state.records[soup.id];
      const suffix = record ? ' · ' + (record.solved_at ? copy().completed : copy().played) : '';
      const button = textElement('button', 'library-option' + (soup.id === state.soupId ? ' selected' : ''), soup.title + suffix);
      button.type = 'button';
      button.addEventListener('click', function () { if (!state.busy) chooseSoup(soup.id); });
      fragment.appendChild(button);
    });
    if (!items.length) fragment.appendChild(textElement('p', 'thinking', copy().noMatches));
    elements['library-list'].textContent = '';
    elements['library-list'].appendChild(fragment);
    elements['library-page'].textContent = (pages ? state.libraryPage + 1 : 0) + ' / ' + pages;
    elements['previous-page'].disabled = state.libraryPage === 0;
    elements['next-page'].disabled = !pages || state.libraryPage >= pages - 1;
  }
  function closeLibrary() { elements['library-panel'].hidden = true; elements['library-dismiss'].hidden = true; }
  function addAnswer(parent, answer) {
    const box = textElement('div', 'answer', '');
    box.appendChild(textElement('b', '', copy().answer));
    box.appendChild(document.createTextNode(answer));
    parent.appendChild(box);
  }
  function renderChat() {
    const fragment = document.createDocumentFragment();
    const thread = state.solveOpen ? state.solutions : state.messages;
    if (!thread.length) {
      const intro = textElement('div', 'host', '');
      if (!state.solveOpen) intro.appendChild(textElement('span', 'avatar', '🐢'));
      intro.appendChild(document.createTextNode(state.solveOpen ? copy().solveIntro : copy().hostIntro));
      fragment.appendChild(intro);
    }
    thread.forEach(function (entry) {
      const bubble = textElement('div', 'message ' + entry.role, entry.text || '');
      if (entry.verdict) {
        const head = textElement('div', 'message-head', '🐢 Jev');
        head.appendChild(textElement('span', 'badge', label(entry.verdict)));
        head.appendChild(textElement('span', 'confidence', copy().confidence + ' ' + Math.round(entry.confidence * 100) + '%'));
        bubble.appendChild(head);
        if (state.solveOpen) bubble.appendChild(document.createTextNode(data.details[state.language][entry.verdict]));
      }
      fragment.appendChild(bubble);
      if (entry.answer) addAnswer(fragment, entry.answer);
    });
    if (state.busy) fragment.appendChild(textElement('div', 'thinking', state.solveOpen ? copy().checking : copy().judging));
    if (!state.solveOpen && state.revealed) addAnswer(fragment, currentSoup().answer);
    elements.chat.textContent = '';
    elements.chat.appendChild(fragment);
    elements.chat.scrollTop = elements.chat.scrollHeight;
  }
  function render() {
    const t = copy();
    const soup = currentSoup();
    document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en';
    document.title = state.language === 'zh' ? 'Jev 海龟汤' : 'Jev Situation Puzzles';
    ['brand-name', 'tagline', 'next-button', 'share-button', 'solve-title', 'exit-solve', 'reveal-button', 'solve-button', 'send-button'].forEach(function (id, index) {
      elements[id].textContent = [t.brand, t.tagline, t.next, t.share, t.solve, t.exitSolve, t.reveal, t.solve, t.send][index];
    });
    elements['language-button'].textContent = state.language === 'zh' ? 'EN' : '中';
    elements['library-button'].textContent = t.library + ' ▾';
    elements['library-panel'].setAttribute('aria-label', t.library);
    elements['library-search'].placeholder = t.search;
    elements['previous-hint'].setAttribute('aria-label', t.previousHint);
    elements['next-hint'].setAttribute('aria-label', t.nextHint);
    elements['soup-title'].textContent = soup.title;
    elements['soup-story'].textContent = soup.story;
    elements['solve-head'].hidden = !state.solveOpen;
    elements.actions.hidden = state.solveOpen;
    elements['hint-card'].hidden = state.solveOpen || !state.hintCount;
    elements['hint-title'].textContent = t.hint + ' ' + (state.hintIndex + 1) + '/' + soup.hints.length;
    elements['hint-text'].textContent = soup.hints[state.hintIndex] || '';
    elements['hint-button'].textContent = t.hint + (state.hintCount ? ' ' + state.hintCount + '/' + soup.hints.length : '');
    elements.question.placeholder = state.solveOpen ? t.solvePlaceholder : t.askPlaceholder;
    elements.question.maxLength = state.solveOpen ? 1500 : 500;
    ['language-button', 'library-button', 'next-button', 'share-button', 'exit-solve', 'reveal-button', 'solve-button'].forEach(function (id) { elements[id].disabled = state.busy; });
    elements['hint-button'].disabled = state.busy || state.hintCount >= soup.hints.length;
    elements['previous-hint'].disabled = state.hintIndex === 0;
    elements['next-hint'].disabled = state.hintIndex >= state.hintCount - 1;
    elements['send-button'].disabled = state.busy || !state.model;
    renderChat();
  }
  function chooseSoup(id) {
    state.soupId = id;
    state.messages = [];
    state.solutions = [];
    state.solveOpen = false;
    state.hintCount = 0;
    state.hintIndex = 0;
    state.revealed = false;
    elements.question.value = '';
    closeLibrary();
    render();
  }
  function nextSoup() {
    const others = soups().filter(function (soup) { return soup.id !== state.soupId; });
    const unplayed = others.filter(function (soup) { return !state.records[soup.id]; });
    const pool = unplayed.length ? unplayed : others;
    if (pool.length) chooseSoup(pool[Math.floor(Math.random() * pool.length)].id);
  }

  /** 只使用平台真实 AI；返回 JSON 经枚举和概率校验后才能参与判题。 */
  async function judge(soup, input, solving, language) {
    const payload = { story: soup.story, answer: soup.answer, language: language };
    payload[solving ? 'solution' : 'question'] = input;
    const messages = [{ role: 'system', content: solving ? data.prompts.solution : data.prompts.question }, { role: 'user', content: JSON.stringify(payload) }];
    if (messages.reduce(function (length, message) { return length + message.content.length; }, 0) > 12000) throw new Error(copy().inputTooLong);
    const result = await state.model.generateText({ messages: messages, max_output_tokens: 512, temperature: 0 });
    const choice = result.choices && result.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (typeof content !== 'string' || !content) throw new Error(copy().invalidReply);
    const parsed = JSON.parse(content);
    const verdict = parsed[solving ? 'outcome' : 'verdict'];
    const allowed = solving ? ['Solved', 'Close', 'Not yet', 'Uncertain'] : ['Yes', 'No', 'Irrelevant', 'Uncertain'];
    if (allowed.indexOf(verdict) < 0 || typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) throw new Error(copy().invalidReply);
    console.log('平台 AI 判题完成', { task: solving ? 'solve' : 'question', request_id: result.request_id });
    return { verdict: parsed.confidence < 0.5 ? 'Uncertain' : verdict, confidence: parsed.confidence };
  }
  async function saveResult(soupId, result, solving) {
    const previous = state.records[soupId];
    const now = new Date().toISOString();
    state.records[soupId] = {
      question_count: (previous ? previous.question_count : 0) + (solving ? 0 : 1),
      last_outcome: solving ? result.verdict : previous ? previous.last_outcome : null,
      solved_at: previous && previous.solved_at || (solving && result.verdict === 'Solved' ? now : null),
      last_played_at: now,
    };
    try { await writeLocal(PROGRESS_KEY, state.records); }
    catch (error) { console.error('答题进度保存失败', error); notice(copy().storageFailed); }
  }
  async function send(event) {
    event.preventDefault();
    const input = elements.question.value.trim();
    if (!input || state.busy || !state.model) return;
    const soup = currentSoup();
    const solving = state.solveOpen;
    const thread = solving ? state.solutions : state.messages;
    thread.push({ role: 'user', text: input });
    elements.question.value = '';
    state.busy = true;
    render();
    try {
      const result = await judge(soup, input, solving, state.language);
      thread.push({ role: 'host', verdict: result.verdict, confidence: result.confidence, answer: solving && result.verdict === 'Solved' ? soup.answer : '' });
      await saveResult(soup.id, result, solving);
    } catch (error) {
      console.error('平台 AI 判题失败', error);
      thread.push({ role: 'host', text: errorText(error) });
    } finally { state.busy = false; render(); }
  }

  /** 用户点击分享后生成轻量汤面图片，由官方 API 唤起笔记发布页。 */
  async function shareSoup() {
    const miniTool = window.xhs && window.xhs.miniTool;
    if (!miniTool || typeof miniTool.postNote !== 'function') throw new Error(copy().shareUnavailable);
    const soup = currentSoup();
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 840;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(copy().shareUnavailable);
    context.fillStyle = '#052747'; context.fillRect(0, 0, 600, 840);
    context.fillStyle = '#7dd8c6'; context.font = 'bold 26px sans-serif'; context.fillText('Jev · ' + copy().brand, 40, 65);
    context.fillStyle = '#ffffff'; context.font = 'bold 24px sans-serif'; context.fillText(soup.title, 40, 116, 520);
    context.fillStyle = '#dce8f2'; context.font = '20px sans-serif';
    let line = '';
    let y = 165;
    Array.from(soup.story).some(function (character) {
      if (character === '\n' || context.measureText(line + character).width > 520) {
        context.fillText(line, 40, y); y += 31; line = '';
        if (y > 755) { context.fillText('…', 40, y); return true; }
        if (character === '\n') return false;
      }
      line += character;
      return false;
    });
    if (y <= 755) context.fillText(line, 40, y);
    await miniTool.postNote({ title: soup.title.slice(0, 20), content: (soup.story + '\n\n' + copy().shareInvitation).slice(0, 1000), mediaInfo: { image_resources: [{ url: canvas.toDataURL('image/png') }] } });
  }

  /** 跟随可见视口调整输入框位置；旧内核沿用百分比高度。 */
  function resizeViewport() {
    const viewport = window.visualViewport;
    if (viewport) document.documentElement.style.setProperty('--app-height', viewport.height + 'px');
  }
  elements.composer.addEventListener('submit', send);
  elements['next-button'].addEventListener('click', function () { if (!state.busy) nextSoup(); });
  elements['language-button'].addEventListener('click', async function () {
    if (state.busy) return;
    state.language = state.language === 'zh' ? 'en' : 'zh';
    state.libraryPage = 0;
    elements['library-search'].value = '';
    chooseSoup(state.soupId);
    try { await writeLocal(LANGUAGE_KEY, state.language); } catch (error) { console.error('语言保存失败', error); notice(copy().storageFailed); }
  });
  elements['library-button'].addEventListener('click', function () {
    if (state.busy) return;
    const opening = elements['library-panel'].hidden;
    elements['library-panel'].hidden = !opening;
    elements['library-dismiss'].hidden = !opening;
    if (opening) renderLibrary();
  });
  elements['library-dismiss'].addEventListener('click', closeLibrary);
  let searchTimer;
  elements['library-search'].addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { state.libraryPage = 0; renderLibrary(); }, 150); });
  elements['previous-page'].addEventListener('click', function () { state.libraryPage -= 1; renderLibrary(); });
  elements['next-page'].addEventListener('click', function () { state.libraryPage += 1; renderLibrary(); });
  elements['hint-button'].addEventListener('click', function () {
    if (state.hintCount < currentSoup().hints.length) { state.hintIndex = state.hintCount; state.hintCount += 1; render(); }
  });
  elements['previous-hint'].addEventListener('click', function () { state.hintIndex -= 1; render(); });
  elements['next-hint'].addEventListener('click', function () { state.hintIndex += 1; render(); });
  elements['reveal-button'].addEventListener('click', function () { if (window.confirm(copy().revealConfirm)) { state.revealed = true; render(); } });
  elements['solve-button'].addEventListener('click', function () { state.solveOpen = true; elements.question.value = ''; render(); });
  elements['exit-solve'].addEventListener('click', function () { state.solveOpen = false; elements.question.value = ''; render(); });
  elements['share-button'].addEventListener('click', function () { shareSoup().catch(function (error) { console.error('分享失败', error); notice(errorText(error)); }); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeViewport);
  window.addEventListener('resize', resizeViewport);
  resizeViewport();

  async function initialize() {
    state.soupId = soups()[Math.floor(Math.random() * soups().length)].id;
    render();
    await initializeStorage();
    const stored = await Promise.all([readLocal(LANGUAGE_KEY), readLocal(PROGRESS_KEY)]);
    if (stored[0] === 'zh' || stored[0] === 'en') state.language = stored[0];
    if (stored[1] !== null) state.records = stored[1];
    const ai = window.xhs && window.xhs.AI;
    if (ai && typeof ai.createModel === 'function') state.model = ai.createModel('deepseek-v4-flash');
    else notice(copy().aiUnavailable);
    render();
  }
  initialize().catch(function (error) { console.error('小工具初始化失败', error); notice(errorText(error)); });
}());
