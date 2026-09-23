/* ==========================================================================
   CRTHead — фигура с монитором вместо головы.
   Рисует SVG, печатает текст на экране, переключает состояния,
   следит за курсором. Никаких зависимостей.

   const head = new CRTHead(el, { track: true });
   head.boot();
   head.idle(['я здесь', 'расскажи, как ты']);
   head.setState('thinking');
   head.write('готов слушать');
   ========================================================================== */

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SVG_MARKUP = `
<svg class="crt" viewBox="0 0 520 660" role="img" aria-label="Фигура с ретро-монитором вместо головы: на экране появляется текст">
  <defs>
    <linearGradient id="crtBody" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="var(--figure-1)"/>
      <stop offset="1" stop-color="var(--figure-2)"/>
    </linearGradient>
    <linearGradient id="crtBezel" x1="0.1" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="var(--bezel-1)"/>
      <stop offset="0.55" stop-color="var(--bezel-2)"/>
      <stop offset="1" stop-color="var(--bezel-3)"/>
    </linearGradient>
    <radialGradient id="crtScreen" cx="0.5" cy="0.42" r="0.78">
      <stop offset="0" stop-color="var(--screen-1)"/>
      <stop offset="1" stop-color="var(--screen-2)"/>
    </radialGradient>
    <linearGradient id="crtGlare" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="rgba(255,255,255,0.4)"/>
      <stop offset="0.38" stop-color="rgba(255,255,255,0.05)"/>
      <stop offset="0.39" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>

  <g class="crt-body">
    <path class="crt-shoulders" d="M46 660 C60 552 130 490 206 480 L314 480 C390 490 460 552 474 660 Z"/>
    <path class="crt-neck" d="M246 290 C242 356 238 418 228 474 L292 474 C284 418 280 356 276 290 Z"/>
    <path class="crt-neck-shade" d="M246 290 C242 356 238 418 228 474 L248 474 C252 418 254 356 256 290 Z"/>
  </g>

  <g class="crt-cables">
    <path d="M176 284 C150 332 176 372 144 408 C118 438 114 462 126 486"/>
    <path d="M206 288 C192 336 214 366 196 402 C180 434 182 458 196 478"/>
    <path d="M320 288 C336 334 314 368 334 404 C352 436 350 460 336 480"/>
    <path d="M348 284 C376 330 350 370 384 406 C410 436 412 460 400 486"/>
  </g>

  <g class="crt-head">
    <rect class="crt-bezel" x="116" y="44" width="288" height="252" rx="30"/>
    <rect class="crt-bezel-groove" x="132" y="60" width="256" height="220" rx="20"/>
    <rect class="crt-screen-bg" x="150" y="76" width="220" height="172" rx="14"/>
    <foreignObject x="150" y="76" width="220" height="172">
      <div xmlns="http://www.w3.org/1999/xhtml" class="crt-screen">
        <div class="crt-stage"></div>
        <div class="crt-scanlines"></div>
        <div class="crt-sweep"></div>
        <div class="crt-vignette"></div>
      </div>
    </foreignObject>
    <rect class="crt-glare" x="150" y="76" width="220" height="172" rx="14"/>
    <text class="crt-brand" x="152" y="276">тихий час</text>
    <g class="crt-vents">
      <rect class="crt-vent" x="284" y="266" width="52" height="3" rx="1.5"/>
      <rect class="crt-vent" x="284" y="273" width="52" height="3" rx="1.5"/>
    </g>
    <circle class="crt-led" cx="360" cy="272" r="4.5"/>
  </g>
</svg>`;

