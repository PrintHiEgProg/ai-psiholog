/* ==========================================================================
   Практики в разговоре. Открываются панелью поверх ленты; сама лента и
   разговор под панелью сохраняются. 3D-психолог участвует в практиках:
   дышит вместе с человеком, кивает, машет.

   createTools(api) → { open(name), close() }
   api: {
     companion()          — текущая 3D-сцена (или null, пока не загрузилась)
     addNote(text)        — тихая заметка в ленту
     prefill(text)        — подставить текст в поле ввода и поставить курсор
     sessionId()          — id разговора для итога
     setMood(context)     — сохранить отмеченное настроение как контекст
     onSheet(name|null)   — открылась или закрылась панель
   }
   ========================================================================== */

import { PATTERNS, startBreathing } from './breath.js';
import { FEELINGS, MOODS, addJournalEntry, clearJournal, getJournal, moodLabel } from './store.js';

const HELPLINES = [
  { phone: '112', title: 'Экстренные службы', note: 'Круглосуточно, бесплатно с любого телефона.' },
  { phone: '+7 495 989-50-50', title: 'Горячая линия психологической помощи МЧС', note: 'Круглосуточно.' },
  { phone: '8 800 2000-122', title: 'Детский телефон доверия', note: 'Для детей, подростков и родителей. Бесплатно.' },
];

const GROUND_STEPS = [
  { count: 5, sense: 'вижу', ask: 'Назовите пять вещей, которые сейчас видите.', hint: 'Цвет стены, чашка, свет из окна — любые мелочи.' },
  { count: 4, sense: 'могу потрогать', ask: 'Четыре вещи, которые можете потрогать.', hint: 'Ткань одежды, край стола, телефон в руке.' },
  { count: 3, sense: 'слышу', ask: 'Три звука вокруг.', hint: 'Даже тишина из чего-то состоит: гул, шаги, дыхание.' },
  { count: 2, sense: 'чувствую запах', ask: 'Два запаха.', hint: 'Если не чувствуете — вспомните любимые.' },
  { count: 1, sense: 'чувствую вкус', ask: 'Один вкус.', hint: 'Глоток воды или просто вкус во рту.' },
];

/** 1 круг, 2 круга, 5 кругов */
const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const telHref = (phone) => `tel:${phone.replace(/[^\d+]/g, '')}`;

export function helplinesHtml() {
  return `<ul class="helplines">${HELPLINES.map(
    (line) =>
      `<li><a href="${telHref(line.phone)}">${esc(line.phone)}</a><span>${esc(line.title)}. ${esc(line.note)}</span></li>`
  ).join('')}</ul>`;
}

