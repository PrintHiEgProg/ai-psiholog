/* ==========================================================================
   Companion3D — 3D-сцена с психологом: человек, у которого вместо головы
   ЭЛТ-монитор.

   Устроена по схеме «слоёв» (web3d-integration-patterns, Layered Separation):
     • слой рендера — сцена, камера, один цикл requestAnimationFrame;
     • слой анимации — сцены (поза + положение + кадр камеры), жесты, дыхание,
       всё смешивается по времени, у каждого свойства ровно один «владелец»;
     • слой интерфейса — страница вызывает методы и ничего не знает о Three.js.

   Сцены: greet · wave · sit · think · talk · breathe
   Переход между сценами — это одновременное смешивание позы, положения фигуры,
   появления кресла и камеры. Поэтому «сесть в кресло» выглядит как движение,
   а не как смена картинки.

   Публичный интерфейс (совпадает с плоской версией crt-head.js):
     boot() · idle(lines) · write(text) · glyph() · thinking() · talking() · offline()
     setScene(name) · setFrame(name) · breathe(state) · stopBreathing() · wave() · nod()
     setScroll(t)
     destroy()
   ========================================================================== */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  buildPsychologist,
  buildArmchair,
  addLights,
  fitFrame,
  FRAMES,
  Poser,
  POSES,
  SEATED,
  HIP_HEIGHT,
  GREET_TURN,
} from './figure.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

/** Слой, на котором лежит всё светящееся: экран и индикатор питания. */
const BLOOM_LAYER = 1;
const FOV = 32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Доля пути за кадр при экспоненциальном сглаживании: не зависит от FPS. */
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);

const css = (name, fallback) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

/** Сцена = какая поза, какой кадр камеры и насколько развёрнута фигура. */
const SCENES = {
  greet: { pose: 'greet', frame: 'greet', turn: GREET_TURN },
  wave: { pose: 'wave', frame: 'wave', turn: -0.08 },
  sit: { pose: 'sit', frame: 'sit', turn: 0 },
  think: { pose: 'think', frame: 'sit', turn: 0.08 },
  talk: { pose: 'talk', frame: 'sit', turn: -0.06 },
  breathe: { pose: 'breathe', frame: 'close', turn: 0 },
};

/** Руки из позы «машет» — для взмаха сидя поверх сидячей позы. */
const WAVE_ARM = {
  shoulderR: POSES.wave.shoulderR,
  elbowR: POSES.wave.elbowR,
  wristR: POSES.wave.wristR,
};

/* ==========================================================================
   Экран: отдельный canvas, из которого делается текстура
   ========================================================================== */

