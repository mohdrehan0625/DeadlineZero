// ─────────────────────────────────────────────────────────────────────────────
// DeadlineZero — Main Application
// ─────────────────────────────────────────────────────────────────────────────

// ── Config (merged from config.js defaults + localStorage overrides) ──────────
function getConfig() {
  return {
    GEMINI_API_KEY:  localStorage.getItem('dz_gemini_key')  || window.DEFAULT_CONFIG?.GEMINI_API_KEY  || '',
    GOOGLE_CLIENT_ID: localStorage.getItem('dz_client_id') || window.DEFAULT_CONFIG?.GOOGLE_CLIENT_ID || '',
    GOOGLE_API_KEY:  localStorage.getItem('dz_google_key') || window.DEFAULT_CONFIG?.GOOGLE_API_KEY   || '',
  };
}

// ── State ─────────────────────────────────────────────────────────────────────
let tasks = JSON.parse(localStorage.getItem('dz_tasks') || '[]');
let calendarConnected = false;
let gapiInited = false;
let gisInited = false;
let tokenClient = null;
let recognition = null;
let isListening = false;

// ── Persistence ───────────────────────────────────────────────────────────────
function saveTasks() {
  localStorage.setItem('dz_tasks', JSON.stringify(tasks));
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatCountdown(deadlineStr) {
  if (!deadlineStr) return null;
  const deadline = new Date(deadlineStr);
  const now = new Date();
  const diff = deadline - now;
  if (diff < 0) return { label: 'Overdue', cls: 'countdown-overdue' };
  const hours = Math.floor(diff / 36e5);
  const days  = Math.floor(diff / 864e5);
  if (hours < 24)  return { label: `${hours}h left`,  cls: 'countdown-urgent'  };
  if (days  < 3)   return { label: `${days}d left`,   cls: 'countdown-warning' };
  return               { label: `${days}d left`,   cls: 'countdown-ok'      };
}

function priorityClass(p) {
  const map = { critical: 'priority-critical', high: 'priority-high', medium: 'priority-medium', low: 'priority-low' };
  return map[(p || 'medium').toLowerCase()] || 'priority-medium';
}

function priorityScore(p) {
  const map = { critical: 100, high: 75, medium: 50, low: 25 };
  return map[(p || 'medium').toLowerCase()] || 50;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const colors = { success: 'text-emerald-400', error: 'text-red-400', info: 'text-brand-400' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="${colors[type]} font-bold">${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').prepend(el);
  setTimeout(() => el.style.opacity = '0', 3200);
  setTimeout(() => el.remove(), 3600);
}

// ── Error / Loading UI ────────────────────────────────────────────────────────
function showLoading(text = 'AI is analyzing your task...') {
  document.getElementById('loadingState').classList.remove('hidden');
  document.getElementById('loadingText').textContent = text;
  document.getElementById('errorState').classList.add('hidden');
}

function hideLoading() {
  document.getElementById('loadingState').classList.add('hidden');
}

function showError(msg, detail = '') {
  hideLoading();
  document.getElementById('errorState').classList.remove('hidden');
  document.getElementById('errorMessage').textContent = msg;
  document.getElementById('errorDetail').textContent = detail;
}

function closeError() {
  document.getElementById('errorState').classList.add('hidden');
}

// ── Gemini API ────────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const { GEMINI_API_KEY } = getConfig();
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key not configured. Click the gear icon to add it.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini error: ${msg}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini API');
  return JSON.parse(text);
}

async function breakdownTask(taskText) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `You are an expert productivity coach. Today is ${today}.

The user has this task with a deadline: "${taskText}"

Break this task down into 3-5 concrete, actionable subtasks. For each subtask, estimate how long it will take and assign a priority.

IMPORTANT: Infer the deadline date from the task text. If no year is given, assume the current or next occurrence.

Respond ONLY with valid JSON in this exact shape:
{
  "title": "short task title (5-8 words)",
  "deadline": "YYYY-MM-DDTHH:mm:ss",
  "priority": "high",
  "estimated_total_hours": 4,
  "subtasks": [
    {
      "id": "s1",
      "title": "Subtask title",
      "description": "What exactly to do",
      "priority": "high",
      "estimated_minutes": 60,
      "suggested_start": "YYYY-MM-DDTHH:mm:ss"
    }
  ]
}

Priority must be one of: critical, high, medium, low.
Subtask priorities should reflect urgency and importance.
Spread suggested_start times across the available days before the deadline, during working hours (9am-6pm).
`;

  return await callGemini(prompt);
}

// ── Add Task ──────────────────────────────────────────────────────────────────
async function addTask() {
  const input = document.getElementById('taskInput');
  const text  = input.value.trim();
  if (!text) { input.focus(); return; }

  const { GEMINI_API_KEY } = getConfig();
  if (!GEMINI_API_KEY) {
    showError('Gemini API key required', 'Click the gear icon (top right) → enter your Gemini API key → Save Settings.');
    openSettings();
    return;
  }

  closeError();
  showLoading('AI is breaking down your task...');
  document.getElementById('addBtn').disabled = true;
  input.disabled = true;

  try {
    const result = await breakdownTask(text);

    const task = {
      id: generateId(),
      rawInput: text,
      title: result.title || text,
      deadline: result.deadline,
      priority: result.priority || 'medium',
      estimatedHours: result.estimated_total_hours || 0,
      subtasks: (result.subtasks || []).map(s => ({
        ...s,
        id: s.id || generateId(),
        done: false,
        scheduledEventId: null,
      })),
      createdAt: new Date().toISOString(),
      collapsed: false,
    };

    tasks.unshift(task);
    saveTasks();
    input.value = '';
    renderDashboard();
    updateStats();
    showToast('Task analyzed and added!', 'success');

    if (calendarConnected) {
      scheduleSubtasksToCalendar(task);
    }

    scheduleReminders(task);
  } catch (err) {
    showError('Failed to analyze task', err.message);
  } finally {
    hideLoading();
    document.getElementById('addBtn').disabled = false;
    input.disabled = false;
  }
}

// ── Voice Input ───────────────────────────────────────────────────────────────
function toggleVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Voice input not supported in this browser. Try Chrome.', 'error');
    return;
  }

  if (isListening) {
    recognition?.stop();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    document.getElementById('voiceStatus').classList.remove('hidden');
    document.getElementById('voiceStatus').classList.add('flex');
    document.getElementById('voiceBtn').classList.add('voice-recording');
  };

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    document.getElementById('taskInput').value = transcript;
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') showToast('Voice error: ' + e.error, 'error');
    stopVoice();
  };

  recognition.onend = () => stopVoice();
  recognition.start();
}

