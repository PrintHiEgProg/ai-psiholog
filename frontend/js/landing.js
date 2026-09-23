/* ==========================================================================
   Лендинг: скролл-история.

   Главы (section.chapter[data-scene]) — точки маршрута. Какая глава сейчас
   пересекает «линию чтения», такая сцена и у фигуры: встречает, садится в
   кресло, дышит, думает. Смешивание позы и камеры делает сама сцена, поэтому
   прокрутка ощущается как непрерывное движение (аналог scrub у ScrollTrigger).
   ========================================================================== */

import { createCompanion } from './companion.js';
import { startBreathing } from './breath.js';
import { setFirstMessage } from './store.js';
import { TOPICS } from './topics.js';

const narrow = window.matchMedia('(max-width: 860px)');
const chapters = [...document.querySelectorAll('.chapter[data-scene]')];
const hint = document.getElementById('stage-hint');

/* --- темы ----------------------------------------------------------------- */

const grid = document.getElementById('topics-grid');
grid.innerHTML = TOPICS.map(
  (topic) =>
    `<a class="topic" href="/app?topic=${topic.id}"><strong>${topic.title}</strong><span>${topic.lead}</span></a>`
).join('');

/* --- первая фраза уезжает в разговор -------------------------------------- */

const form = document.getElementById('starter');
const input = document.getElementById('starter-input');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text) setFirstMessage(text);
  window.location.href = '/app';
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

/* --- сцена --------------------------------------------------------------- */

const head = await createCompanion(document.getElementById('crt-hero'), {
  track: true,
  interactive: true,
  scene: 'greet',
});

let activeChapter = null;
let breathing = null;

function linesOf(chapter) {
  return (chapter.dataset.lines || 'я здесь').split('|');
}

function activate(chapter) {
  if (chapter === activeChapter) return;
  activeChapter = chapter;

  // ушли с главы про дыхание — практика останавливается
  if (breathing && chapter.id !== 'try') breathing.stop();

  head.setScene(chapter.dataset.scene);
  if (!breathing) head.idle(linesOf(chapter));
  if ('wave' in chapter.dataset) head.wave();
}

/** Глава под «линией чтения»: на телефоне ниже — сверху её закрывает сцена. */
function pickChapter() {
  const line = window.innerHeight * (narrow.matches ? 0.68 : 0.5);
  let found = chapters[0];
  for (const chapter of chapters) {
    const rect = chapter.getBoundingClientRect();
    if (rect.top <= line) found = chapter;
  }
  return found;
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    activate(pickChapter());
    const max = document.documentElement.scrollHeight - window.innerHeight;
    head.setScroll(max > 0 ? window.scrollY / max : 0);
  });
}

await head.boot();
activate(pickChapter());
if (activeChapter === chapters[0]) head.wave();
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll, { passive: true });

// подсказка «нажмите — он помашет» исчезает после первого нажатия или сама
const hideHint = () => hint?.classList.add('is-hidden');
document.getElementById('crt-hero').addEventListener('click', hideHint, { once: true });
setTimeout(hideHint, 9000);

/* --- минута дыхания прямо на странице ------------------------------------ */

const startButton = document.getElementById('try-start');
const live = document.getElementById('try-live');
const phase = document.getElementById('try-phase');
const count = document.getElementById('try-count');
const done = document.getElementById('try-done');

function startTry() {
  if (breathing) return;
  startButton.hidden = true;
  done.hidden = true;
  live.hidden = false;

  breathing = startBreathing('even', {
    cycles: 6,
    onPhase: (state) => {
      phase.textContent = state.label;
    },
    onTick: (state) => {
      count.textContent = `${state.count} — круг ${state.cycle} из ${state.cycles}`;
      head.breathe(state);
    },
    onDone: ({ completed }) => {
      breathing = null;
      head.stopBreathing();
      live.hidden = true;
      if (completed) {
        done.hidden = false;
        head.nod();
      } else {
        startButton.hidden = false;
      }
      if (activeChapter) head.idle(linesOf(activeChapter));
    },
  });
}

startButton.addEventListener('click', startTry);

// «Подышать за минуту» в первом экране: доезжаем до главы и начинаем
document.querySelectorAll('[data-try]').forEach((link) =>
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const target = document.getElementById('try');
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    setTimeout(startTry, 700);
  })
);
