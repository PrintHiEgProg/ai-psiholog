/* ==========================================================================
   Экран разговора.

   Лента — единственное, что прокручивается. Состояние разговора:
     transcript  — что показано в ленте (живёт в sessionStorage, переживает
                   перезагрузку вкладки);
     context     — что человек отметил сам: настроение, чувства, тема;
     sessionId   — id истории на сервере.
   ========================================================================== */

import { createCompanion } from './companion.js';
import { createTools, download, helplinesHtml } from './tools.js';
import { canListen, canSpeak, listen, speak, stopSpeaking } from './speech.js';
import { topicById } from './topics.js';
import {
  FEELINGS,
  addJournalEntry,
  clearConversation,
  getContext,
  getPrefs,
  getSessionId,
  getTranscript,
  moodLabel,
  saveTranscript,
  setContext,
  setPref,
  setSessionId,
  takeFirstMessage,
  updateLastJournalEntry,
} from './store.js';

const $ = (id) => document.getElementById(id);

const log = $('log');
const logInner = $('log-inner');
const empty = $('empty');
const form = $('composer');
const input = $('input');
const sendButton = $('send');
const micButton = $('mic');
const resetButton = $('reset');
const exportButton = $('export');
const speakToggle = $('speak-toggle');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const companionState = $('companion-state');
const collapseButton = $('stage-collapse');

const params = new URLSearchParams(location.search);
const topic = topicById(params.get('topic'));
const narrow = window.matchMedia('(max-width: 860px)');

let head = null;
let sessionId = getSessionId();
let transcript = getTranscript();
let context = getContext() || {};
let controller = null;
let streaming = false;
let lastUserText = '';
let recognition = null;
let prefs = getPrefs();

if (topic && !context.topic) {
  context = { ...context, topic: topic.title };
  setContext(context);
}

/* --------------------------------------------------------------- состояния */

const SEND_ICON = sendButton.innerHTML;
const STOP_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>';

let currentMood = 'listening';

function setMood(mood) {
  currentMood = mood;
  const moods = {
    listening: ['слушаю', () => head?.glyph()],
    thinking: ['думаю', () => head?.thinking()],
    talking: ['говорю', () => head?.talking()],
    offline: ['нет связи', () => head?.offline()],
  };
  const [label, run] = moods[mood] || moods.listening;
  companionState.textContent = label;
  run();
}

function setStreaming(active) {
  streaming = active;
  document.body.classList.toggle('is-streaming', active);
  input.disabled = active;
  sendButton.innerHTML = active ? STOP_ICON : SEND_ICON;
  sendButton.setAttribute('aria-label', active ? 'Остановить' : 'Отправить');
}

/* ------------------------------------------------------------------ лента */

function hideEmpty() {
  if (empty.isConnected) empty.remove();
}

function showEmpty() {
  logInner.replaceChildren(empty);
}

function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 140;
}

function scrollDown(force = false) {
  if (force || atBottom()) log.scrollTop = log.scrollHeight;
}

function remember(item) {
  transcript.push(item);
  saveTranscript(transcript);
}

function renderUser(text, animate = true) {
  hideEmpty();
  const node = document.createElement('div');
  node.className = `msg msg--user${animate ? ' msg--enter' : ''}`;
  node.textContent = text;
  logInner.append(node);
  scrollDown(true);
}

function renderBot(text) {
  hideEmpty();
  const node = document.createElement('div');
  node.className = 'msg msg--bot';
  node.textContent = text;
  logInner.append(node);
}

function renderNote(text, animate = true) {
  hideEmpty();
  const node = document.createElement('p');
  node.className = `msg msg--note${animate ? ' msg--enter' : ''}`;
  node.textContent = text;
  logInner.append(node);
  scrollDown(true);
}

function addNote(text) {
  renderNote(text);
  remember({ role: 'note', text });
}

