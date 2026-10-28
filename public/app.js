// AdaptLearn AI — Unified Action-Chat Feed Engine with LaTeX & Memory

let currentUsername = localStorage.getItem('adaptlearn_user') || 'alex';
let currentAcademicLevel = null;
let stagedImageFile = null;
let quizInstanceCounter = 0;
let pendingTopicSession = null;
let progressChartInstance = null;

/**
 * Universal Unicode and Emoji Unescaper
 * Converts raw unicode escapes (like \U0001f3af, \u{1f3af}, \u2705) into actual emojis.
 */
function decodeUnicodeEscapes(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\\U([0-9a-fA-F]{8})/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/\\u\{([0-9a-fA-F]+)\}/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/\\u([0-9a-fA-F]{4})/gi, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  // Configure marked if loaded
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,
      gfm: true
    });
  }
  initUser();
  loadAnalytics();
  loadHistorySidebar();
});

// ==================== 1. USER & PROFILE MANAGEMENT ====================
async function initUser() {
  updateUserUI(currentUsername, 0, null);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername })
    });
    const data = await res.json();
    if (data.success && data.student) {
      currentAcademicLevel = data.student.academic_level || null;
      updateUserUI(data.student.username, data.student.score, currentAcademicLevel);
    }
  } catch (err) {
    console.error('Failed to init student profile:', err);
  }
}

function updateUserUI(username, score = 0, level = null) {
  currentUsername = username;
  currentAcademicLevel = level;
  localStorage.setItem('adaptlearn_user', username);

  const headerUser = document.getElementById('headerUsername');
  const headerInitial = document.getElementById('avatarInitial');
  const headerScore = document.getElementById('headerScore');
  const sideScore = document.getElementById('sideScore');
  const modalInput = document.getElementById('modalUsernameInput');
  const levelPillText = document.getElementById('levelPillText');
  const sideAcademicLevel = document.getElementById('sideAcademicLevel');

  if (headerUser) headerUser.textContent = username;
  if (headerInitial) headerInitial.textContent = (username[0] || 'U').toUpperCase();
  if (headerScore) headerScore.textContent = `${score} pts`;
  if (sideScore) sideScore.textContent = score;
  if (modalInput) modalInput.value = username;

  if (level) {
    if (levelPillText) levelPillText.textContent = `Level: ${level}`;
    if (sideAcademicLevel) sideAcademicLevel.textContent = level;
  } else {
    if (levelPillText) levelPillText.textContent = 'Set Academic Level';
    if (sideAcademicLevel) sideAcademicLevel.textContent = 'Not Set';
  }
}

function openLoginModal() {
  document.getElementById('loginModal').classList.remove('hidden');
}

function closeLoginModal() {
  document.getElementById('loginModal').classList.add('hidden');
}

async function confirmLogin() {
  const input = document.getElementById('modalUsernameInput').value.trim();
  if (!input) return;
  closeLoginModal();
  updateUserUI(input, 0, null);
  await initUser();
  await loadAnalytics();
}

