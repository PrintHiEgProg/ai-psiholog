/* ==========================================================================
   Голос: диктовка сообщения и чтение ответов вслух. Оба — встроенные API
   браузера, без серверов. Если браузер их не умеет, кнопки просто скрываются.
   ========================================================================== */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

/**
 * Диктовка. onText получает текущий распознанный текст (в том числе
 * промежуточный), onEnd — когда распознавание закончилось.
 */
export function listen({ onText, onEnd, onError }) {
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.lang = 'ru-RU';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onresult = (event) => {
    let text = '';
    for (const result of event.results) text += result[0].transcript;
    onText?.(text.trim());
  };
  recognition.onerror = (event) => onError?.(event.error);
  recognition.onend = () => onEnd?.();

  try {
    recognition.start();
  } catch (error) {
    onError?.(error.message);
    return null;
  }
  return recognition;
}

let cachedVoice = null;

function russianVoice() {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  cachedVoice =
    voices.find((voice) => voice.lang === 'ru-RU' && /google|milena|irina/i.test(voice.name)) ||
    voices.find((voice) => voice.lang?.startsWith('ru')) ||
    null;
  return cachedVoice;
}

if (canSpeak) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null;
  };
}

/** Прочитать текст вслух. Возвращает функцию остановки. */
export function speak(text, { onStart, onEnd } = {}) {
  if (!canSpeak || !text) return () => {};
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU';
  utterance.rate = 0.97;
  const voice = russianVoice();
  if (voice) utterance.voice = voice;
  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
  return () => window.speechSynthesis.cancel();
}

export function stopSpeaking() {
  if (canSpeak) window.speechSynthesis.cancel();
}