export function createTools(api) {
  const thread = document.querySelector('.thread');
  const sheet = document.getElementById('sheet');
  const title = document.getElementById('sheet-title');
  const body = document.getElementById('sheet-body');
  const closeButton = document.getElementById('sheet-close');
  const toolButtons = [...document.querySelectorAll('[data-tool]')];

  let current = null;
  let cleanup = null;

  function show(name, heading, html) {
    cleanup?.();
    cleanup = null;
    current = name;
    title.textContent = heading;
    body.innerHTML = html;
    sheet.hidden = false;
    thread.classList.add('has-sheet');
    toolButtons.forEach((button) => button.setAttribute('aria-current', String(button.dataset.tool === name)));
    sheet.scrollTop = 0;
    api.onSheet?.(name);
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    cleanup?.();
    cleanup = null;
    current = null;
    sheet.hidden = true;
    thread.classList.remove('has-sheet');
    toolButtons.forEach((button) => button.setAttribute('aria-current', 'false'));
    api.onSheet?.(null);
  }

  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current) close();
  });
  toolButtons.forEach((button) =>
    button.addEventListener('click', () => {
      if (current === button.dataset.tool) close();
      else open(button.dataset.tool);
    })
  );

  /* --- дыхание ----------------------------------------------------------- */

  function openBreath(preset) {
    const cyclesFor = { box: 4, relax: 4, even: 6 };
    const minutes = (name) => {
      const pattern = PATTERNS[name];
      const seconds = pattern.phases.reduce((sum, p) => sum + p.seconds, 0) * cyclesFor[name];
      return Math.max(1, Math.round(seconds / 60));
    };

    show(
      'breath',
      'Подышать',
      `<p class="lead">Смотрите на экран психолога: круг растёт — вдох, сжимается — выдох. Около минуты, можно с закрытыми глазами — на телефоне смена фазы чувствуется вибрацией.</p>
       <div class="options">
         ${Object.entries(PATTERNS)
           .map(
             ([id, pattern]) =>
               `<button class="option" type="button" data-pattern="${id}"><strong>${esc(pattern.title)}, ${minutes(id)} мин</strong><span>${esc(pattern.hint)}</span></button>`
           )
           .join('')}
       </div>`
    );

    body.querySelectorAll('[data-pattern]').forEach((button) =>
      button.addEventListener('click', () => run(button.dataset.pattern))
    );
    if (preset) run(preset);

    function run(name) {
      const pattern = PATTERNS[name];
      body.innerHTML = `
        <div class="breath-live">
          <p class="breath-phase" id="breath-phase">приготовьтесь</p>
          <p class="breath-count" id="breath-count">${esc(pattern.title)}</p>
          <div class="progress" aria-hidden="true"><span id="breath-progress" style="transform: scaleX(0)"></span></div>
        </div>
        <div class="actions" style="justify-content:center">
          <button class="btn btn--quiet" type="button" id="breath-stop">Остановить</button>
        </div>`;

      const phase = body.querySelector('#breath-phase');
      const count = body.querySelector('#breath-count');
      const progress = body.querySelector('#breath-progress');

      const session = startBreathing(name, {
        cycles: cyclesFor[name],
        onPhase: (state) => {
          phase.textContent = state.label;
        },
        onTick: (state) => {
          count.textContent = `${state.count} — круг ${state.cycle} из ${state.cycles}`;
          progress.style.transform = `scaleX(${state.progress.toFixed(4)})`;
          api.companion()?.breathe(state);
        },
        onDone: ({ completed }) => {
          api.companion()?.stopBreathing();
          if (!completed) return;
          api.companion()?.nod();
          api.addNote(`Практика «${pattern.title}» — ${cyclesFor[name]} ${plural(cyclesFor[name], 'круг', 'круга', 'кругов')}`);
          body.innerHTML = `
            <div class="breath-live"><p class="breath-phase">готово</p><p class="breath-count">Как вы сейчас?</p></div>
            <div class="choice-row" style="justify-content:center">
              <button type="button" data-after="Стало немного легче после дыхания.">легче</button>
              <button type="button" data-after="Подышал(а), но по ощущениям так же.">так же</button>
              <button type="button" data-after="После дыхания стало даже тяжелее.">тяжелее</button>
            </div>
            <div class="actions" style="justify-content:center">
              <button class="btn btn--quiet" type="button" id="breath-again">Ещё раз</button>
            </div>`;
          body.querySelectorAll('[data-after]').forEach((button) =>
            button.addEventListener('click', () => {
              close();
              api.prefill(button.dataset.after);
            })
          );
          body.querySelector('#breath-again').addEventListener('click', () => run(name));
        },
      });

      body.querySelector('#breath-stop').addEventListener('click', () => {
        session.stop();
        openBreath();
      });
      cleanup = () => session.stop();
    }
  }

  /* --- заземление 5-4-3-2-1 ----------------------------------------------- */

  function openGround() {
    const answers = [];

    const step = (index) => {
      const item = GROUND_STEPS[index];
      show(
        'ground',
        'Заземлиться: 5-4-3-2-1',
        `<p class="lead">Помогает, когда накрывает тревога или мысли несутся по кругу: внимание возвращается в комнату, в тело, в «сейчас». Писать не обязательно — можно просто назвать про себя.</p>
         <div class="ground-step">
           <p class="ground-num">${item.count}</p>
           <p><strong>${esc(item.ask)}</strong><br /><span class="note">${esc(item.hint)}</span></p>
           <div class="ground-fields">
             ${Array.from({ length: item.count }, (_, i) =>
               `<input class="field" type="text" maxlength="60" aria-label="${esc(item.sense)} ${i + 1}" placeholder="${i + 1}" />`
             ).join('')}
           </div>
           <div class="actions">
             <button class="btn" type="button" id="ground-next">${index < GROUND_STEPS.length - 1 ? 'Дальше' : 'Готово'}</button>
             <span class="note">Шаг ${index + 1} из ${GROUND_STEPS.length}</span>
           </div>
         </div>`
      );
      api.companion()?.nod();

      const fields = [...body.querySelectorAll('.field')];
      fields[0]?.focus({ preventScroll: true });
      fields.forEach((field, i) =>
        field.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (fields[i + 1]) fields[i + 1].focus();
          else body.querySelector('#ground-next').click();
        })
      );

      body.querySelector('#ground-next').addEventListener('click', () => {
        const values = fields.map((field) => field.value.trim()).filter(Boolean);
        answers[index] = { sense: item.sense, values };
        if (index < GROUND_STEPS.length - 1) step(index + 1);
        else finish();
      });
    };

    const finish = () => {
      const lines = answers
        .filter((answer) => answer.values.length)
        .map((answer) => `${answer.sense}: ${answer.values.join(', ')}`);
      api.addNote('Практика «5-4-3-2-1» пройдена');
      api.companion()?.nod();
      show(
        'ground',
        'Вы здесь',
        `<p class="lead">Вы только что вернули внимание в настоящий момент. Если тревога ещё рядом — это нормально, её стало чуть меньше места.</p>
         ${lines.length ? `<ul class="note">${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}
         <div class="actions">
           <button class="btn" type="button" id="ground-share">Рассказать, как это было</button>
           <button class="btn btn--quiet" type="button" id="ground-close">Вернуться к разговору</button>
         </div>`
      );
      body.querySelector('#ground-share').addEventListener('click', () => {
        close();
        api.prefill('Сделал(а) упражнение 5-4-3-2-1. Сейчас чувствую ');
      });
      body.querySelector('#ground-close').addEventListener('click', close);
    };

    step(0);
  }

  /* --- настроение и дневник ---------------------------------------------- */

  function journalHtml() {
    const journal = getJournal();
    if (!journal.length) {
      return '<p class="note">Здесь появится ваш дневник: каждая отметка — столбик. Он хранится только в этом браузере.</p>';
    }
    const recent = journal.slice(-21);
    const average = recent.reduce((sum, e) => sum + e.mood, 0) / recent.length;
    const top = {};
    recent.forEach((e) => (e.feelings || []).forEach((f) => (top[f] = (top[f] || 0) + 1)));
    const frequent = Object.entries(top)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([f]) => f);
    const date = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

    return `
      <div class="journal">
        <p><strong>Дневник настроения</strong> <span class="note">последние ${recent.length} отметок, в среднем «${esc(moodLabel(Math.round(average)))}»${frequent.length ? `, чаще всего: ${esc(frequent.join(', '))}` : ''}</span></p>
        <div class="journal-bars" role="img" aria-label="Настроение по отметкам от ${esc(date(recent[0].at))} до ${esc(date(recent[recent.length - 1].at))}">
          ${recent
            .map(
              (e) =>
                `<span style="height:${(e.mood / 5) * 100}%" title="${esc(date(e.at))}: ${esc(moodLabel(e.mood))}${e.feelings?.length ? ' — ' + esc(e.feelings.join(', ')) : ''}"></span>`
            )
            .join('')}
        </div>
        <div class="journal-legend"><span>${esc(date(recent[0].at))}</span><span>${esc(date(recent[recent.length - 1].at))}</span></div>
        <div class="actions"><button class="sheet-close" type="button" id="journal-clear">Очистить дневник</button></div>
      </div>`;
  }

  function openMood() {
    let mood = null;
    const picked = new Set();

    show(
      'mood',
      'Как вы сейчас?',
      `<p class="lead">Отметка займёт десять секунд. Психолог учтёт её в разговоре, а дневник покажет, как меняется состояние от дня к дню.</p>
       <div class="choice-row" id="mood-scale" role="group" aria-label="Настроение">
         ${MOODS.map((m) => `<button type="button" data-mood="${m.value}" aria-pressed="false">${esc(m.label)}</button>`).join('')}
       </div>
       <p class="note">Что из этого ближе? Можно несколько.</p>
       <div class="choice-row" id="mood-feelings">
         ${FEELINGS.map((f) => `<button type="button" data-feeling="${esc(f)}" aria-pressed="false">${esc(f)}</button>`).join('')}
       </div>
       <div class="actions"><button class="btn" type="button" id="mood-save" disabled>Отметить</button></div>
       <div id="mood-journal">${journalHtml()}</div>`
    );

    const save = body.querySelector('#mood-save');
    body.querySelectorAll('[data-mood]').forEach((button) =>
      button.addEventListener('click', () => {
        mood = Number(button.dataset.mood);
        body.querySelectorAll('[data-mood]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        save.disabled = false;
      })
    );
    body.querySelectorAll('[data-feeling]').forEach((button) =>
      button.addEventListener('click', () => {
        const feeling = button.dataset.feeling;
        if (picked.has(feeling)) picked.delete(feeling);
        else if (picked.size < 4) picked.add(feeling);
        button.setAttribute('aria-pressed', String(picked.has(feeling)));
      })
    );
    save.addEventListener('click', () => {
      const feelings = [...picked];
      addJournalEntry({ mood, feelings });
      api.setMood({ mood, feelings });
      api.addNote(`Отмечено: ${moodLabel(mood)}${feelings.length ? ` — ${feelings.join(', ')}` : ''}`);
      api.companion()?.nod();
      body.querySelector('#mood-journal').innerHTML = journalHtml();
      bindJournal();
      save.textContent = 'Отмечено';
      save.disabled = true;
    });

    const bindJournal = () => {
      body.querySelector('#journal-clear')?.addEventListener('click', () => {
        clearJournal();
        body.querySelector('#mood-journal').innerHTML = journalHtml();
      });
    };
    bindJournal();
  }

  /* --- мне очень плохо ---------------------------------------------------- */

  function openCrisis() {
    show(
      'crisis',
      'Вы не одни',
      `<p class="lead">Если есть мысли навредить себе или опасность прямо сейчас — позвоните. На другом конце ответит живой человек, это бесплатно.</p>
       ${helplinesHtml()}
       <p class="lead">Пока набираете номер или если позвонить пока не можете — сделайте со мной несколько медленных вдохов.</p>
       <div class="actions">
         <button class="btn" type="button" id="crisis-breathe">Подышать вместе</button>
         <button class="btn btn--quiet" type="button" id="crisis-write">Написать, что происходит</button>
       </div>`
    );
    body.querySelector('#crisis-breathe').addEventListener('click', () => openBreath('even'));
    body.querySelector('#crisis-write').addEventListener('click', () => {
      close();
      api.prefill('');
    });
  }

  /* --- итог разговора ---------------------------------------------------- */

  function parseSummary(text) {
    const headings = ['О чём говорили', 'Что заметно', 'Маленький шаг'];
    const blocks = [];
    let currentBlock = null;
    text.split('\n').forEach((raw) => {
      const line = raw.replace(/^[#*\s]+|[*:\s]+$/g, '').trim();
      if (!line) return;
      const heading = headings.find((h) => line.toLowerCase().startsWith(h.toLowerCase()));
      if (heading && line.length <= heading.length + 2) {
        currentBlock = { heading, lines: [] };
        blocks.push(currentBlock);
      } else {
        if (!currentBlock) {
          currentBlock = { heading: '', lines: [] };
          blocks.push(currentBlock);
        }
        currentBlock.lines.push(raw.trim());
      }
    });
    return blocks;
  }

  async function openSummary() {
    const sessionId = api.sessionId();
    show('summary', 'Итог разговора', '<p class="loading">Собираю главное из разговора…</p>');
    api.companion()?.thinking();

    let text = '';
    try {
      const response = await fetch('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Сервер ответил ${response.status}`);
      text = data.summary;
    } catch (error) {
      api.companion()?.glyph();
      if (current !== 'summary') return;
      body.innerHTML = `<p class="lead">${esc(error.message)}</p>`;
      return;
    }

    api.companion()?.glyph();
    api.companion()?.nod();
    if (current !== 'summary') return;

    const blocks = parseSummary(text);
    const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    body.innerHTML = `
      <div class="summary">
        ${blocks
          .map(
            (block) =>
              `${block.heading ? `<h3>${esc(block.heading)}</h3>` : ''}${block.lines.map((l) => `<p>${esc(l)}</p>`).join('')}`
          )
          .join('')}
      </div>
      <div class="actions">
        <button class="btn" type="button" id="summary-copy">Скопировать</button>
        <button class="btn btn--quiet" type="button" id="summary-save">Скачать .txt</button>
      </div>
      <p class="note">Итог не сохраняется на сервере. Сохраните его, если хотите вернуться к нему позже.</p>`;

    const plain = `Тихий час — итог разговора, ${date}\n\n${text}\n`;
    body.querySelector('#summary-copy').addEventListener('click', async (event) => {
      try {
        await navigator.clipboard.writeText(plain);
        event.currentTarget.textContent = 'Скопировано';
      } catch {
        event.currentTarget.textContent = 'Не удалось скопировать';
      }
    });
    body.querySelector('#summary-save').addEventListener('click', () => {
      download(`tihiy-chas-itog-${new Date().toISOString().slice(0, 10)}.txt`, plain);
    });
  }

  /* --- вход ---------------------------------------------------------------- */

  function open(name) {
    if (name === 'breath') openBreath();
    else if (name === 'ground') openGround();
    else if (name === 'mood') openMood();
    else if (name === 'crisis') openCrisis();
    else if (name === 'summary') openSummary();
  }

  return { open, close, openBreath };
}

export function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