const GLYPH = `
<svg class="crt-glyph" viewBox="0 0 100 100" aria-hidden="true">
  <path d="M14 62 C30 62 34 34 50 34 C66 34 70 62 86 62"/>
</svg>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CRTHead {
  constructor(container, options = {}) {
    this.options = { track: false, typeSpeed: 52, ...options };
    container.innerHTML = SVG_MARKUP;
    this.root = container.querySelector('.crt');
    this.headGroup = container.querySelector('.crt-head');
    this.stage = container.querySelector('.crt-stage');
    this.run = 0; // токен отмены для асинхронной печати
    this.setState('idle');

    if (this.options.track && !REDUCED_MOTION) {
      this._bindTracking();
    }
  }

  /* --- состояния ------------------------------------------------------- */

  setState(state) {
    this.root.dataset.state = state;
  }

  boot() {
    if (REDUCED_MOTION) return Promise.resolve();
    this.root.dataset.boot = 'on';
    return sleep(900);
  }

  /** Экран покоя: мягкий глиф вместо лица. */
  glyph() {
    this.run += 1;
    this.setState('idle');
    this.stage.innerHTML = GLYPH;
  }

  /** «Думает»: три точки. */
  thinking() {
    this.run += 1;
    this.setState('thinking');
    this.stage.innerHTML = '<div class="crt-dots"><span></span><span></span><span></span></div>';
  }

  /** «Говорит»: звуковая волна. */
  talking() {
    this.run += 1;
    this.setState('talking');
    this.stage.innerHTML =
      '<div class="crt-wave">' + '<span></span>'.repeat(7) + '</div>';
  }

  offline() {
    this.run += 1;
    this.setState('offline');
    this.stage.innerHTML = '<p class="crt-text">нет связи</p>';
  }

  /* --- текст ------------------------------------------------------------ */

  /** Печатает строку на экране. Возвращает промис по завершении. */
  async write(text, { speed = this.options.typeSpeed, caret = true } = {}) {
    const token = (this.run += 1);
    this.setState('text');
    this.stage.innerHTML = `<p class="crt-text"><span class="crt-body-text"></span>${
      caret ? '<span class="crt-caret"></span>' : ''
    }</p>`;
    const target = this.stage.querySelector('.crt-body-text');

    if (REDUCED_MOTION) {
      target.textContent = text;
      return;
    }

    for (const char of text) {
      if (token !== this.run) return; // состояние сменилось — печать отменена
      target.textContent += char;
      await sleep(char === ' ' ? speed * 0.5 : speed);
    }
  }

  /** Бесконечно перебирает строки: печатает, держит, стирает. */
  async idle(lines, { hold = 2400, speed = this.options.typeSpeed } = {}) {
    const token = (this.run += 1);
    this.setState('text');
    this.stage.innerHTML =
      '<p class="crt-text"><span class="crt-body-text"></span><span class="crt-caret"></span></p>';
    const target = this.stage.querySelector('.crt-body-text');

    if (REDUCED_MOTION) {
      target.textContent = lines[0];
      return;
    }

    let index = 0;
    while (token === this.run) {
      const line = lines[index % lines.length];
      for (const char of line) {
        if (token !== this.run) return;
        target.textContent += char;
        await sleep(char === ' ' ? speed * 0.5 : speed);
      }
      await sleep(hold);
      while (target.textContent.length > 0) {
        if (token !== this.run) return;
        target.textContent = target.textContent.slice(0, -1);
        await sleep(22);
      }
      await sleep(320);
      index += 1;
    }
  }

  /* --- слежение за курсором -------------------------------------------- */

  _bindTracking() {
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let frame = null;

    const onMove = (event) => {
      const box = this.root.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height * 0.3;
      targetX = Math.max(-1, Math.min(1, (event.clientX - cx) / (window.innerWidth / 2)));
      targetY = Math.max(-1, Math.min(1, (event.clientY - cy) / (window.innerHeight / 2)));
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const tick = () => {
      x += (targetX - x) * 0.08;
      y += (targetY - y) * 0.08;
      this.headGroup.style.setProperty('--tilt-x', `${(x * 14).toFixed(2)}px`);
      this.headGroup.style.setProperty('--tilt-y', `${(y * 8).toFixed(2)}px`);
      this.headGroup.style.setProperty('--tilt-rot', `${(x * 3.2).toFixed(2)}deg`);
      if (Math.abs(targetX - x) > 0.001 || Math.abs(targetY - y) > 0.001) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = null;
      }
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    this._unbind = () => window.removeEventListener('pointermove', onMove);
  }

  /* --- совместимость с 3D-версией: те же методы, упрощённое поведение --- */

  setScene() {}

  setFrame() {}

  setScroll() {}

  wave() {
    this.write('привет');
  }

  nod() {}

  breathe(state) {
    if (!this._breathing) {
      this._breathing = true;
      this.run += 1;
      this.setState('text');
      this.stage.innerHTML = '<p class="crt-text"><span class="crt-body-text"></span></p>';
    }
    const target = this.stage.querySelector('.crt-body-text');
    if (target) target.textContent = `${state.label} ${state.count}`;
  }

  stopBreathing() {
    this._breathing = false;
    this.glyph();
  }

  destroy() {
    this.run += 1;
    if (this._unbind) this._unbind();
  }
}
