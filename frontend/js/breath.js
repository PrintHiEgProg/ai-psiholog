/* ==========================================================================
   Дыхательные практики. Контроллер ничего не рисует сам: он считает фазу и
   раздаёт состояние подписчикам — 3D-фигуре, подписи на странице, вибрации.

   const run = startBreathing('box', {
     cycles: 4,
     onTick: (state) => companion.breathe(state),
     onPhase: (state) => label.textContent = state.label,
     onDone: () => companion.stopBreathing(),
   });
   run.stop();
   ========================================================================== */

/** Фаза: kind — что происходит с объёмом лёгких, seconds — длительность. */
export const PATTERNS = {
  box: {
    title: 'Квадрат 4-4-4-4',
    hint: 'Выравнивает дыхание и собирает внимание. Хорошо перед важным разговором.',
    phases: [
      { kind: 'in', label: 'вдох', seconds: 4 },
      { kind: 'hold-full', label: 'пауза', seconds: 4 },
      { kind: 'out', label: 'выдох', seconds: 4 },
      { kind: 'hold-empty', label: 'пауза', seconds: 4 },
    ],
  },
  relax: {
    title: '4-7-8',
    hint: 'Длинный выдох успокаивает. Подходит перед сном и когда накрывает тревога.',
    phases: [
      { kind: 'in', label: 'вдох носом', seconds: 4 },
      { kind: 'hold-full', label: 'задержка', seconds: 7 },
      { kind: 'out', label: 'выдох ртом', seconds: 8 },
    ],
  },
  even: {
    title: 'Ровное 5-5',
    hint: 'Самое простое: одинаковый вдох и выдох, без задержек.',
    phases: [
      { kind: 'in', label: 'вдох', seconds: 5 },
      { kind: 'out', label: 'выдох', seconds: 5 },
    ],
  },
};

/** Объём лёгких 0..1 для фазы при прогрессе t 0..1, со сглаживанием. */
function amountFor(kind, t) {
  const smooth = t * t * (3 - 2 * t);
  if (kind === 'in') return smooth;
  if (kind === 'out') return 1 - smooth;
  if (kind === 'hold-full') return 1;
  return 0;
}

export function startBreathing(patternName, { cycles = 4, onTick, onPhase, onDone } = {}) {
  const pattern = PATTERNS[patternName] || PATTERNS.box;
  const cycleLength = pattern.phases.reduce((sum, phase) => sum + phase.seconds, 0);
  const total = cycleLength * cycles;
  const started = performance.now();
  let lastPhaseKey = '';
  let frame = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const elapsed = (performance.now() - started) / 1000;

    if (elapsed >= total) {
      stopped = true;
      onDone?.({ completed: true, cycles });
      return;
    }

    const cycle = Math.floor(elapsed / cycleLength);
    let inCycle = elapsed - cycle * cycleLength;
    let phase = pattern.phases[0];
    for (const candidate of pattern.phases) {
      if (inCycle < candidate.seconds) {
        phase = candidate;
        break;
      }
      inCycle -= candidate.seconds;
    }

    const t = Math.min(1, inCycle / phase.seconds);
    const state = {
      label: phase.label,
      kind: phase.kind,
      count: Math.max(1, Math.ceil(phase.seconds - inCycle)),
      amount: amountFor(phase.kind, t),
      cycle: cycle + 1,
      cycles,
      progress: elapsed / total,
    };

    const phaseKey = `${cycle}:${phase.label}:${phase.kind}`;
    if (phaseKey !== lastPhaseKey) {
      lastPhaseKey = phaseKey;
      onPhase?.(state);
      // короткий отклик на телефоне: смену фазы можно почувствовать с закрытыми глазами
      if (navigator.vibrate) {
        try {
          navigator.vibrate(phase.kind === 'in' ? 18 : 10);
        } catch {
          /* вибрация недоступна — не страшно */
        }
      }
    }
    onTick?.(state);
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);

  return {
    pattern,
    total,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      onDone?.({ completed: false, cycles });
    },
  };
}