function stopVoice() {
  isListening = false;
  document.getElementById('voiceStatus').classList.add('hidden');
  document.getElementById('voiceStatus').classList.remove('flex');
  document.getElementById('voiceBtn').classList.remove('voice-recording');
}

// ── Google Calendar ───────────────────────────────────────────────────────────
function initGoogleApi() {
  const { GOOGLE_CLIENT_ID, GOOGLE_API_KEY } = getConfig();
  if (!GOOGLE_CLIENT_ID || !GOOGLE_API_KEY) return;

  if (!window.gapi) {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      window.gapi.load('client', async () => {
        await window.gapi.client.init({ apiKey: GOOGLE_API_KEY, discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'] });
        gapiInited = true;
        maybeEnableCalendar();
      });
    };
    document.head.appendChild(script);
  }

  if (!window.google?.accounts?.oauth2) {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        callback: (resp) => {
          if (resp.error) { showToast('Calendar auth failed: ' + resp.error, 'error'); return; }
          calendarConnected = true;
          updateCalendarStatus(true);
          closeCalendarModal();
          showToast('Google Calendar connected!', 'success');
        },
      });
      gisInited = true;
      maybeEnableCalendar();
    };
    document.head.appendChild(script);
  }
}

function maybeEnableCalendar() {
  if (gapiInited && gisInited) {
    document.getElementById('calendarStatus').style.cursor = 'pointer';
  }
}