class Screen {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 470;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    this.mode = 'glyph';
    this.text = '';
    this.glow = '#f0c88c';
    this.boot = 1; // 0 — экран погашен, 1 — развёрнут полностью
    this.brightness = 1;
    this.breath = { amount: 0, label: '', count: '' };
    this.flash = null; // короткая надпись поверх любого режима: { text, until }
  }

  setMode(mode) {
    this.mode = mode;
  }

  draw(time, now) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0906';
    ctx.fillRect(0, 0, w, h);

    // разворачивание луча при включении
    const open = Math.max(0.006, this.boot);
    ctx.save();
    ctx.translate(0, h / 2);
    ctx.scale(1, open);
    ctx.translate(0, -h / 2);

    const back = ctx.createRadialGradient(w / 2, h * 0.42, 40, w / 2, h / 2, w * 0.75);
    back.addColorStop(0, '#2a241d');
    back.addColorStop(1, '#0d0b08');
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, w, h);

    ctx.globalAlpha = this.brightness * (this.boot > 0.6 ? 1 : 0.6 + this.boot * 0.6);
    ctx.fillStyle = this.glow;
    ctx.strokeStyle = this.glow;
    ctx.shadowColor = this.glow;
    ctx.shadowBlur = 16;

    const flashing = this.flash && now < this.flash.until;
    if (flashing) {
      this._drawText(time, this.flash.text, false);
    } else {
      this.flash = null;
      if (this.mode === 'text') this._drawText(time, this.text, true);
      if (this.mode === 'dots') this._drawDots(time);
      if (this.mode === 'wave') this._drawWave(time);
      if (this.mode === 'glyph') this._drawGlyph();
      if (this.mode === 'breath') this._drawBreath();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();

    this._drawOverlay(time);
    this.texture.needsUpdate = true;
  }

  _drawText(time, text, caret) {
    const { ctx, canvas } = this;
    const size = 62;
    ctx.font = `500 ${size}px "Inter Tight", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = this._wrap(text, canvas.width * 0.8);
    const lineHeight = size * 1.28;
    const top = canvas.height / 2 - ((lines.length - 1) * lineHeight) / 2;

    lines.forEach((line, index) => {
      ctx.fillText(line, canvas.width / 2, top + index * lineHeight);
    });

    if (caret && Math.floor(time * 1.9) % 2 === 0) {
      const last = lines[lines.length - 1] || '';
      const width = ctx.measureText(last).width;
      const x = canvas.width / 2 + width / 2 + 10;
      const y = top + (lines.length - 1) * lineHeight;
      ctx.fillRect(x, y - size * 0.42, size * 0.42, size * 0.84);
    }
  }

  _wrap(text, maxWidth) {
    const { ctx } = this;
    const words = String(text).split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
    return lines;
  }

  _drawDots(time) {
    const { ctx, canvas } = this;
    const gap = 58;
    for (let i = 0; i < 3; i += 1) {
      const lift = Math.sin(time * 4 - i * 0.6) * 14;
      ctx.globalAlpha = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 4 - i * 0.6));
      ctx.beginPath();
      ctx.arc(canvas.width / 2 + (i - 1) * gap, canvas.height / 2 - lift, 14, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawWave(time) {
    const { ctx, canvas } = this;
    const bars = 7;
    const barWidth = 16;
    const gap = 16;
    const total = bars * barWidth + (bars - 1) * gap;
    const left = canvas.width / 2 - total / 2;
    for (let i = 0; i < bars; i += 1) {
      const height = 40 + Math.abs(Math.sin(time * 5 + i * 1.1)) * 150;
      const x = left + i * (barWidth + gap);
      const y = canvas.height / 2 - height / 2;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, height, 8);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barWidth, height);
      }
    }
  }

  _drawGlyph() {
    const { ctx, canvas } = this;
    ctx.lineWidth = 20;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(canvas.width * 0.22, canvas.height * 0.6);
    ctx.bezierCurveTo(
      canvas.width * 0.36,
      canvas.height * 0.6,
      canvas.width * 0.38,
      canvas.height * 0.4,
      canvas.width * 0.5,
      canvas.height * 0.4
    );
    ctx.bezierCurveTo(
      canvas.width * 0.62,
      canvas.height * 0.4,
      canvas.width * 0.64,
      canvas.height * 0.6,
      canvas.width * 0.78,
      canvas.height * 0.6
    );
    ctx.stroke();
  }

  /** Дыхание: круг растёт на вдохе и сжимается на выдохе, внизу — фаза. */
  _drawBreath() {
    const { ctx, canvas, breath } = this;
    const cx = canvas.width / 2;
    const cy = canvas.height * 0.44;
    const radius = 46 + breath.amount * 104;

    ctx.lineWidth = 10;
    ctx.globalAlpha *= 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, 150, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha /= 0.35;

    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.font = '600 64px "Inter Tight", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(breath.count), cx, cy + 2);

    ctx.font = '500 46px "Inter Tight", system-ui, sans-serif';
    ctx.fillText(breath.label, cx, canvas.height * 0.87);
  }

  _drawOverlay(time) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    for (let y = 0; y < h; y += 5) ctx.fillRect(0, y, w, 2.4);

    const sweepY = ((time * 90) % (h + 260)) - 130;
    const sweep = ctx.createLinearGradient(0, sweepY - 90, 0, sweepY + 90);
    sweep.addColorStop(0, 'rgba(255,255,255,0)');
    sweep.addColorStop(0.5, 'rgba(255,255,255,0.055)');
    sweep.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sweep;
    ctx.fillRect(0, sweepY - 90, w, 180);

    const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.32, w / 2, h / 2, h * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }
}

/** Мягкое пятно тени под фигурой — иначе она висит в воздухе. */
function buildContactShadow() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(40,34,26,0.5)');
  gradient.addColorStop(0.55, 'rgba(40,34,26,0.2)');
  gradient.addColorStop(1, 'rgba(40,34,26,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  return mesh;
}

/* ==========================================================================
   Качество: адаптивное разрешение и отключение свечения на слабых устройствах
   ========================================================================== */

const QUALITY = [
  { pixelRatio: 1, bloom: false }, // 0 — слабое устройство
  { pixelRatio: 1.35, bloom: true }, // 1 — телефон
  { pixelRatio: 2, bloom: true }, // 2 — полноценный экран
];

/* ==========================================================================
   Сцена
   ========================================================================== */

export class Companion3D {
  /**
   * @param {HTMLElement} container
   * @param {{ scene?: string, mode?: 'greet'|'sit', track?: boolean,
   *           interactive?: boolean, typeSpeed?: number }} options
   */
  constructor(container, options = {}) {
    const legacyScene = options.mode === 'sit' ? 'sit' : 'greet';
    this.options = {
      track: false,
      interactive: true,
      typeSpeed: 52,
      scene: legacyScene,
      ...options,
    };
    this.container = container;
    this.run = 0;
    this.state = 'idle';
    this.screen = new Screen();

    this.glowWarm = css('--glow', '#f0c88c');
    this.glowCool = css('--glow-cool', '#a9c9c4');
    this.glowDim = css('--glow-dim', '#c9a878');

    // слой анимации: кто чем владеет
    this.baseScene = this.options.scene; // задаёт страница (скролл, экран)
    this.gesture = null; // временный жест: { name, until }
    this.nodUntil = 0;
    this.breathing = false;
    this.scroll = 0.5;
    this.idleLook = { y: 0, z: 0, ty: 0, tz: 0, next: 0 };

    this.quality = COARSE_POINTER ? 1 : 2;
    this.perf = { avg: 1 / 60, since: 0 };

    this._initRenderer();
    this._buildScene();
    this._bindEvents();

    // тестовый крючок: сцена доступна автотестам под тем же флагом
    if (window.__frameCapture) window.__companion = this;

    this.screen.boot = 1;
    this.glyph();
    this._snapToScene();
    this._loop();
  }

  /* --- рендер ----------------------------------------------------------- */

  _initRenderer() {
    const width = this.container.clientWidth || 320;
    const height = this.container.clientHeight || 400;

    // Фон прозрачный: страница просвечивает насквозь, и канвас не выделяется
    // прямоугольником (тональная компрессия всё равно сдвинула бы цвет фона).
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      // Тестовый крючок: снимок страницы при программном рендеринге отстаёт на
      // секунды, поэтому автотесты читают кадр прямо из буфера.
      preserveDrawingBuffer: Boolean(window.__frameCapture),
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this._applyPixelRatio();
    this.renderer.setSize(width, height, false);

    const canvas = this.renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'pan-y';
    if (this.options.interactive) canvas.style.cursor = 'pointer';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      'Психолог с ретро-монитором вместо головы. Нажмите, и он помашет рукой.'
    );
    this.container.replaceChildren(canvas);

    this.scene = new THREE.Scene();
    this.scene.background = null;

    // мягкое окружение: без него стандартные материалы выглядят пластилином
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.34;

    this.camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 100);
    this.cameraTarget = new THREE.Vector3();

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());

    // Свечение выборочное: общий bloom засветил бы светлый корпус монитора и
    // фигуру целиком. Ореол считается отдельным проходом, где видны только
    // экран и индикатор, и добавляется поверх обычного кадра.
    this.bloomComposer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType })
    );
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.22, 0.55);
    this.bloomComposer.addPass(this.bloom);

    this.mixPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          baseTexture: { value: null },
          bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
          bloomStrength: { value: 0.55 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D baseTexture;
          uniform sampler2D bloomTexture;
          uniform float bloomStrength;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(baseTexture, vUv);
            vec3 glow = texture2D(bloomTexture, vUv).rgb * bloomStrength;
            // Ореол ложится только на саму фигуру и не трогает альфу: иначе
            // размытие залило бы весь канвас непрозрачным прямоугольником.
            gl_FragColor = vec4(base.rgb + glow * base.a, base.a);
          }
        `,
      }),
      'baseTexture'
    );

    this.composer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 })
    );
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(this.mixPass);
    this.composer.addPass(new OutputPass());

    this.bloomLayer = new THREE.Layers();
    this.bloomLayer.set(BLOOM_LAYER);
    this.darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.savedMaterials = new Map();
  }

  _applyPixelRatio() {
    const ratio = Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].pixelRatio);
    this.renderer.setPixelRatio(ratio);
    // У EffectComposer свой коэффициент, запомненный при создании. Если его не
    // обновить, буферы остаются в старом разрешении и кадр выходит пустым.
    this.composer?.setPixelRatio(ratio);
    this.bloomComposer?.setPixelRatio(ratio);
  }

  _darkenNonBloomed = (object) => {
    if (object.isMesh && !this.bloomLayer.test(object.layers)) {
      this.savedMaterials.set(object.uuid, object.material);
      object.material = this.darkMaterial;
    }
  };

  _restoreMaterial = (object) => {
    const saved = this.savedMaterials.get(object.uuid);
    if (saved) {
      object.material = saved;
      this.savedMaterials.delete(object.uuid);
    }
  };

  /* --- сборка сцены ------------------------------------------------------ */

  _buildScene() {
    const figure = buildPsychologist({
      THREE,
      RoundedBoxGeometry,
      screenTexture: this.screen.texture,
      glow: this.glowWarm,
    });

    this.figure = figure;
    this.joints = figure.joints;
    this.screenMaterial = figure.screenMaterial;
    this.screenLight = figure.screenLight;
    this.led = figure.led;
    this.glass = figure.glass;

    figure.screenMesh.layers.enable(BLOOM_LAYER);
    figure.led.layers.enable(BLOOM_LAYER);
    this.scene.add(figure.root);

    // кресло есть в сцене всегда и проявляется, когда фигура садится
    this.chair = buildArmchair({ THREE, RoundedBoxGeometry });
    this.chairMaterials = new Set();
    this.chair.traverse((object) => {
      if (object.isMesh) {
        object.material.transparent = true;
        this.chairMaterials.add(object.material);
      }
    });
    this.chairAmount = 0;
    this.scene.add(this.chair);

    this.shadow = buildContactShadow();
    this.scene.add(this.shadow);

    // положение фигуры стоя и сидя: таз опускается на подушку кресла
    this.standRoot = new THREE.Vector3(0, 0, 0.1);
    this.seatRoot = new THREE.Vector3(0, this.chair.userData.seatY - HIP_HEIGHT, -0.5);

    const initial = this._composeTarget();
    this.poser = new Poser(this.joints, initial.pose);
    this.hipBaseY = this.joints.hips.position.y;

    addLights(THREE, this.scene);
  }

  /* --- слой анимации: какая сцена сейчас действует ---------------------- */

  /** Имя действующей сцены: жест > дыхание > состояние разговора > база. */
  _activeSceneName() {
    if (this.gesture && this.gesture.name === 'wave' && !SEATED.has(this._restingScene())) {
      return 'wave';
    }
    if (this.breathing) return 'breathe';
    return this._restingScene();
  }

  /** Сцена без учёта жестов: в кресле состояние разговора меняет позу. */
  _restingScene() {
    if (this.baseScene === 'sit') {
      if (this.state === 'thinking') return 'think';
      if (this.state === 'talking') return 'talk';
    }
    return this.baseScene;
  }

  /** Целевая поза, положение, разворот и кадр для текущего мгновения. */
  _composeTarget() {
    const name = this._activeSceneName();
    const spec = SCENES[name] || SCENES.greet;
    const seated = SEATED.has(spec.pose);

    let pose = POSES[spec.pose];
    // взмах сидя: сидячая поза, но правая рука из позы «машет»
    if (this.gesture && this.gesture.name === 'wave' && seated) {
      pose = { ...pose, ...WAVE_ARM };
    }

    const width = this.container.clientWidth || 320;
    const height = this.container.clientHeight || 400;
    const frameName = this.options.frame || (width < 150 ? 'tight' : spec.frame);
    let frame = FRAMES[frameName] || FRAMES.sit;

    // машущая рука сидя уходит вбок: на время взмаха кадр чуть шире и выше
    if (this.gesture?.name === 'wave' && seated && frameName !== 'tight') {
      frame = {
        ...frame,
        center: [frame.center[0] + 0.55, frame.center[1] + 0.2, frame.center[2]],
        width: frame.width + 1.4,
        height: frame.height + 0.4,
      };
    }

    return { name, pose, seated, turn: spec.turn, frame, aspect: width / height };
  }

  /** Первый кадр — сразу в целевом состоянии, без «въезда» с нуля. */
  _snapToScene() {
    const target = this._composeTarget();
    this.poser.set(target.pose);
    this.poser.apply();
    this.figure.root.position.copy(target.seated ? this.seatRoot : this.standRoot);
    this.figure.root.rotation.y = target.turn;
    this.chairAmount = target.seated ? 1 : 0;
    this._applyChair();
    const fit = fitFrame(target.frame, target.aspect, FOV);
    this.camera.position.set(...fit.position);
    this.cameraTarget.set(...fit.target);
    this.camera.lookAt(this.cameraTarget);
  }

  _applyChair() {
    const amount = this.chairAmount;
    this.chair.visible = amount > 0.01;
    this.chair.position.y = (1 - amount) * -0.6;
    this.chairMaterials.forEach((material) => {
      material.opacity = amount;
      material.depthWrite = amount > 0.98;
    });
    const seatedShadow = amount;
    this.shadow.scale.set(2.6 + seatedShadow * 1.8, 1.5 + seatedShadow * 1.9, 1);
    this.shadow.position.z = 0.15 - seatedShadow * 0.1;
  }

  /* --- события ---------------------------------------------------------- */

  _bindEvents() {
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    this._onResize = () => {
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      if (!width || !height) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.composer.setSize(width, height);
      this.bloomComposer.setSize(width, height);
      this.bloom.resolution.set(size.x, size.y);
    };
    this._observer = new ResizeObserver(this._onResize);
    this._observer.observe(this.container);

    this._visible = true;
    this._io = new IntersectionObserver(([entry]) => {
      this._visible = entry.isIntersecting;
    });
    this._io.observe(this.container);

    if (this.options.track && !REDUCED_MOTION) {
      this._onPointer = (event) => {
        this.pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
        this.pointer.ty = (event.clientY / window.innerHeight) * 2 - 1;
      };
      window.addEventListener('pointermove', this._onPointer, { passive: true });
    }

    if (this.options.interactive) {
      this._onTap = () => this.wave();
      this.renderer.domElement.addEventListener('click', this._onTap);
    }
  }

  /* --- цикл: один requestAnimationFrame на всё --------------------------- */

  _loop() {
    this.clock = new THREE.Clock();
    this.elapsed = 0;

    const tick = () => {
      this._frame = requestAnimationFrame(tick);
      if (!this._visible || document.hidden) {
        this.clock.getDelta(); // не копим огромный шаг, пока вкладка спит
        return;
      }

      const dt = Math.min(0.1, this.clock.getDelta());
      this.elapsed += dt;
      const time = this.elapsed;
      const now = performance.now();
      const still = REDUCED_MOTION;

      if (this.gesture && now > this.gesture.until) this.gesture = null;

      const target = this._composeTarget();

      // поза
      this.poser.blend(target.pose, still ? 1 : ease(dt, 5));

      // положение фигуры и разворот
      const root = this.figure.root;
      const rootTarget = target.seated ? this.seatRoot : this.standRoot;
      root.position.lerp(rootTarget, still ? 1 : ease(dt, 4));
      root.rotation.y += (target.turn - root.rotation.y) * (still ? 1 : ease(dt, 4));

      // кресло проявляется вместе с посадкой
      this.chairAmount += ((target.seated ? 1 : 0) - this.chairAmount) * (still ? 1 : ease(dt, 4.5));
      this._applyChair();

      // камера едет между кадрами, как scrub у ScrollTrigger
      const fit = fitFrame(target.frame, target.aspect, FOV);
      const orbit = still ? 0 : (this.scroll - 0.5) * 0.9;
      const kCam = still ? 1 : ease(dt, 3);
      this.camera.position.x += (fit.position[0] + orbit - this.camera.position.x) * kCam;
      this.camera.position.y += (fit.position[1] - this.camera.position.y) * kCam;
      this.camera.position.z += (fit.position[2] - this.camera.position.z) * kCam;
      this.cameraTarget.x += (fit.target[0] - this.cameraTarget.x) * kCam;
      this.cameraTarget.y += (fit.target[1] - this.cameraTarget.y) * kCam;
      this.cameraTarget.z += (fit.target[2] - this.cameraTarget.z) * kCam;
      this.camera.lookAt(this.cameraTarget);

      if (!still) this._animate(time, dt, now);
      this.poser.apply();

      this.screen.draw(still ? 0 : time, now);
      this._render();
      this._adaptQuality(dt, now);
    };
    tick();
  }

  /** Живые мелочи поверх позы. Всё идёт через слой смещений Poser. */
  _animate(time, dt, now) {
    const { joints, poser } = this;

    // дыхание: в режиме практики — по фазам, иначе — спокойный фон
    const breathAmount = this.breathing ? this.screen.breath.amount : 0.5 + 0.5 * Math.sin(time * 0.8);
    const depth = this.breathing ? 1 : 0.35;
    poser.offset('chest', -breathAmount * 0.07 * depth);
    poser.offset('spine', -breathAmount * 0.03 * depth);
    poser.offset('shoulderL', 0, 0, breathAmount * 0.03 * depth);
    poser.offset('shoulderR', 0, 0, -breathAmount * 0.03 * depth);
    joints.hips.position.y = this.hipBaseY + breathAmount * 0.03 * depth;

    // взгляд: за курсором, а без курсора — редкие спокойные повороты головы
    const p = this.pointer;
    p.x += (p.tx - p.x) * ease(dt, 3);
    p.y += (p.ty - p.y) * ease(dt, 3);
    const look = this.idleLook;
    if (now > look.next) {
      look.ty = (Math.random() - 0.5) * 0.24;
      look.tz = (Math.random() - 0.5) * 0.12;
      look.next = now + 4000 + Math.random() * 4000;
    }
    look.y += (look.ty - look.y) * ease(dt, 1.2);
    look.z += (look.tz - look.z) * ease(dt, 1.2);
    poser.offset('neck', p.y * 0.12, p.x * 0.3 + look.y, 0);
    poser.offset('head', 0, p.x * 0.16, -p.x * 0.05 + look.z);

    // кивок: два коротких наклона головы
    if (now < this.nodUntil) {
      const t = 1 - (this.nodUntil - now) / 900;
      poser.offset('head', Math.sin(t * Math.PI * 4) * 0.14 * (1 - t));
    }

    const active = this._activeSceneName();

    // протянутая рука чуть покачивается, приглашая
    if (active === 'greet') {
      poser.offset('shoulderR', Math.sin(time * 1.1) * 0.05);
      poser.offset('elbowR', Math.sin(time * 1.1 + 0.5) * 0.045);
      poser.offset('wristR', Math.sin(time * 1.4) * 0.07);
    }

    // взмах: предплечье качается у виска
    if (this.gesture && this.gesture.name === 'wave') {
      poser.offset('elbowR', 0, 0, Math.sin(time * 10) * 0.32);
      poser.offset('wristR', 0, 0, Math.sin(time * 10 + 0.6) * 0.2);
    }

    // жест во время речи
    if (active === 'talk') {
      poser.offset('shoulderR', Math.sin(time * 1.9) * 0.1);
      poser.offset('elbowR', Math.sin(time * 2.3 + 0.7) * 0.13);
      poser.offset('wristR', 0, 0, Math.sin(time * 2.1) * 0.16);
    }

    // провода
    joints.cables.children.forEach((strand, index) => {
      strand.rotation.z = Math.sin(time * 0.6 + strand.userData.phase) * 0.02;
      strand.rotation.x = Math.cos(time * 0.45 + index) * 0.012;
    });

    // мерцание кинескопа
    const flicker = Math.sin(time * 37) * Math.sin(time * 5.3);
    this.screenMaterial.color.setScalar(1 + flicker * 0.05);
    this.screenLight.intensity = 2.6 + flicker * 0.3;
    this.led.material.emissiveIntensity = 2.4 + Math.sin(time * 1.6) * 1.2;
  }

  /** Сначала ореол по светящемуся, потом обычный кадр с ореолом поверх. */
  _render() {
    if (QUALITY[this.quality].bloom) {
      this.glass.visible = false; // на проходе свечения закрыло бы экран чёрным
      this.scene.traverse(this._darkenNonBloomed);
      this.bloomComposer.render();
      this.scene.traverse(this._restoreMaterial);
      this.glass.visible = true;
      this.mixPass.uniforms.bloomStrength.value = 0.55;
    } else {
      this.mixPass.uniforms.bloomStrength.value = 0;
    }
    this.composer.render();
  }

  /**
   * Если кадры стабильно дольше ~36 мс, качество снижается на ступень:
   * меньше пикселей, потом без свечения. Обратно не поднимаем — чтобы не
   * мигать качеством туда-сюда.
   */
  _adaptQuality(dt, now) {
    this.perf.avg += (dt - this.perf.avg) * 0.05;
    if (!this.perf.since) this.perf.since = now;
    if (now - this.perf.since < 2500) return;
    this.perf.since = now;
    if (this.perf.avg > 1 / 28 && this.quality > 0) {
      this.quality -= 1;
      this._applyPixelRatio();
      this._onResize();
      if (this.renderer) this.renderer.domElement.dataset.quality = String(this.quality);
    }
  }

  /* --- состояния разговора --------------------------------------------- */

  setState(state) {
    this.state = state;
    if (this.renderer) this.renderer.domElement.dataset.state = state;
    const glow =
      state === 'thinking' ? this.glowCool : state === 'offline' ? this.glowDim : this.glowWarm;
    this.screen.glow = glow;
    this.screenLight.color.set(glow);
    this.led.material.emissive.set(glow);
    this.screen.brightness = state === 'offline' ? 0.35 : 1;
  }

  async boot() {
    this.run += 1;
    this.setState('idle');
    this.screen.setMode('glyph');

    if (REDUCED_MOTION) {
      this.screen.boot = 1;
      return;
    }

    const start = performance.now();
    const duration = 820;
    await new Promise((resolve) => {
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / duration);
        // луч сначала вспыхивает линией, потом разворачивается на весь экран
        this.screen.boot = t < 0.35 ? 0.02 + t * 0.06 : Math.min(1, (t - 0.35) / 0.65);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });
  }

  glyph() {
    this.run += 1;
    this.setState('idle');
    this.screen.setMode('glyph');
  }

  thinking() {
    this.run += 1;
    this.setState('thinking');
    this.screen.setMode('dots');
  }

  talking() {
    this.run += 1;
    this.setState('talking');
    this.screen.setMode('wave');
  }

  offline() {
    this.run += 1;
    this.setState('offline');
    this.screen.setMode('text');
    this.screen.text = 'нет связи';
  }

  async write(text, { speed = this.options.typeSpeed } = {}) {
    const token = (this.run += 1);
    this.setState('text');
    this.screen.setMode('text');
    this.screen.text = '';
    if (REDUCED_MOTION) {
      this.screen.text = text;
      return;
    }
    for (const char of text) {
      if (token !== this.run) return;
      this.screen.text += char;
      await sleep(char === ' ' ? speed * 0.5 : speed);
    }
  }

  async idle(lines, { hold = 2400, speed = this.options.typeSpeed } = {}) {
    const token = (this.run += 1);
    this.setState('text');
    this.screen.setMode('text');
    this.screen.text = '';
    if (REDUCED_MOTION) {
      this.screen.text = lines[0];
      return;
    }
    let index = 0;
    while (token === this.run) {
      const line = lines[index % lines.length];
      for (const char of line) {
        if (token !== this.run) return;
        this.screen.text += char;
        await sleep(char === ' ' ? speed * 0.5 : speed);
      }
      await sleep(hold);
      while (this.screen.text.length > 0) {
        if (token !== this.run) return;
        this.screen.text = this.screen.text.slice(0, -1);
        await sleep(22);
      }
      await sleep(320);
      index += 1;
    }
  }

  /* --- сцены, жесты, практики ------------------------------------------ */

  /** Сменить базовую сцену: greet · sit · breathe · think · talk. */
  setScene(name) {
    if (!SCENES[name]) return;
    this.baseScene = name;
  }

  /** Помахать рукой; сидя — машет, не вставая. */
  wave() {
    this.gesture = { name: 'wave', until: performance.now() + 2400 };
    this.screen.flash = { text: 'привет', until: performance.now() + 2200 };
  }

  /** Кивнуть: «слышу». */
  nod() {
    this.nodUntil = performance.now() + 900;
  }

  /**
   * Дыхательная практика. Состояние приходит от контроллера (breath.js):
   * { amount: 0..1, label: 'вдох', count: 3 }. Экран рисует круг, грудь
   * поднимается вместе с ним.
   */
  breathe(state) {
    if (!this.breathing) {
      this.breathing = true;
      this.run += 1; // останавливаем печать строк на экране
      this.setState('idle');
      this.screen.setMode('breath');
    }
    Object.assign(this.screen.breath, state);
  }

  stopBreathing() {
    if (!this.breathing) return;
    this.breathing = false;
    this.screen.setMode('glyph');
  }

  /** Принудительный кадр ('tight', 'close', …) или null — кадр по сцене. */
  setFrame(name) {
    this.options.frame = name && FRAMES[name] ? name : null;
  }

  /** Прогресс прокрутки страницы 0..1 — камера чуть облетает фигуру. */
  setScroll(progress) {
    this.scroll = Math.min(1, Math.max(0, progress));
  }

  /* --- очистка ---------------------------------------------------------- */

  destroy() {
    this.run += 1;
    cancelAnimationFrame(this._frame);
    this._observer?.disconnect();
    this._io?.disconnect();
    if (this._onPointer) window.removeEventListener('pointermove', this._onPointer);
    if (this._onTap) this.renderer.domElement.removeEventListener('click', this._onTap);

    this.scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.filter(Boolean).forEach((material) => {
        if (material.map) material.map.dispose();
        material.dispose();
      });
    });
    this.screen.texture.dispose();
    this.envTexture?.dispose();
    this.pmrem?.dispose();
    this.darkMaterial.dispose();
    this.composer?.dispose();
    this.bloomComposer?.dispose();
    this.renderer?.dispose();
  }
}