// ==================== 1b. SIDEBAR & LAYOUT CONTROLLERS ====================
function toggleSidebar() {
  const sidebar = document.getElementById('analyticsSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;

  if (window.innerWidth >= 1024) {
    // Desktop: collapse / expand in-flow column without overlap
    sidebar.classList.toggle('lg:hidden');
    if (progressChartInstance) {
      setTimeout(() => progressChartInstance.resize(), 150);
    }
  } else {
    // Mobile: drawer toggle
    const isClosed = sidebar.classList.contains('translate-x-full');
    if (isClosed) {
      sidebar.classList.remove('translate-x-full');
      if (backdrop) backdrop.classList.remove('hidden');
    } else {
      sidebar.classList.add('translate-x-full');
      if (backdrop) backdrop.classList.add('hidden');
    }
  }
}

function toggleHistorySidebar() {
  const historyBar = document.getElementById('historySidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!historyBar) return;

  if (window.innerWidth >= 1024) {
    // Desktop: collapse / expand in-flow column without overlap
    historyBar.classList.toggle('lg:hidden');
  } else {
    // Mobile: drawer toggle
    const isClosed = historyBar.classList.contains('-translate-x-full');
    if (isClosed) {
      historyBar.classList.remove('-translate-x-full');
      if (backdrop) backdrop.classList.remove('hidden');
    } else {
      historyBar.classList.add('-translate-x-full');
      if (backdrop) backdrop.classList.add('hidden');
    }
  }
}

function closeAllDrawers() {
  const historyBar = document.getElementById('historySidebar');
  const sidebar = document.getElementById('analyticsSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');

  if (historyBar) historyBar.classList.add('-translate-x-full');
  if (sidebar) sidebar.classList.add('translate-x-full');
  if (backdrop) backdrop.classList.add('hidden');
}

async function loadHistorySidebar() {
  const container = document.getElementById('historySessionsList');
  if (!container) return;
  try {
    const res = await fetch(`/api/history/${encodeURIComponent(currentUsername)}`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.sessions) || data.sessions.length === 0) {
      container.innerHTML = `
        <div class="p-4 text-center text-slate-400 text-xs">
          No prior sessions yet.
        </div>
      `;
      return;
    }

    container.innerHTML = data.sessions.map((s) => `
      <div class="flex items-center justify-between group p-1 rounded-xl hover:bg-slate-100 border border-transparent hover:border-slate-200 transition">
        <button type="button"
          onclick="sendQuickTopic('${escapeHtml(s.full_topic).replace(/'/g, "\\'")}')"
          class="flex items-center space-x-2 text-slate-700 truncate flex-1 text-left py-1.5 px-2">
          <span class="text-xs text-indigo-500 shrink-0">💬</span>
          <span class="truncate font-semibold text-xs group-hover:text-indigo-600">${escapeHtml(decodeUnicodeEscapes(s.topic))}</span>
        </button>
        <button type="button"
          onclick="deleteChatSession(event, '${escapeHtml(s.full_topic).replace(/'/g, "\\'")}')"
          title="Delete this chat session"
          class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600 p-1.5 rounded-lg transition shrink-0">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load history sessions:', err);
  }
}

async function deleteChatSession(event, topic) {
  if (event) event.stopPropagation();
  try {
    const res = await fetch('/api/chat/delete-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername, topic })
    });
    const data = await res.json();
    if (data.success) {
      await loadHistorySidebar();
      if (data.remaining_count === 0) {
        await startNewChat();
      }
    }
  } catch (err) {
    console.error('Failed to delete chat session:', err);
  }
}

function promptChangeLevel() {
  const custom = prompt(
    'Enter your Academic Level (e.g. High School, College 2nd Year, Beginner, Advanced):',
    currentAcademicLevel || 'College'
  );
  if (custom && custom.trim()) {
    setAcademicLevel(custom.trim());
  }
}

async function setAcademicLevel(level) {
  try {
    const res = await fetch('/api/level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername, level })
    });
    const data = await res.json();
    if (data.success && data.student) {
      currentAcademicLevel = data.student.academic_level;
      updateUserUI(currentUsername, data.student.score, currentAcademicLevel);
      loadAnalytics();
    }
  } catch (err) {
    console.error('Failed to set academic level:', err);
  }
}

// ==================== 2. NEW CHAT & CONTEXT RESET ====================
async function startNewChat() {
  try {
    const res = await fetch('/api/chat/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername })
    });
    const data = await res.json();
    console.log('[New Chat] Context memory reset on server:', data);

    // Reset Chat UI to initial welcome card
    const chatFeed = document.getElementById('chatFeed');
    chatFeed.innerHTML = `
      <div id="welcomeMessage" class="flex items-start space-x-3 max-w-3xl">
        <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center shrink-0 shadow-xs">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <div class="bg-white border border-slate-200 rounded-3xl rounded-tl-sm p-5 shadow-xs text-sm leading-relaxed text-slate-700 space-y-2.5">
          <div class="flex items-center space-x-2">
            <span class="font-bold text-slate-900">AdaptLearn AI Tutor</span>
            <span class="text-[10px] font-bold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">Context Memory Cleared</span>
          </div>
          <p>Context memory has been cleared! I am ready for a fresh topic or exercise calibrated to your <strong>${currentAcademicLevel || 'chosen'}</strong> standard:</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1">
            <div class="bg-slate-50 border border-slate-200/80 p-2.5 rounded-xl">
              <span class="font-bold text-indigo-700 block mb-0.5">🧠 Dynamic Quiz Mode</span>
              <span class="text-slate-500">Ask <em>"Give me a quiz on [topic]"</em> for an adaptive diagnostic quiz (3-15 questions) dynamically scaled by the AI Orchestrator.</span>
            </div>
            <div class="bg-slate-50 border border-slate-200/80 p-2.5 rounded-xl">
              <span class="font-bold text-purple-700 block mb-0.5">📖 Concept Explain Mode</span>
              <span class="text-slate-500">Ask <em>"Explain [topic]"</em> or ask a doubt for targeted resolution with LaTeX equations and analogies.</span>
            </div>
          </div>
        </div>
      </div>
    `;

    pendingTopicSession = null;
    clearStagedImage();
    const chatInput = document.getElementById('chatInput');
    if (chatInput) chatInput.value = '';
    await loadHistorySidebar();
    await loadAnalytics();
    scrollToBottom();
  } catch (err) {
    console.error('Failed to clear chat context:', err);
  }
}

// ==================== 3. LATEX & MARKDOWN RENDERING HELPER ====================
function formatMarkdownAndLatex(element) {
  if (!element) return;

  // 1. Run KaTeX auto-render if available
  if (typeof renderMathInElement === 'function') {
    try {
      renderMathInElement(element, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false,
        errorColor: '#f43f5e'
      });
    } catch (e) {
      console.warn('KaTeX auto-render notice:', e.message);
    }
  }
}

function parseMarkdownToHtml(rawText) {
  if (!rawText) return '';
  const decoded = decodeUnicodeEscapes(rawText);
  if (typeof marked !== 'undefined') {
    try {
      return marked.parse(decoded);
    } catch {
      return escapeHtml(decoded).replace(/\n/g, '<br>');
    }
  }
  return escapeHtml(decoded).replace(/\n/g, '<br>');
}

// ==================== 4. CHAT FEED & MESSAGE HANDLING ====================
function sendQuickTopic(topic) {
  document.getElementById('chatInput').value = topic;
  handleChatSubmit(new Event('submit'));
}

function handleFilePicked(event) {
  const file = event.target.files[0];
  if (!file) return;

  stagedImageFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('stagedImageThumb').src = e.target.result;
    document.getElementById('stagedImageName').textContent = file.name;
    document.getElementById('stagedImageContainer').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function clearStagedImage() {
  stagedImageFile = null;
  document.getElementById('chatFileInput').value = '';
  document.getElementById('stagedImageContainer').classList.add('hidden');
}

function showTyping(message = 'Gemini is diagnosing concepts...') {
  const indicator = document.getElementById('typingIndicator');
  const text = document.getElementById('typingText');
  text.textContent = message;
  indicator.classList.remove('hidden');
  scrollToBottom();
}

function hideTyping() {
  document.getElementById('typingIndicator').classList.add('hidden');
}

function scrollToBottom() {
  const chatFeed = document.getElementById('chatFeed');
  chatFeed.scrollTo({ top: chatFeed.scrollHeight, behavior: 'smooth' });
}

async function handleChatSubmit(event) {
  if (event && event.preventDefault) event.preventDefault();

  const chatInput = document.getElementById('chatInput');
  const userText = chatInput.value.trim();

  // Must have text or staged file
  if (!userText && !stagedImageFile) return;

  const currentFile = stagedImageFile;
  clearStagedImage();
  chatInput.value = '';

  // Render User Message Bubble
  renderUserMessage(userText, currentFile);

  // Prepare Payload
  try {
    let res;
    if (currentFile) {
      showTyping('Gemini Vision is inspecting your handwriting and diagrams...');
      const formData = new FormData();
      formData.append('image', currentFile);
      formData.append('username', currentUsername);
      formData.append('text', userText || 'Evaluate handwritten answer');
      formData.append('topic', userText ? userText.slice(0, 30) : 'Handwritten Assessment');

      res = await fetch('/api/chat', {
        method: 'POST',
        body: formData
      });
    } else {
      showTyping(`Processing with context memory (${currentAcademicLevel || 'Calibrating'})...`);
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUsername,
          text: userText,
          pending_topic: pendingTopicSession
        })
      });
    }

    const data = await res.json();
    hideTyping();

    if (!data.success) {
      renderSystemError(data.error || 'Failed to process request');
      return;
    }

    // Clear pending topic once resolved
    pendingTopicSession = null;

    // Render corresponding Widget / Message
    if (data.widget_type === 'ask_level') {
      pendingTopicSession = data.pending_topic || userText;
      renderAskLevelWidget(data);
    } else if (data.widget_type === 'level_confirmed') {
      currentAcademicLevel = data.academic_level;
      updateUserUI(currentUsername, 0, currentAcademicLevel);
      renderLevelConfirmedWidget(data);
      loadAnalytics();
    } else if (data.widget_type === 'explanation') {
      renderExplanationWidget(data);
    } else if (data.widget_type === 'quiz_batch') {
      renderQuizBatchWidget(data.topic, data.questions, data.academic_level, data.intro_message, data.orchestrator);
    } else if (data.widget_type === 'evaluation_card') {
      renderEvaluationWidget(data);
      loadAnalytics();
    }
  } catch (err) {
    hideTyping();
    console.error('Chat error:', err);
    renderSystemError('Connection error. Please try again.');
  }
}

// ==================== 5. WIDGET RENDERING WITH LATEX ====================

// A. User Message Bubble
function renderUserMessage(text, file) {
  const chatFeed = document.getElementById('chatFeed');
  const bubble = document.createElement('div');
  bubble.className = 'flex justify-end';

  let imageHtml = '';
  if (file) {
    const tempUrl = URL.createObjectURL(file);
    imageHtml = `
      <div class="mb-2 rounded-xl overflow-hidden border border-indigo-400/40 bg-black/10">
        <img src="${tempUrl}" alt="Uploaded image" class="max-h-48 max-w-xs object-cover rounded-xl">
      </div>
    `;
  }

  bubble.innerHTML = `
    <div class="max-w-md sm:max-w-lg bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-3xl rounded-tr-sm p-4 shadow-sm space-y-1">
      ${imageHtml}
      ${text ? `<div class="text-sm font-medium leading-relaxed">${escapeHtml(text)}</div>` : ''}
    </div>
  `;
  chatFeed.appendChild(bubble);
  scrollToBottom();
}

// B. Ask Academic Level Widget
function renderAskLevelWidget(data) {
  const chatFeed = document.getElementById('chatFeed');
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start space-x-3 max-w-3xl';

  const suggestions = data.dynamic_suggestions || ['High School', 'College', 'Beginner', 'Advanced'];
  const chipsHtml = suggestions.map((s) => `
    <button type="button"
      onclick="selectLevelChip('${escapeHtml(s)}')"
      class="bg-indigo-50 hover:bg-indigo-600 hover:text-white border border-indigo-200 text-indigo-700 text-xs font-bold px-3.5 py-1.5 rounded-xl transition shadow-2xs">
      🎓 ${escapeHtml(s)}
    </button>
  `).join('');

  wrapper.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center shrink-0 shadow-xs">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 14l9-5-9-5-9 5 9 5z"/></svg>
    </div>

    <div class="w-full bg-white border border-indigo-200/80 rounded-3xl rounded-tl-sm p-5 shadow-sm space-y-3">
      <div class="flex items-center space-x-2">
        <span class="text-xs font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2.5 py-0.5 rounded-full border border-indigo-100">
          Student Level Profiling
        </span>
      </div>

      <p class="text-sm font-semibold text-slate-800 leading-relaxed">${escapeHtml(data.message)}</p>

      <div class="pt-1">
        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">Select Your Standard:</span>
        <div class="flex flex-wrap gap-2">
          ${chipsHtml}
        </div>
      </div>
    </div>
  `;

  chatFeed.appendChild(wrapper);
  scrollToBottom();
}

function selectLevelChip(level) {
  document.getElementById('chatInput').value = level;
  handleChatSubmit(new Event('submit'));
}

// C. Level Confirmed Widget
function renderLevelConfirmedWidget(data) {
  const chatFeed = document.getElementById('chatFeed');
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start space-x-3 max-w-3xl';

  const suggestions = data.dynamic_suggestions || ['Quiz on C++', 'Explain Thermodynamics'];
  const chipsHtml = suggestions.map((s) => `
    <button type="button"
      onclick="sendQuickTopic('${escapeHtml(s)}')"
      class="bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 border border-slate-200 text-slate-700 text-xs font-medium px-3 py-1.5 rounded-xl transition">
      ${escapeHtml(s)}
    </button>
  `).join('');

  wrapper.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-500 text-white flex items-center justify-center shrink-0 shadow-xs">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
    </div>

    <div class="w-full bg-white border border-emerald-200 rounded-3xl rounded-tl-sm p-5 shadow-sm space-y-3">
      <p class="text-sm font-semibold text-slate-800 leading-relaxed">${escapeHtml(data.message)}</p>

      <div class="pt-1 flex flex-wrap gap-2">
        ${chipsHtml}
      </div>
    </div>
  `;

  chatFeed.appendChild(wrapper);
  scrollToBottom();
}

// D. Concept Explanation Widget (with Markdown & KaTeX Math Parsing)
function renderExplanationWidget(data) {
  const chatFeed = document.getElementById('chatFeed');
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start space-x-3 max-w-3xl';

  const suggestions = data.dynamic_suggestions || [`Take a Quiz on ${data.topic}`];
  const chipsHtml = suggestions.map((s) => `
    <button type="button"
      onclick="sendQuickTopic('${escapeHtml(s)}')"
      class="bg-indigo-50 hover:bg-indigo-600 hover:text-white border border-indigo-200 text-indigo-700 text-xs font-bold px-3.5 py-1.5 rounded-xl transition shadow-2xs">
      ⚡ ${escapeHtml(s)}
    </button>
  `).join('');

  const parsedHtml = parseMarkdownToHtml(data.explanation || '');

  wrapper.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-600 text-white flex items-center justify-center shrink-0 shadow-xs">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
    </div>

    <div class="w-full bg-white border border-slate-200 rounded-3xl rounded-tl-sm p-5 sm:p-6 shadow-sm space-y-4">
      <div class="flex items-center justify-between border-b border-slate-100 pb-3">
        <h4 class="text-sm font-bold text-slate-900 flex items-center space-x-2">
          <span>Conceptual Lesson:</span>
          <span class="text-indigo-600 font-extrabold">${escapeHtml(decodeUnicodeEscapes(data.topic))}</span>
        </h4>
        <span class="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2.5 py-0.5 rounded-full">
          ${escapeHtml(decodeUnicodeEscapes(data.academic_level || 'Academic Standard'))}
        </span>
      </div>

      <div class="chat-markdown text-sm text-slate-800 leading-relaxed" id="markdown-container-${++quizInstanceCounter}">
        ${parsedHtml}
      </div>

      <!-- Smart Dynamic Suggestions -->
      <div class="pt-2 border-t border-slate-100 space-y-2">
        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">Next Steps & Practice:</span>
        <div class="flex flex-wrap gap-2">
          ${chipsHtml}
        </div>
      </div>
    </div>
  `;

  chatFeed.appendChild(wrapper);

  // Trigger KaTeX Math Parsing
  const mdContainer = document.getElementById(`markdown-container-${quizInstanceCounter}`);
  formatMarkdownAndLatex(mdContainer);

  scrollToBottom();
}

// E. Quiz Batch Widget (Dynamic MCQs with LaTeX & Orchestrator Strategy)
function renderQuizBatchWidget(topic, questions, academicLevel, introMessage, orchestrator) {
  const chatFeed = document.getElementById('chatFeed');
  const instanceId = ++quizInstanceCounter;

  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start space-x-3 max-w-3xl';

  const letters = ['A', 'B', 'C', 'D'];
  const totalQuestions = questions.length;

  const questionsHtml = questions.map((q, qIndex) => {
    const qNum = qIndex + 1;
    const optionsHtml = q.options.map((opt, oIndex) => `
      <button type="button"
        onclick="selectOption(${instanceId}, ${qNum}, '${escapeHtml(opt).replace(/'/g, "\\'")}', this)"
        class="opt-btn-${instanceId}-${qNum} w-full text-left p-3 rounded-xl border border-slate-200 hover:border-indigo-400 bg-slate-50/70 hover:bg-indigo-50/40 text-slate-800 text-xs sm:text-sm font-medium transition flex items-start space-x-2.5">
        <span class="w-5 h-5 rounded-md bg-white border border-slate-300 font-bold text-xs flex items-center justify-center shrink-0 text-slate-600">
          ${letters[oIndex] || oIndex + 1}
        </span>
        <span class="leading-relaxed pt-0.5 quiz-opt-latex">${escapeHtml(opt)}</span>
      </button>
    `).join('');

    return `
      <div class="p-4 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-2.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-extrabold uppercase tracking-wider text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">
            Question ${qNum} of ${totalQuestions}
          </span>
          <span class="text-[10px] font-semibold text-slate-400 truncate max-w-[200px]">
            ${escapeHtml(q.concept_tested || topic)}
          </span>
        </div>

        <p class="text-sm font-bold text-slate-900 leading-snug quiz-q-latex">${escapeHtml(q.question)}</p>

        <div class="space-y-2 pt-1">
          ${optionsHtml}
        </div>
      </div>
    `;
  }).join('');

  wrapper.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center shrink-0 shadow-xs">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
    </div>

    <div id="quiz-card-${instanceId}" class="w-full bg-slate-100/90 border border-slate-200/90 rounded-3xl rounded-tl-sm p-4 sm:p-6 shadow-sm space-y-4">
      <div class="flex items-center justify-between border-b border-slate-200 pb-3">
        <div>
          <h3 class="text-sm font-bold text-slate-900 flex items-center space-x-2">
            <span>Diagnostic Quiz:</span>
            <span class="text-indigo-600 font-extrabold">${escapeHtml(topic)}</span>
          </h3>
          <p class="text-[11px] text-slate-500">${escapeHtml(introMessage || `Calibrated to ${academicLevel || 'College'} standard.`)}</p>
        </div>
        <span class="text-[10px] font-bold font-mono px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
          ${totalQuestions} Questions
        </span>
      </div>

      <div class="space-y-4 max-h-[600px] overflow-y-auto pr-1" id="quiz-scroll-${instanceId}">
        ${questionsHtml}
      </div>

      <!-- Action Button -->
      <div class="pt-2 flex items-center justify-between border-t border-slate-200">
        <span id="quiz-status-${instanceId}" class="text-xs text-slate-500 font-medium">0 of ${totalQuestions} selected</span>
        <button id="quiz-submit-btn-${instanceId}"
          onclick="submitQuizBatch(${instanceId})"
          disabled
          class="bg-indigo-600 disabled:bg-slate-300 disabled:cursor-not-allowed hover:bg-indigo-700 text-white font-bold text-xs sm:text-sm px-5 py-2.5 rounded-xl shadow-xs transition flex items-center space-x-2">
          <span>Submit Diagnostic Batch</span>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
        </button>
      </div>
    </div>
  `;

  // Store quiz questions in window cache
  window[`quiz_data_${instanceId}`] = {
    topic,
    academic_level: academicLevel,
    questions,
    selections: {}
  };

  chatFeed.appendChild(wrapper);

  // Render LaTeX math inside the quiz card questions and options
  const quizScroll = document.getElementById(`quiz-scroll-${instanceId}`);
  formatMarkdownAndLatex(quizScroll);

  scrollToBottom();
}

function selectOption(instanceId, qNum, optionText, btnElement) {
  const cache = window[`quiz_data_${instanceId}`];
  if (!cache || cache.submitted) return;

  // Unhighlight previous selections for this question
  const btns = document.querySelectorAll(`.opt-btn-${instanceId}-${qNum}`);
  btns.forEach((b) => {
    b.classList.remove('bg-indigo-50', 'border-indigo-500', 'text-indigo-950', 'ring-2', 'ring-indigo-300');
  });

  // Highlight this button
  btnElement.classList.add('bg-indigo-50', 'border-indigo-500', 'text-indigo-950', 'ring-2', 'ring-indigo-300');

  // Record selection
  cache.selections[qNum] = optionText;

  // Update Status & Enable submit button
  const count = Object.keys(cache.selections).length;
  const total = cache.questions.length;
  const statusElem = document.getElementById(`quiz-status-${instanceId}`);
  const submitBtn = document.getElementById(`quiz-submit-btn-${instanceId}`);

  if (statusElem) statusElem.textContent = `${count} of ${total} selected`;
  if (submitBtn) {
    if (count >= 1) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('disabled:bg-slate-300');
      submitBtn.classList.add('bg-indigo-600');
      if (count === total) {
        submitBtn.classList.add('animate-pulse');
      }
    }
  }
}

async function submitQuizBatch(instanceId) {
  const cache = window[`quiz_data_${instanceId}`];
  if (!cache || cache.submitted) return;
  cache.submitted = true;

  const submitBtn = document.getElementById(`quiz-submit-btn-${instanceId}`);
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.remove('animate-pulse');
    submitBtn.textContent = 'Evaluating...';
  }

  // Disable all options in the card
  const allBtns = document.getElementById(`quiz-card-${instanceId}`).querySelectorAll('button');
  allBtns.forEach((b) => (b.disabled = true));

  showTyping('Synthesizing cross-question diagnostic gap analysis with Gemini...');

  const batchAnswers = cache.questions.map((q, idx) => ({
    id: q.id,
    question: q.question,
    selected_option: cache.selections[idx + 1] || '',
    correct_option: q.correct_option,
    concept_tested: q.concept_tested
  }));

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: currentUsername,
        topic: cache.topic,
        batch_answers: batchAnswers
      })
    });
    const data = await res.json();
    hideTyping();

    if (data.stats && data.stats.score !== undefined) {
      updateUserUI(currentUsername, data.stats.score, currentAcademicLevel);
    }

    // Visually decorate the options inside the quiz card (green/red)
    cache.questions.forEach((q, idx) => {
      const qNum = idx + 1;
      const chosen = cache.selections[qNum] || '';
      const isCorrect = chosen.trim().toLowerCase() === q.correct_option.trim().toLowerCase();
      const btns = document.querySelectorAll(`.opt-btn-${instanceId}-${qNum}`);

      btns.forEach((b) => {
        const text = b.textContent;
        if (text.includes(q.correct_option)) {
          b.classList.remove('border-slate-200', 'bg-slate-50/70');
          b.classList.add('bg-emerald-50', 'border-emerald-500', 'text-emerald-900', 'font-bold');
        }
        if (!isCorrect && chosen && text.includes(chosen)) {
          b.classList.remove('border-slate-200', 'bg-slate-50/70');
          b.classList.add('bg-rose-50', 'border-rose-400', 'text-rose-900', 'ring-2', 'ring-rose-300');
        }
      });
    });

    // Render resulting widget
    if (data.is_all_correct) {
      renderSuccessWidget(data);
    } else {
      renderMicroLessonWidget(data);
    }

    loadAnalytics();
  } catch (err) {
    hideTyping();
    console.error('Batch submit error:', err);
    renderSystemError('Failed to analyze quiz batch.');
  }
}

// F. Micro-Lesson Alert Widget (with KaTeX and Smart Suggestions)
function renderMicroLessonWidget(data) {
  const chatFeed = document.getElementById('chatFeed');
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start space-x-3 max-w-3xl';
  const instanceId = ++quizInstanceCounter;

  const analysis = data.analysis || {};
  const blindSpot = analysis.blind_spot_tag || 'Conceptual Blind Spot';
  const suggestions = data.dynamic_suggestions || [`Practice Quiz on ${blindSpot}`, `Explain ${blindSpot}`];

  const chipsHtml = suggestions.map((s) => `
    <button type="button"
      onclick="sendQuickTopic('${escapeHtml(s)}')"
      class="bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-3.5 py-1.5 rounded-xl transition shadow-2xs">
      🎯 ${escapeHtml(s)}
    </button>
  `).join('');

  wrapper.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-rose-500 to-amber-500 text-white flex items-center justify-center shrink-0 shadow-xs">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
    </div>

    <div class="w-full bg-gradient-to-br from-rose-50/90 via-orange-50/80 to-amber-50/70 border-2 border-rose-300/80 rounded-3xl rounded-tl-sm p-5 sm:p-6 shadow-sm space-y-4" id="microlesson-box-${instanceId}">
      <div class="flex items-center justify-between border-b border-rose-200/80 pb-3">
        <div class="flex items-center space-x-2">
          <span class="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping"></span>
          <span class="text-xs font-extrabold uppercase tracking-wider text-rose-800 bg-rose-100 border border-rose-200 px-3 py-1 rounded-full">
            ⚠️ Diagnosed Blind Spot: ${escapeHtml(blindSpot)}
          </span>
        </div>
        <span class="text-[10px] text-rose-600 font-semibold bg-white/80 px-2 py-0.5 rounded-full border border-rose-200">
          Saved in Context Memory
        </span>
      </div>

      <!-- Micro-Lesson Explanation -->
      <div>
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center space-x-1.5">
          <span>💡 Targeted Micro-Lesson:</span>
        </h4>
        <div class="chat-markdown text-sm font-semibold text-slate-900 leading-relaxed">${parseMarkdownToHtml(analysis.micro_lesson || 'Review the core underlying mechanism.')}</div>
      </div>

      <!-- Real-World Analogy -->
      <div class="bg-white/95 rounded-2xl p-4 border border-rose-100 shadow-2xs space-y-1">
        <h5 class="text-xs font-bold uppercase tracking-wider text-indigo-700 flex items-center space-x-1.5">
          <span>🌍 Intuitive Analogy:</span>
        </h5>
        <div class="chat-markdown text-xs text-slate-600 leading-relaxed font-medium">${parseMarkdownToHtml(analysis.analogy || '')}</div>
      </div>

      <!-- Smart Remedial Suggestions -->
      <div class="pt-2 flex flex-wrap gap-2 items-center justify-between">
        <span class="text-[11px] text-slate-500">Smart Remedial Actions:</span>
        <div class="flex flex-wrap gap-1.5">
          ${chipsHtml}
        </div>
      </div>
    </div>
  `;

  chatFeed.appendChild(wrapper);

  // Parse LaTeX math in micro-lesson
  const box = document.getElementById(`microlesson-box-${instanceId}`);
  formatMarkdownAndLatex(box);

  scrollToBottom();
}

// G. Success Widget
function renderSuccessWidget(data) {
  const chatFeed = document.getElementById('chatFeed');
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start space-x-3 max-w-3xl';

  const suggestions = data.dynamic_suggestions || ['Take another Quiz', 'Explain a new topic'];
  const chipsHtml = suggestions.map((s) => `
    <button type="button"
      onclick="sendQuickTopic('${escapeHtml(s)}')"
      class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3.5 py-1.5 rounded-xl transition shadow-2xs">
      ${escapeHtml(s)}
    </button>
  `).join('');

  wrapper.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-500 text-white flex items-center justify-center shrink-0 shadow-xs">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
    </div>

    <div class="w-full bg-gradient-to-br from-emerald-50/90 to-teal-50/80 border border-emerald-300 rounded-3xl rounded-tl-sm p-5 shadow-xs space-y-3 text-emerald-950">
      <div class="flex items-center justify-between border-b border-emerald-200 pb-2.5">
        <div class="flex items-center space-x-2">
          <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
          <span class="text-xs font-extrabold uppercase tracking-wider text-emerald-800">
            Full Diagnostic Mastery!
          </span>
        </div>
        <span class="text-xs font-mono font-bold bg-white text-emerald-700 border border-emerald-200 px-2.5 py-0.5 rounded-full">
          +${data.score_awarded || 20} Points
        </span>
      </div>

      <p class="text-sm font-semibold">${escapeHtml(data.message || 'All diagnostic questions answered correctly.')}</p>

      <div class="pt-1 flex flex-wrap gap-2">
        ${chipsHtml}
      </div>
    </div>
  `;

  chatFeed.appendChild(wrapper);
  scrollToBottom();
}

// H. Evaluation Widget (Handwritten note / Diagram evaluation with LaTeX)
function renderEvaluationWidget(data) {
  const chatFeed = document.getElementById('chatFeed');
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start space-x-3 max-w-3xl';
  const instanceId = ++quizInstanceCounter;

  const ev = data.evaluation || {};
  const score = ev.score_out_of_10 || 7;
  const missing = Array.isArray(ev.missing_concepts) ? ev.missing_concepts : [];

  const missingHtml = missing.length > 0
    ? missing.map((m) => `<li class="bg-rose-50 border border-rose-200/80 text-rose-800 px-3 py-1.5 rounded-xl font-medium">• ${escapeHtml(m)}</li>`).join('')
    : '<li class="bg-emerald-50 text-emerald-800 px-3 py-1.5 rounded-xl font-medium">No technical omissions found. Excellent clarity!</li>';

  wrapper.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-600 text-white flex items-center justify-center shrink-0 shadow-xs">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
    </div>

    <div class="w-full bg-white border border-slate-200 rounded-3xl rounded-tl-sm p-5 sm:p-6 shadow-sm space-y-4" id="eval-box-${instanceId}">
      <div class="flex items-center justify-between border-b border-slate-100 pb-3">
        <h4 class="text-sm font-bold text-slate-900 flex items-center space-x-2">
          <span>Gemini Vision Assessment</span>
          <span class="text-[10px] font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200">
            Handwritten Work
          </span>
        </h4>
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full ${score >= 7 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}">
          ${score >= 7 ? 'Pass' : 'Needs Review'}
        </span>
      </div>

      <!-- Score Banner -->
      <div class="flex items-center space-x-4 bg-gradient-to-r from-indigo-50 to-purple-50 p-4 rounded-2xl border border-indigo-100">
        <div class="text-3xl font-extrabold text-indigo-700 font-mono">
          ${score}/10
        </div>
        <div>
          <h5 class="text-xs font-bold text-slate-800">${score >= 8 ? 'Exceptional Conceptual Articulation' : (score >= 6 ? 'Good Grasp with Minor Inaccuracies' : 'Foundational Blind Spots Detected')}</h5>
          <p class="text-[11px] text-slate-500">Graded against rigorous technical criteria</p>
        </div>
      </div>

      <!-- Missing Concepts -->
      <div>
        <h5 class="text-xs font-bold uppercase tracking-wider text-rose-600 mb-2 flex items-center space-x-1.5">
          <span>🎯 Missing Technical Concepts & Blind Spots:</span>
        </h5>
        <ul class="space-y-1.5 text-xs">
          ${missingHtml}
        </ul>
      </div>

      <!-- Ideal Concise Answer -->
      <div>
        <h5 class="text-xs font-bold uppercase tracking-wider text-emerald-700 mb-1 flex items-center space-x-1.5">
          <span>💡 Ideal Model Answer:</span>
        </h5>
        <div class="chat-markdown text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-xl p-3 leading-relaxed">
          ${parseMarkdownToHtml(ev.ideal_answer || 'Complete coverage of core principles.')}
        </div>
      </div>
    </div>
  `;

  chatFeed.appendChild(wrapper);

  // Render LaTeX math
  const box = document.getElementById(`eval-box-${instanceId}`);
  formatMarkdownAndLatex(box);

  scrollToBottom();
}

// I. System Error Bubble
function renderSystemError(message) {
  const chatFeed = document.getElementById('chatFeed');
  const bubble = document.createElement('div');
  bubble.className = 'flex items-start space-x-3 max-w-2xl';
  bubble.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0 font-bold">!</div>
    <div class="bg-rose-50 border border-rose-200 text-rose-800 text-xs font-medium p-3 rounded-2xl">
      ${escapeHtml(message)}
    </div>
  `;
  chatFeed.appendChild(bubble);
  scrollToBottom();
}

// ==================== 6. ANALYTICS DASHBOARD ====================
async function loadAnalytics() {
  try {
    const res = await fetch(`/api/analytics/${encodeURIComponent(currentUsername)}`);
    const data = await res.json();

    if (data.success) {
      const student = data.student || {};
      const gaps = data.knowledge_gaps || [];
      const logs = data.activity_logs || [];

      // Update Header & Sidebar Numbers
      const sideScore = document.getElementById('sideScore');
      const sideAccuracy = document.getElementById('sideAccuracy');
      const sideAttempts = document.getElementById('sideAttempts');
      const gapsCount = document.getElementById('gapsBadgeCount');
      const headerScore = document.getElementById('headerScore');
      const sideAcademicLevel = document.getElementById('sideAcademicLevel');
      const levelPillText = document.getElementById('levelPillText');

      if (sideScore) sideScore.textContent = student.score || 0;
      if (headerScore) headerScore.textContent = `${student.score || 0} pts`;
      if (sideAccuracy) sideAccuracy.textContent = `${student.accuracy || 0}%`;
      if (sideAttempts) sideAttempts.textContent = `${student.total_attempts || 0} attempts`;
      if (gapsCount) gapsCount.textContent = gaps.length;

      if (student.academic_level) {
        currentAcademicLevel = student.academic_level;
        if (sideAcademicLevel) sideAcademicLevel.textContent = student.academic_level;
        if (levelPillText) levelPillText.textContent = `Level: ${student.academic_level}`;
      } else {
        currentAcademicLevel = null;
        if (sideAcademicLevel) sideAcademicLevel.textContent = 'Not Set';
        if (levelPillText) levelPillText.textContent = 'Set Academic Level';
      }

      // Render Red Badges for Knowledge Gaps
      const gapsContainer = document.getElementById('sideGapsContainer');
      gapsContainer.innerHTML = '';

      if (gaps.length === 0) {
        gapsContainer.innerHTML = `
          <div class="w-full text-center py-4 text-xs text-slate-400 bg-slate-50 border border-slate-200 rounded-xl">
            🎉 No blind spots detected yet!
          </div>
        `;
      } else {
        gaps.forEach((gap) => {
          const gapName = typeof gap === 'string' ? gap : gap.concept || 'Unknown Gap';
          const badge = document.createElement('div');
          badge.className = 'inline-flex items-center space-x-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-200/90 text-rose-700 text-[11px] font-bold px-2.5 py-1 rounded-lg cursor-pointer transition';
          badge.title = 'Click to test this weak concept';
          badge.onclick = () => sendQuickTopic(`Give me a quiz on ${gapName}`);
          badge.innerHTML = `
            <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
            <span>${escapeHtml(gapName)}</span>
          `;
          gapsContainer.appendChild(badge);
        });
      }

      // Render Recent Diagnostic Logs
      const activityList = document.getElementById('sideActivityList');
      activityList.innerHTML = '';

      if (logs.length === 0) {
        activityList.innerHTML = `<div class="text-[11px] text-slate-400">No attempts logged yet.</div>`;
      } else {
        logs.slice(0, 8).forEach((l) => {
          const isCorrect = Boolean(l.is_correct);
          const item = document.createElement('div');
          item.className = 'p-2 rounded-xl bg-slate-50 border border-slate-200/70 space-y-0.5';
          item.innerHTML = `
            <div class="flex items-center justify-between text-[10px]">
              <span class="font-bold text-slate-800 truncate max-w-[130px]">${escapeHtml(l.topic || 'General')}</span>
              <span class="font-bold ${isCorrect ? 'text-emerald-600' : 'text-rose-600'}">
                ${isCorrect ? '✓ Mastered' : '✗ Blind Spot'}
              </span>
            </div>
            ${l.gap_concept ? `<div class="text-[10px] text-rose-600 font-semibold truncate">${escapeHtml(l.gap_concept)}</div>` : ''}
          `;
          activityList.appendChild(item);
        });
      }

      // Render Progress Curve Chart (Chart.js)
      renderProgressChart(logs, student);
    }
  } catch (err) {
    console.error('Failed to load analytics:', err);
  }
}

// Render Progress Chart via Chart.js
function renderProgressChart(logs, student) {
  const canvas = document.getElementById('progressChart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (progressChartInstance) {
    progressChartInstance.destroy();
    progressChartInstance = null;
  }

  const chronoLogs = Array.isArray(logs) ? [...logs].reverse() : [];
  let labels = [];
  let dataPoints = [];

  if (chronoLogs.length === 0) {
    labels = ['Baseline', 'Current'];
    dataPoints = [0, (student && student.score) ? student.score : 0];
  } else {
    let runningScore = 0;
    chronoLogs.forEach((l, idx) => {
      const topicName = l.topic ? (l.topic.length > 10 ? l.topic.slice(0, 8) + '..' : l.topic) : `#${idx + 1}`;
      labels.push(decodeUnicodeEscapes(topicName));
      if (l.is_correct) {
        runningScore += 10;
      }
      dataPoints.push(runningScore);
    });
  }

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 140);
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.35)');
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0.0)');

  progressChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Mastery Points',
        data: dataPoints,
        borderColor: '#4f46e5',
        backgroundColor: gradient,
        borderWidth: 2.5,
        fill: true,
        tension: 0.35,
        pointBackgroundColor: '#4f46e5',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 1.5,
        pointRadius: 3.5,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          titleFont: { size: 10, family: 'Plus Jakarta Sans' },
          bodyFont: { size: 11, family: 'Plus Jakarta Sans', weight: 'bold' },
          padding: 8,
          cornerRadius: 8,
          displayColors: false,
          callbacks: {
            label: (context) => `${context.parsed.y} Points`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { size: 8, family: 'Plus Jakarta Sans' },
            color: '#94a3b8',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 5
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f1f5f9' },
          ticks: {
            font: { size: 8, family: 'Plus Jakarta Sans' },
            color: '#94a3b8',
            precision: 0,
            stepSize: 10
          }
        }
      }
    }
  });
}

// Utility
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