function connectGoogleCalendar() {
  const { GOOGLE_CLIENT_ID } = getConfig();
  if (!GOOGLE_CLIENT_ID) {
    openSettings();
    showToast('Add your Google Client ID first', 'error');
    return;
  }
  document.getElementById('calendarModal').classList.remove('hidden');
}

function closeCalendarModal() {
  document.getElementById('calendarModal').classList.add('hidden');
}

function authorizeCalendar() {
  if (!tokenClient) {
    initGoogleApi();
    showToast('Initializing Google API, try again in a moment...', 'info');
    return;
  }
  tokenClient.requestAccessToken({ prompt: '' });
}

function updateCalendarStatus(connected) {
  const dot = document.getElementById('calendarDot');
  const label = document.getElementById('calendarLabel');
  if (connected) {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    label.textContent = 'Calendar connected';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-gray-600';
    label.textContent = 'Connect Calendar';
  }
}

async function scheduleSubtasksToCalendar(task) {
  if (!calendarConnected || !window.gapi?.client?.calendar) return;

  for (const st of task.subtasks) {
    if (st.scheduledEventId || !st.suggested_start) continue;
    try {
      const start = new Date(st.suggested_start);
      const end   = new Date(start.getTime() + (st.estimated_minutes || 60) * 60000);

      const event = {
        summary: `[DeadlineZero] ${st.title}`,
        description: `${st.description || ''}\n\nTask: ${task.title}\nPriority: ${st.priority}`,
        start: { dateTime: start.toISOString() },
        end:   { dateTime: end.toISOString() },
        colorId: task.priority === 'critical' ? '11' : task.priority === 'high' ? '6' : '9',
      };

      const res = await window.gapi.client.calendar.events.insert({ calendarId: 'primary', resource: event });
      st.scheduledEventId = res.result.id;
    } catch (err) {
      console.warn('Failed to schedule subtask:', err);
    }
  }
  saveTasks();
  renderDashboard();
}

async function scheduleOneSubtask(taskId, subtaskId) {
  const task    = tasks.find(t => t.id === taskId);
  const subtask = task?.subtasks?.find(s => s.id === subtaskId);
  if (!task || !subtask) return;

  if (!calendarConnected) {
    connectGoogleCalendar();
    return;
  }

  try {
    await scheduleSubtasksToCalendar({ ...task, subtasks: [subtask] });
    showToast('Subtask scheduled in Calendar!', 'success');
    renderDashboard();
  } catch (e) {
    showToast('Failed to schedule: ' + e.message, 'error');
  }
}

// ── Browser Notifications ─────────────────────────────────────────────────────
function requestNotificationPermission() {
  if (!('Notification' in window)) { showToast('Notifications not supported', 'error'); return; }
  Notification.requestPermission().then(p => {
    if (p === 'granted') {
      showToast('Notifications enabled!', 'success');
      document.getElementById('notifBtn').classList.add('hidden');
    }
  });
}

function scheduleReminders(task) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!task.deadline) return;

  const deadline = new Date(task.deadline);
  const now = new Date();
  const diff = deadline - now;
  if (diff <= 0) return;

  const reminders = [
    { offset: 24 * 36e5, label: '24 hours' },
    { offset:  2 * 36e5, label: '2 hours' },
    { offset: 30 * 60000, label: '30 minutes' },
  ];

  reminders.forEach(({ offset, label }) => {
    const fireAt = diff - offset;
    if (fireAt > 0) {
      setTimeout(() => {
        new Notification(`⏰ DeadlineZero: ${task.title}`, {
          body: `Deadline in ${label}! You have ${task.subtasks.filter(s => !s.done).length} subtasks remaining.`,
          icon: '/favicon.svg',
          tag: `dz-${task.id}-${offset}`,
        });
      }, fireAt);
    }
  });
}