function addBotMessage() {
  hideEmpty();
  const node = document.createElement('div');
  node.className = 'msg msg--bot msg--enter';
  const text = document.createElement('span');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  node.append(text, cursor);
  logInner.append(node);
  scrollDown(true);
  return {
    node,
    get text() {
      return text.textContent;
    },
    append(piece) {
      text.textContent += piece;
      scrollDown();
    },
    finish() {
      cursor.remove();
      if (!text.textContent.trim()) node.remove();
    },
  };
}

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Техническое сообщение в конце фразы: одна строка, с точкой на конце. */
function trimError(text) {
  const clean = String(text || 'неизвестная ошибка').trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function addNotice({ title, message, html = '', variant = '', keepEmpty = false, before = null, retry = false }) {
  if (!keepEmpty) hideEmpty();
  const node = document.createElement('div');
  node.className = `notice msg--enter ${variant}`;
  node.innerHTML =
    (title ? `<h2>${esc(title)}</h2>` : '') +
    (message ? `<p>${esc(message)}</p>` : '') +
    html +
    (retry ? '<button class="btn btn--quiet btn--small" type="button" data-retry>Отправить ещё раз</button>' : '');

  if (retry) {
    node.querySelector('[data-retry]').addEventListener('click', () => {
      node.remove();
      if (lastUserText) send(lastUserText, { resend: true });
    });
  }

  if (before?.isConnected) logInner.insertBefore(node, before);
  else if (keepEmpty && empty.isConnected) logInner.insertBefore(node, empty);
  else logInner.append(node);
  scrollDown(true);
  return node;
}

function renderCrisis(before = null) {
  return addNotice({
    before,
    variant: 'notice--crisis',
    title: 'Пожалуйста, не оставайтесь с этим одни',
    message:
      'Я всего лишь программа и в такой момент помочь по-настоящему не смогу. Позвоните — ответит живой человек.',
    html: helplinesHtml(),
  });
}

/** Лента после перезагрузки вкладки: всё, что было, без анимаций. */
function restoreTranscript() {
  if (!transcript.length) return;
  hideEmpty();
  transcript.forEach((item) => {
    if (item.role === 'user') renderUser(item.text, false);
    else if (item.role === 'bot') renderBot(item.text);
    else if (item.role === 'crisis') renderCrisis().classList.remove('msg--enter');
    else renderNote(item.text, false);
  });
  scrollDown(true);
}

/* --------------------------------------------------------------- отправка */

async function send(text, { resend = false } = {}) {
  if (streaming) return;
  const message = text.trim();
  if (!message) return;

  lastUserText = message;
  if (!resend) {
    renderUser(message);
    remember({ role: 'user', text: message });
  }
  input.value = '';
  resize();
  setStreaming(true);
  head?.nod();
  setMood('thinking');
  stopSpeaking();

  const bot = addBotMessage();
  let gotToken = false;
  controller = new AbortController();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        context: Object.keys(context).length ? context : undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      const detail = typeof data.detail === 'string' ? data.detail : '';
      throw new Error(detail || `Сервер ответил ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (payload.event === 'start' && payload.session_id) {
          sessionId = payload.session_id;
          setSessionId(sessionId);
        }

        if (payload.event === 'crisis') {
          // телефоны идут над ответом модели: в такой момент они важнее
          renderCrisis(bot.node);
          remember({ role: 'crisis' });
        }

        if (payload.event === 'token') {
          if (!gotToken) {
            gotToken = true;
            setMood('talking');
          }
          bot.append(payload.text);
        }

        if (payload.event === 'error') {
          bot.finish();
          addNotice({ title: 'Модель не ответила', message: payload.message, retry: true });
          setMood('offline');
          return;
        }
      }
    }

    bot.finish();
    const answer = bot.text.trim();
    if (answer) {
      remember({ role: 'bot', text: answer });
      readAloud(answer);
    } else {
      setMood('listening');
    }
  } catch (error) {
    bot.finish();
    if (error.name === 'AbortError') {
      if (bot.text.trim()) remember({ role: 'bot', text: bot.text.trim() });
      setMood('listening');
    } else {
      addNotice({
        title: 'Не получилось отправить',
        message: trimError(error.message),
        retry: true,
      });
      setMood('offline');
    }
  } finally {
    setStreaming(false);
    controller = null;
    if (!narrow.matches) input.focus();
  }
}

/* ------------------------------------------------------------ голос */

function readAloud(text) {
  if (!prefs.speak || !canSpeak) {
    setMood('listening');
    return;
  }
  speak(text, {
    onStart: () => setMood('talking'),
    onEnd: () => setMood('listening'),
  });
}

if (canSpeak) {
  speakToggle.hidden = false;
  speakToggle.setAttribute('aria-pressed', String(Boolean(prefs.speak)));
  speakToggle.addEventListener('click', () => {
    prefs = { ...prefs, speak: !prefs.speak };
    setPref('speak', prefs.speak);
    speakToggle.setAttribute('aria-pressed', String(prefs.speak));
    if (!prefs.speak) stopSpeaking();
  });
}

if (canListen) {
  micButton.hidden = false;
  micButton.addEventListener('click', () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    const before = input.value ? `${input.value.trim()} ` : '';
    micButton.classList.add('is-live');
    micButton.title = 'Остановить диктовку';
    recognition = listen({
      onText: (text) => {
        input.value = before + text;
        resize();
      },
      onEnd: () => {
        recognition = null;
        micButton.classList.remove('is-live');
        micButton.title = 'Надиктовать';
        input.focus();
      },
      onError: (reason) => {
        if (reason === 'not-allowed') {
          addNotice({ title: 'Нет доступа к микрофону', message: 'Разрешите микрофон в настройках браузера или напишите текстом.' });
        }
      },
    });
  });
}

/* ------------------------------------------------------------------ ввод */

function resize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function prefill(text) {
  input.value = text;
  resize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

input.addEventListener('input', resize);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (streaming) {
    controller?.abort();
    return;
  }
  tools.close();
  send(input.value);
});

/* --------------------------------------------------- отметка настроения */

function setMoodContext({ mood, feelings }) {
  context = { ...context, mood, feelings };
  setContext(context);
}

function bindCheckin() {
  const box = $('checkin');
  const feelingsBox = $('checkin-feelings');
  if (!box) return;

  feelingsBox.innerHTML = FEELINGS.map(
    (f) => `<button type="button" data-feeling="${esc(f)}" aria-pressed="false">${esc(f)}</button>`
  ).join('');

  box.querySelectorAll('[data-mood]').forEach((button) =>
    button.addEventListener('click', () => {
      const mood = Number(button.dataset.mood);
      const fresh = !context.mood;
      box.querySelectorAll('[data-mood]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      setMoodContext({ mood, feelings: context.feelings || [] });
      if (fresh) addJournalEntry({ mood, feelings: [] });
      else updateLastJournalEntry({ mood });
      feelingsBox.hidden = false;
      box.classList.add('is-done');
      head?.nod();
      companionState.textContent = moodLabel(mood);
      setTimeout(() => (companionState.textContent = 'слушаю'), 1800);
    })
  );

  feelingsBox.addEventListener('click', (event) => {
    const button = event.target.closest('[data-feeling]');
    if (!button) return;
    const feelings = new Set(context.feelings || []);
    const feeling = button.dataset.feeling;
    if (feelings.has(feeling)) feelings.delete(feeling);
    else if (feelings.size < 4) feelings.add(feeling);
    button.setAttribute('aria-pressed', String(feelings.has(feeling)));
    setMoodContext({ mood: context.mood, feelings: [...feelings] });
    updateLastJournalEntry({ feelings: [...feelings] });
  });
}

function renderStarters() {
  const chips = $('chips');
  const starters = topic?.starters || ['мне тревожно и не понимаю почему', 'не могу уснуть от мыслей', 'просто хочу выговориться'];
  chips.innerHTML = starters.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
  chips.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => send(chip.textContent)));

  const topicLine = $('empty-topic');
  if (topic) {
    topicLine.hidden = false;
    topicLine.textContent = `Тема: ${topic.title.toLowerCase()}. ${topic.lead}`;
  }
}

/* ------------------------------------------------------- шапка и сцена */

resetButton.addEventListener('click', async () => {
  controller?.abort();
  stopSpeaking();
  tools.close();
  try {
    const response = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const data = await response.json();
    sessionId = data.session_id;
  } catch {
    sessionId = null;
  }
  clearConversation();
  setSessionId(sessionId);
  transcript = [];
  context = topic ? { topic: topic.title } : {};
  setContext(context);
  showEmpty();
  $('checkin').classList.remove('is-done');
  $('checkin').querySelectorAll('[data-mood]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  $('checkin-feelings').hidden = true;
  bindCheckin();
  setMood('listening');
  head?.wave();
});

exportButton.addEventListener('click', () => {
  if (!transcript.length) {
    addNotice({ title: 'Пока нечего сохранять', message: 'Напишите хотя бы пару слов — и разговор можно будет скачать.', keepEmpty: true });
    return;
  }
  const date = new Date();
  const lines = transcript.map((item) => {
    if (item.role === 'user') return `Вы: ${item.text}`;
    if (item.role === 'bot') return `Тихий час: ${item.text}`;
    if (item.role === 'crisis') return '— Телефоны помощи: 112; +7 495 989-50-50; 8 800 2000-122';
    return `— ${item.text}`;
  });
  download(
    `tihiy-chas-${date.toISOString().slice(0, 10)}.txt`,
    `Тихий час — разговор от ${date.toLocaleString('ru-RU')}\n\n${lines.join('\n\n')}\n`
  );
});

/* свернуть сцену на телефоне: остаются голова и плечи, лента получает место */
let collapsedByUser = false;

function setCollapsed(collapsed) {
  document.body.classList.toggle('stage-collapsed', collapsed);
  collapseButton.setAttribute('aria-expanded', String(!collapsed));
  head?.setFrame(collapsed ? 'tight' : null);
}

collapseButton.addEventListener('click', () => {
  collapsedByUser = !document.body.classList.contains('stage-collapsed');
  setCollapsed(collapsedByUser);
});

// когда на телефоне открывается клавиатура, сцена сама уступает место
input.addEventListener('focus', () => {
  if (narrow.matches) setCollapsed(true);
});
input.addEventListener('blur', () => {
  if (narrow.matches && !collapsedByUser) setTimeout(() => setCollapsed(false), 150);
});
narrow.addEventListener('change', () => {
  if (!narrow.matches) setCollapsed(false);
});

/* ------------------------------------------------------------ практики */

const tools = createTools({
  companion: () => head,
  addNote,
  prefill,
  sessionId: () => sessionId,
  setMood: setMoodContext,
  // на телефоне текстовым практикам нужно место, дыханию — крупная фигура
  onSheet: (name) => {
    if (!narrow.matches || collapsedByUser) return;
    setCollapsed(Boolean(name) && name !== 'breath');
  },
});

/* --------------------------------------------------------------- запуск */

const PROVIDERS = {
  groq: 'Groq',
  openai: 'API',
  ollama: 'Ollama',
  demo: 'демо',
};

// Что делать, если модель не отвечает, — у каждого провайдера своё
const FIX_HINTS = {
  ollama: 'Запустите ollama serve и обновите страницу — или подключите бесплатный Groq: GROQ_API_KEY в .env.',
  groq: 'Проверьте GROQ_API_KEY в .env и интернет (Groq может быть недоступен без VPN).',
  openai: 'Проверьте LLM_BASE_URL, LLM_API_KEY и интернет.',
};

/** «llama-3.3-70b-versatile» → «llama-3.3-70b»: в шапке мало места. */
function shortModel(name) {
  return String(name || '').split('/').pop().replace(/-(versatile|instant|preview)$/, '').replace(/:free$/, '');
}

async function checkHealth() {
  let data = {};
  try {
    const response = await fetch('/api/health');
    data = await response.json();
    if (data.status !== 'up') throw new Error(data.detail || 'модель не отвечает');

    statusDot.dataset.state = 'up';
    if (data.provider === 'demo') {
      statusText.textContent = 'демо-режим';
      return true;
    }
    const label = `${PROVIDERS[data.provider] || 'модель'} · ${shortModel(data.model)}`;
    statusText.title = data.model;
    if (data.model_status === 'no') {
      statusText.textContent = `${shortModel(data.model)} не найдена`;
      addNotice({
        keepEmpty: true,
        title: 'Сервис не знает эту модель',
        message:
          data.provider === 'ollama'
            ? `Установите её: ollama pull ${data.model} (для облачных моделей сначала ollama signin) или укажите другую в .env.`
            : `Укажите в .env другую модель в LLM_MODEL, например: ${(data.models || []).slice(0, 4).join(', ')}.`,
      });
    } else {
      statusText.textContent = `${label} на связи`;
    }
    return true;
  } catch (error) {
    statusDot.dataset.state = 'down';
    statusText.textContent = 'модель недоступна';
    // с подстраховкой разговор всё равно пойдёт — на заготовленных ответах
    if (data.fallback) {
      statusText.textContent = 'демо-режим (нет связи)';
      return true;
    }
    addNotice({
      keepEmpty: true,
      title: 'Нет связи с моделью',
      message: `${FIX_HINTS[data.provider] || FIX_HINTS.ollama} Практики — дыхание, заземление, дневник — работают и без модели. Ответ сервера: ${trimError(error.message)}`,
    });
    return false;
  }
}

async function start() {
  renderStarters();
  bindCheckin();
  if (context.mood) {
    $('checkin').classList.add('is-done');
    $('checkin').querySelector(`[data-mood="${context.mood}"]`)?.setAttribute('aria-pressed', 'true');
  }
  restoreTranscript();
  resize();

  // 3D-сцена грузится параллельно: разговор её не ждёт. Когда фигура готова,
  // она подхватывает текущее состояние (слушает / думает / говорит).
  createCompanion($('crt-companion'), { track: true, scene: 'sit' }).then(async (companion) => {
    head = companion;
    if (narrow.matches && document.body.classList.contains('stage-collapsed')) head.setFrame('tight');
    await head.boot();
    setMood(currentMood);
    if (!transcript.length) head.wave();
  });

  const tool = params.get('tool');
  if (tool) tools.open(tool);

  const healthy = await checkHealth();
  if (!healthy) setMood('offline');

  const first = takeFirstMessage();
  if (first && healthy) send(first);
  else if (first) prefill(first);
}

start();
