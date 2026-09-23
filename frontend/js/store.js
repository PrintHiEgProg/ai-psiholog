/* ==========================================================================
   Локальное хранилище: дневник настроения, настройки, лента разговора.
   Всё живёт только в браузере человека и никуда не отправляется.
   Любой доступ завёрнут в try/catch: в приватном режиме хранилище может
   быть недоступно, и страница должна работать без него.
   ========================================================================== */

const KEYS = {
  journal: 'tihiy-chas:journal',
  prefs: 'tihiy-chas:prefs',
  transcript: 'tihiy-chas:transcript',
  session: 'tihiy-chas:session',
  context: 'tihiy-chas:context',
  firstMessage: 'tihiy-chas:first-message',
};

function read(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(storage, key, value) {
  try {
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — работаем без него */
  }
}

/* --- дневник настроения (постоянно, localStorage) ---------------------- */

export const MOODS = [
  { value: 1, label: 'очень плохо' },
  { value: 2, label: 'плохо' },
  { value: 3, label: 'так себе' },
  { value: 4, label: 'нормально' },
  { value: 5, label: 'хорошо' },
];

export const FEELINGS = [
  'тревога',
  'грусть',
  'усталость',
  'злость',
  'одиночество',
  'растерянность',
  'обида',
  'стыд',
  'спокойствие',
  'радость',
];

export function moodLabel(value) {
  return MOODS.find((mood) => mood.value === value)?.label || '';
}

export function getJournal() {
  return read(localStorage, KEYS.journal, []);
}

export function addJournalEntry({ mood, feelings = [] }) {
  const journal = getJournal();
  journal.push({ at: Date.now(), mood, feelings });
  write(localStorage, KEYS.journal, journal.slice(-120));
  return journal;
}

/** Уточнить последнюю отметку (например, добавить чувства). */
export function updateLastJournalEntry(patch) {
  const journal = getJournal();
  if (!journal.length) return journal;
  journal[journal.length - 1] = { ...journal[journal.length - 1], ...patch };
  write(localStorage, KEYS.journal, journal);
  return journal;
}

export function clearJournal() {
  write(localStorage, KEYS.journal, null);
}

/* --- настройки ------------------------------------------------------------ */

export function getPrefs() {
  return { speak: false, ...read(localStorage, KEYS.prefs, {}) };
}

export function setPref(name, value) {
  write(localStorage, KEYS.prefs, { ...getPrefs(), [name]: value });
}

/* --- текущий разговор (только на время вкладки, sessionStorage) ---------- */

export function getSessionId() {
  return read(sessionStorage, KEYS.session, null);
}

export function setSessionId(id) {
  write(sessionStorage, KEYS.session, id);
}

export function getTranscript() {
  return read(sessionStorage, KEYS.transcript, []);
}

export function saveTranscript(items) {
  write(sessionStorage, KEYS.transcript, items.slice(-200));
}

export function getContext() {
  return read(sessionStorage, KEYS.context, null);
}

export function setContext(context) {
  write(sessionStorage, KEYS.context, context);
}

export function takeFirstMessage() {
  const text = read(sessionStorage, KEYS.firstMessage, null);
  write(sessionStorage, KEYS.firstMessage, null);
  return text;
}

export function setFirstMessage(text) {
  write(sessionStorage, KEYS.firstMessage, text);
}

export function clearConversation() {
  write(sessionStorage, KEYS.transcript, null);
  write(sessionStorage, KEYS.session, null);
  write(sessionStorage, KEYS.context, null);
}