// ── Subtask completion ────────────────────────────────────────────────────────
function toggleSubtask(taskId, subtaskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  const sub = task.subtasks.find(s => s.id === subtaskId);
  if (!sub) return;
  sub.done = !sub.done;
  saveTasks();
  renderDashboard();
  updateStats();
  if (sub.done) showToast('Subtask completed!', 'success');
}

function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  saveTasks();
  renderDashboard();
  updateStats();
  showToast('Task deleted', 'info');
}

function toggleCollapse(id) {
  const task = tasks.find(t => t.id === id);
  if (task) task.collapsed = !task.collapsed;
  saveTasks();
  renderDashboard();
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const container = document.getElementById('taskDashboard');
  const empty     = document.getElementById('emptyState');
  const statsBar  = document.getElementById('statsBar');

  if (tasks.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    statsBar.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  statsBar.classList.remove('hidden');

  container.innerHTML = tasks.map(task => renderTaskCard(task)).join('');
}

function renderTaskCard(task) {
  const countdown = task.deadline ? formatCountdown(task.deadline) : null;
  const completedCount = task.subtasks.filter(s => s.done).length;
  const totalCount     = task.subtasks.length;
  const progress       = totalCount ? Math.round(completedCount / totalCount * 100) : 0;
  const isCompleted    = progress === 100;
  const pClass         = priorityClass(task.priority);
  const score          = priorityScore(task.priority);
  const isCollapsed    = task.collapsed;

  const deadlineStr = task.deadline
    ? new Date(task.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'No deadline';

  return `
  <div class="task-card animate-slide-up ${isCompleted ? 'completed' : ''}">
    <div class="task-header" onclick="toggleCollapse('${task.id}')">
      <div class="flex-1 min-w-0">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="priority-badge ${pClass}">${task.priority}</span>
          <span class="text-xs text-gray-500 font-semibold">Score ${score}</span>
          ${countdown ? `<span class="countdown ${countdown.cls}">${countdown.label}</span>` : ''}
          ${isCompleted ? '<span class="text-xs text-emerald-400 font-semibold">✓ Done</span>' : ''}
        </div>
        <h3 class="text-sm font-semibold text-white leading-snug line-clamp-2 mb-1">${escapeHtml(task.title)}</h3>
        <div class="flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <span>📅 ${deadlineStr}</span>
          ${task.estimatedHours ? `<span>⏱ ~${task.estimatedHours}h</span>` : ''}
          <span>${completedCount}/${totalCount} subtasks</span>
        </div>
        <div class="mt-3 progress-bar-bg">
          <div class="progress-bar-fill" style="width:${progress}%"></div>
        </div>
      </div>
      <div class="flex flex-col items-end gap-2 ml-2">
        <button onclick="event.stopPropagation();deleteTask('${task.id}')" class="text-gray-700 hover:text-red-400 transition-colors" title="Delete task">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
        <svg class="w-4 h-4 chevron ${isCollapsed ? '' : 'open'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </div>
    </div>

    ${!isCollapsed ? `
    <div class="subtask-list">
      ${task.subtasks.map(st => renderSubtask(task.id, st)).join('')}
    </div>
    ` : ''}
  </div>`;
}

function renderSubtask(taskId, st) {
  const pClass = priorityClass(st.priority);
  const mins   = st.estimated_minutes || 0;
  const timeStr = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}` : `${mins}m`;

  const startStr = st.suggested_start
    ? new Date(st.suggested_start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';

  return `
  <div class="subtask-item">
    <div class="subtask-checkbox ${st.done ? 'checked' : ''}" onclick="toggleSubtask('${taskId}', '${st.id}')">
      ${st.done ? '<svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>' : ''}
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex flex-wrap items-center gap-1.5 mb-0.5">
        <span class="text-sm font-medium text-${st.done ? 'gray-500 line-through' : 'white'}">${escapeHtml(st.title)}</span>
        <span class="priority-badge ${pClass}">${st.priority}</span>
      </div>
      ${st.description ? `<p class="text-xs text-gray-500 mb-1.5 line-clamp-2">${escapeHtml(st.description)}</p>` : ''}
      <div class="flex flex-wrap items-center gap-2">
        ${mins ? `<span class="text-xs text-gray-600">⏱ ${timeStr}</span>` : ''}
        ${startStr ? `<span class="text-xs text-gray-600">📅 ${startStr}</span>` : ''}
        <button
          onclick="scheduleOneSubtask('${taskId}', '${st.id}')"
          class="cal-btn ${st.scheduledEventId ? 'scheduled' : ''}"
          ${st.scheduledEventId ? 'title="Scheduled in Calendar"' : 'title="Add to Calendar"'}
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
          </svg>
          ${st.scheduledEventId ? 'Scheduled' : 'Schedule'}
        </button>
      </div>
    </div>
  </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const total     = tasks.length;
  const completed = tasks.filter(t => t.subtasks.length > 0 && t.subtasks.every(s => s.done)).length;
  const pending   = total - completed;
  const now       = new Date();
  const urgent    = tasks.filter(t => {
    if (!t.deadline) return false;
    return (new Date(t.deadline) - now) < 864e5 && !t.subtasks.every(s => s.done);
  }).length;

  document.getElementById('statTotal').textContent     = total;
  document.getElementById('statPending').textContent   = pending;
  document.getElementById('statCompleted').textContent = completed;
  document.getElementById('statUrgent').textContent    = urgent;
}

// ── Settings ──────────────────────────────────────────────────────────────────
function openSettings() {
  const cfg = getConfig();
  document.getElementById('settingsGeminiKey').value = cfg.GEMINI_API_KEY;
  document.getElementById('settingsClientId').value  = cfg.GOOGLE_CLIENT_ID;
  document.getElementById('settingsGoogleKey').value = cfg.GOOGLE_API_KEY;
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function saveSettings() {
  const gemini   = document.getElementById('settingsGeminiKey').value.trim();
  const clientId = document.getElementById('settingsClientId').value.trim();
  const gKey     = document.getElementById('settingsGoogleKey').value.trim();

  if (gemini)   localStorage.setItem('dz_gemini_key', gemini);
  if (clientId) localStorage.setItem('dz_client_id', clientId);
  if (gKey)     localStorage.setItem('dz_google_key', gKey);

  closeSettings();
  showToast('Settings saved!', 'success');

  if (clientId || gKey) initGoogleApi();
}

// ── Inline API Key ────────────────────────────────────────────────────────────
function saveInlineApiKey() {
  const val = document.getElementById('inlineApiKey').value.trim();
  if (!val) { showToast('Please enter a valid API key', 'error'); return; }
  localStorage.setItem('dz_gemini_key', val);
  document.getElementById('apiKeyBanner').classList.add('hidden');
  showToast('Gemini API key saved — ready to go!', 'success');
}

function updateApiKeyBanner() {
  const { GEMINI_API_KEY } = getConfig();
  const banner = document.getElementById('apiKeyBanner');
  if (GEMINI_API_KEY) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

// ── Example chips ─────────────────────────────────────────────────────────────
function setExample(text) {
  document.getElementById('taskInput').value = text;
  document.getElementById('taskInput').focus();
}

// ── Notification permission prompt ────────────────────────────────────────────
function checkNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    document.getElementById('notifBtn').classList.remove('hidden');
  }
}

// ── Countdown refresh ─────────────────────────────────────────────────────────
setInterval(() => {
  if (tasks.length > 0) renderDashboard();
}, 60000);

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateApiKeyBanner();
  renderDashboard();
  updateStats();
  checkNotificationPermission();
  initGoogleApi();

  tasks.forEach(t => scheduleReminders(t));
});
