/* ==========================================================================
   Психолог: человеческая фигура с ЭЛТ-монитором вместо головы.

   Собирается из примитивов в коде — никаких файлов моделей. Фигура собрана
   как рига: каждый сустав это группа, дети которой висят вниз по −Y, а поза
   задаётся углами в суставах. Благодаря этому одна и та же модель стоит,
   протягивает руку и сидит в кресле.

   Дерево суставов:
     hips → spine → chest → neck → head
                     ├ shoulderL → elbowL → wristL
                     └ shoulderR → elbowR → wristR
     hips → hipL → kneeL → ankleL
          └ hipR → kneeR → ankleR

   Знак вращения: сегмент висит по −Y, поэтому отрицательный rotation.x
   выносит его вперёд (к зрителю), положительный — назад.
   ========================================================================== */

/* --------------------------------------------------------------- пропорции */

const P = {
  headW: 1.86,
  headH: 1.56,
  headD: 1.4,
  screenW: 1.4,
  screenH: 1.02,
  neck: 0.4,
  chest: 1.15,
  spine: 0.9,
  shoulderSpan: 1.42,
  upperArm: 1.18,
  foreArm: 1.08,
  hand: 0.42,
  hipSpan: 0.62,
  thigh: 1.38,
  shin: 1.3,
  foot: 0.62,
};

/**
 * Разворот фигуры для приветствия: в фас протянутая рука смотрит в камеру
 * и не читается, в три четверти её длина видна целиком.
 */
export const GREET_TURN = -0.2;

/** Высота таза над полом, когда фигура стоит. */
export const HIP_HEIGHT = P.thigh + P.shin + 0.18;

/* ------------------------------------------------------------- материалы */

export function makeMaterials(THREE) {
  return {
    skin: new THREE.MeshStandardMaterial({ color: '#dcd8d2', roughness: 0.55, metalness: 0.02 }),
    sweater: new THREE.MeshStandardMaterial({ color: '#7e8a80', roughness: 0.85, metalness: 0 }),
    trousers: new THREE.MeshStandardMaterial({ color: '#4c515a', roughness: 0.9, metalness: 0 }),
    shoe: new THREE.MeshStandardMaterial({ color: '#33302c', roughness: 0.7, metalness: 0.05 }),
    caseLight: new THREE.MeshStandardMaterial({ color: '#e7e2d6', roughness: 0.38, metalness: 0.05 }),
    caseDark: new THREE.MeshStandardMaterial({ color: '#403c35', roughness: 0.55, metalness: 0.15 }),
    cable: new THREE.MeshStandardMaterial({ color: '#26231f', roughness: 0.8, metalness: 0.05 }),
    fabric: new THREE.MeshStandardMaterial({ color: '#b3a894', roughness: 0.95, metalness: 0 }),
    fabricDark: new THREE.MeshStandardMaterial({ color: '#9c9080', roughness: 0.95, metalness: 0 }),
    wood: new THREE.MeshStandardMaterial({ color: '#6b513a', roughness: 0.6, metalness: 0.05 }),
  };
}

/* ------------------------------------------------------------- помощники */

/** Плоскость с выпуклостью — стекло кинескопа. */
export function curvedPlane(THREE, width, height, bulge) {
  const geometry = new THREE.PlaneGeometry(width, height, 28, 22);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i) / (width / 2);
    const y = position.getY(i) / (height / 2);
    position.setZ(i, Math.cos((x * Math.PI) / 2) * Math.cos((y * Math.PI) / 2) * bulge);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Корпус ЭЛТ: сзади уже, чем спереди. */
function tubeBody(THREE, RoundedBoxGeometry, width, height, depth) {
  const geometry = new RoundedBoxGeometry(width, height, depth, 4, 0.1);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const z = position.getZ(i);
    // t обязательно зажать: на крайних вершинах он выходит за [0,1] из-за
    // погрешности, а Math.pow от отрицательного числа даёт NaN и ломает меш
    const t = Math.min(1, Math.max(0, (z + depth / 2) / depth));
    const scale = 0.7 + 0.3 * Math.pow(t, 0.7);
    position.setX(i, position.getX(i) * scale);
    position.setY(i, position.getY(i) * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Сегмент конечности: группа с осью вращения в начале координат,
 * меш свисает вниз. Шар в суставе прячет стык.
 */
function segment(THREE, material, { length, top, bottom }) {
  const group = new THREE.Group();

  const limb = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, length, 20), material);
  limb.position.y = -length / 2;
  group.add(limb);

  const joint = new THREE.Mesh(new THREE.SphereGeometry(top, 20, 16), material);
  group.add(joint);

  group.userData.length = length;
  return group;
}

/* ------------------------------------------------------- голова-монитор */

function buildHead(THREE, RoundedBoxGeometry, materials, screenTexture, glow) {
  const head = new THREE.Group();

  const faceZ = P.headD / 2;
  const screenX = P.screenW / 2;
  const screenY = P.screenH / 2;
  const faceX = P.headW / 2 - 0.1;
  const faceY = P.headH / 2 - 0.1;
  const centerY = P.headH / 2 + 0.06; // монитор стоит на шее

  const monitor = new THREE.Mesh(
    tubeBody(THREE, RoundedBoxGeometry, P.headW, P.headH, P.headD),
    materials.caseLight
  );
  monitor.position.y = centerY;
  head.add(monitor);

  // Кинескоп светится сам: неосвещаемый материал, иначе свет от лампы экрана
  // и ключевой свет вымывают картинку в светлое пятно.
  const screenMaterial = new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false });
  const screenMesh = new THREE.Mesh(
    curvedPlane(THREE, P.screenW, P.screenH, 0.07),
    screenMaterial
  );
  screenMesh.position.set(0, centerY, faceZ + 0.005);
  head.add(screenMesh);

  const glass = new THREE.Mesh(
    curvedPlane(THREE, P.screenW + 0.04, P.screenH + 0.04, 0.08),
    new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.05,
      clearcoat: 1,
    })
  );
  glass.position.set(0, centerY, faceZ + 0.02);
  head.add(glass);

  // рамка вокруг экрана — кинескоп выглядит утопленным
  const frameDepth = 0.1;
  const sideW = faceX - screenX;
  const capH = faceY - screenY;
  [
    [new THREE.BoxGeometry(sideW, faceY * 2, frameDepth), -(screenX + sideW / 2), 0],
    [new THREE.BoxGeometry(sideW, faceY * 2, frameDepth), screenX + sideW / 2, 0],
    [new THREE.BoxGeometry(faceX * 2, capH, frameDepth), 0, screenY + capH / 2],
    [new THREE.BoxGeometry(faceX * 2, capH, frameDepth), 0, -(screenY + capH / 2)],
  ].forEach(([geometry, x, y]) => {
    const part = new THREE.Mesh(geometry, materials.caseLight);
    part.position.set(x, centerY + y, faceZ + frameDepth / 2 - 0.01);
    head.add(part);
  });

  // свет экрана падает на плечи и грудь
  const screenLight = new THREE.PointLight(new THREE.Color(glow), 2.6, 4.5, 2);
  screenLight.position.set(0, centerY - 0.1, faceZ + 0.45);
  head.add(screenLight);

  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 14, 12),
    new THREE.MeshStandardMaterial({
      color: '#2b2622',
      emissive: new THREE.Color(glow),
      emissiveIntensity: 3,
    })
  );
  led.position.set(0.48, centerY - screenY - capH / 2, faceZ + frameDepth - 0.01);
  head.add(led);

  const knobs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.045, 0.03), materials.caseDark);
  knobs.position.set(-0.3, centerY - screenY - capH / 2, faceZ + frameDepth - 0.01);
  head.add(knobs);

  for (let i = 0; i < 4; i += 1) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.02, 0.045), materials.caseDark);
    vent.position.set(0, centerY + P.headH / 2 - 0.005, -0.16 + i * 0.1);
    head.add(vent);
  }

  return { head, screenMesh, screenMaterial, glass, led, screenLight };
}

/* ------------------------------------------------------------- фигура */

export function buildPsychologist({ THREE, RoundedBoxGeometry, screenTexture, glow = '#f0c88c' }) {
  const materials = makeMaterials(THREE);
  const root = new THREE.Group();
  const joints = {};

  /* --- таз и корпус --- */

  const hips = new THREE.Group();
  hips.position.y = HIP_HEIGHT;
  root.add(hips);
  joints.hips = hips;

  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.42, 28, 20), materials.trousers);
  pelvis.scale.set(1.05, 0.85, 0.85);
  pelvis.position.y = -0.08;
  hips.add(pelvis);

  const spine = new THREE.Group();
  hips.add(spine);
  joints.spine = spine;

  // Корпус — одна поверхность вращения от кромки свитера до плеч.
  // Из отдельных примитивов (шар груди + цилиндр живота) торс собирался
  // с видимыми стыками и читался как ведро.
  const trunkProfile = [
    [0.02, -0.1],
    [0.38, -0.12],
    [0.49, -0.04],
    [0.5, 0.12],
    [0.47, 0.32],
    [0.5, 0.62],
    [0.57, 1.0],
    [0.6, 1.3],
    [0.57, 1.55],
    [0.46, 1.72],
    [0.3, 1.8],
    [0.18, 1.83],
  ].map(([radius, height]) => new THREE.Vector2(radius, height));

  const trunk = new THREE.Mesh(
    new THREE.LatheGeometry(new THREE.SplineCurve(trunkProfile).getPoints(56), 48),
    materials.sweater
  );
  trunk.scale.z = 0.74;
  spine.add(trunk);

  const chest = new THREE.Group();
  chest.position.y = P.spine;
  spine.add(chest);
  joints.chest = chest;

  // линия плеч: мягкий валик поверх корпуса
  const shoulders = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.26, P.shoulderSpan - 0.52, 6, 20),
    materials.sweater
  );
  shoulders.rotation.z = Math.PI / 2;
  shoulders.scale.z = 0.8;
  shoulders.position.y = P.chest - 0.3;
  chest.add(shoulders);

  /* --- шея и голова --- */

  const neck = new THREE.Group();
  neck.position.y = P.chest - 0.23;
  chest.add(neck);
  joints.neck = neck;

  const neckMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.23, P.neck, 20),
    materials.skin
  );
  neckMesh.position.y = P.neck / 2;
  neck.add(neckMesh);

  const head = new THREE.Group();
  head.position.y = P.neck;
  neck.add(head);
  joints.head = head;

  const monitor = buildHead(THREE, RoundedBoxGeometry, materials, screenTexture, glow);
  head.add(monitor.head);

  /* --- провода от монитора на плечи --- */

  const cables = new THREE.Group();
  chest.add(cables);
  [
    [[-0.3, P.chest + 0.5, -0.15], [-0.62, P.chest + 0.1, 0.3], [-0.6, P.chest - 0.3, 0.16], [-0.5, P.chest - 0.5, -0.2]],
    [[-0.1, P.chest + 0.5, -0.2], [-0.3, P.chest + 0.05, 0.34], [-0.26, P.chest - 0.35, 0.22], [-0.22, P.chest - 0.62, -0.12]],
    [[0.14, P.chest + 0.5, -0.2], [0.34, P.chest + 0.02, 0.33], [0.3, P.chest - 0.4, 0.2], [0.26, P.chest - 0.66, -0.1]],
    [[0.32, P.chest + 0.5, -0.14], [0.66, P.chest + 0.08, 0.28], [0.62, P.chest - 0.32, 0.15], [0.52, P.chest - 0.52, -0.2]],
  ].forEach((points) => {
    const curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(...p)),
      false,
      'catmullrom',
      0.5
    );
    const strand = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 60, 0.022, 8, false),
      materials.cable
    );
    strand.userData.phase = Math.random() * Math.PI * 2;
    cables.add(strand);
  });
  joints.cables = cables;

  /* --- руки --- */

  const arm = (side) => {
    const sign = side === 'L' ? -1 : 1;

    const shoulder = segment(THREE, materials.sweater, {
      length: P.upperArm,
      top: 0.21,
      bottom: 0.17,
    });
    shoulder.position.set((sign * P.shoulderSpan) / 2, P.chest - 0.3, 0);
    chest.add(shoulder);
    joints[`shoulder${side}`] = shoulder;

    const elbow = segment(THREE, materials.sweater, {
      length: P.foreArm,
      top: 0.16,
      bottom: 0.115,
    });
    elbow.position.y = -P.upperArm;
    shoulder.add(elbow);
    joints[`elbow${side}`] = elbow;

    // манжета свитера, дальше — кисть
    const cuff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.12, 0.14, 16),
      materials.sweater
    );
    cuff.position.y = -P.foreArm + 0.04;
    elbow.add(cuff);

    const wrist = new THREE.Group();
    wrist.position.y = -P.foreArm;
    elbow.add(wrist);
    joints[`wrist${side}`] = wrist;

    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 14), materials.skin);
    palm.scale.set(0.78, 1.15, 0.5);
    palm.position.y = -P.hand / 2;
    wrist.add(palm);

    // четыре пальца и большой — отдельными капсулами, иначе кисть читается варежкой
    for (let i = 0; i < 4; i += 1) {
      const finger = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.031, 0.15, 3, 8),
        materials.skin
      );
      finger.position.set(-0.075 + i * 0.05, -P.hand + 0.03, 0);
      finger.rotation.z = (i - 1.5) * 0.06;
      wrist.add(finger);
    }
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.034, 0.1, 3, 8), materials.skin);
    thumb.position.set(sign * 0.1, -P.hand + 0.12, 0.03);
    thumb.rotation.z = sign * 0.85;
    wrist.add(thumb);

    return shoulder;
  };

  arm('L');
  arm('R');

  /* --- ноги --- */

  const leg = (side) => {
    const sign = side === 'L' ? -1 : 1;

    const hip = segment(THREE, materials.trousers, { length: P.thigh, top: 0.33, bottom: 0.26 });
    hip.position.set((sign * P.hipSpan) / 2, -0.12, 0);
    hips.add(hip);
    joints[`hip${side}`] = hip;

    const knee = segment(THREE, materials.trousers, { length: P.shin, top: 0.24, bottom: 0.17 });
    knee.position.y = -P.thigh;
    hip.add(knee);
    joints[`knee${side}`] = knee;

    const ankle = new THREE.Group();
    ankle.position.y = -P.shin;
    knee.add(ankle);
    joints[`ankle${side}`] = ankle;

    const shoe = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, P.foot - 0.3, 4, 14), materials.shoe);
    shoe.rotation.x = Math.PI / 2;
    shoe.position.set(0, -0.1, P.foot / 2 - 0.16);
    ankle.add(shoe);

    return hip;
  };

  leg('L');
  leg('R');

  return {
    root,
    joints,
    materials,
    screenMesh: monitor.screenMesh,
    screenMaterial: monitor.screenMaterial,
    glass: monitor.glass,
    led: monitor.led,
    screenLight: monitor.screenLight,
  };
}

/* -------------------------------------------------------------- кресло */

export function buildArmchair({ THREE, RoundedBoxGeometry }) {
  const materials = makeMaterials(THREE);
  const chair = new THREE.Group();

  const seatY = 1.35;
  const seatW = 2.56;
  const seatD = 2.0;

  const base = new THREE.Mesh(
    new RoundedBoxGeometry(seatW, 0.42, seatD, 4, 0.16),
    materials.fabric
  );
  base.position.set(0, seatY, 0);
  chair.add(base);

  const cushion = new THREE.Mesh(
    new RoundedBoxGeometry(seatW - 0.22, 0.26, seatD - 0.22, 4, 0.12),
    materials.fabricDark
  );
  cushion.position.set(0, seatY + 0.3, 0.02);
  chair.add(cushion);

  const back = new THREE.Mesh(
    new RoundedBoxGeometry(seatW, 2.3, 0.4, 4, 0.16),
    materials.fabric
  );
  back.position.set(0, seatY + 1.22, -seatD / 2 + 0.1);
  back.rotation.x = -0.14; // спинка слегка откинута
  chair.add(back);

  const backPad = new THREE.Mesh(
    new RoundedBoxGeometry(seatW - 0.34, 1.95, 0.22, 4, 0.1),
    materials.fabricDark
  );
  backPad.position.set(0, seatY + 1.16, -seatD / 2 + 0.32);
  backPad.rotation.x = -0.14;
  chair.add(backPad);

  [-1, 1].forEach((sign) => {
    const armrest = new THREE.Mesh(
      new RoundedBoxGeometry(0.34, 0.34, seatD - 0.1, 4, 0.14),
      materials.fabric
    );
    armrest.position.set((sign * seatW) / 2 - 0.05, seatY + 0.62, 0.05);
    chair.add(armrest);

    const support = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.5, 0.9),
      materials.fabric
    );
    support.position.set((sign * seatW) / 2 - 0.05, seatY + 0.28, 0.05);
    chair.add(support);
  });

  // ножки: слегка расходятся, как у кресел середины века
  [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].forEach(([sx, sz]) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.045, seatY, 12), materials.wood);
    leg.position.set(sx * (seatW / 2 - 0.3), seatY / 2 - 0.2, sz * (seatD / 2 - 0.3));
    leg.rotation.z = sx * -0.09;
    leg.rotation.x = sz * 0.09;
    chair.add(leg);
  });

  chair.userData.seatY = seatY + 0.43; // верх подушки — на этой высоте сидит таз
  return chair;
}

/* --------------------------------------------------------------- позы */

/** Углы суставов: [rx, ry, rz] в радианах. Отсутствующие оси — нули. */
export const POSES = {
  /** Стоит ровно, руки вдоль тела. Из неё начинается приветствие. */
  stand: {
    hips: [0, 0, 0],
    spine: [0, 0, 0],
    chest: [0, 0, 0],
    neck: [0, 0, 0],
    head: [0, 0, 0],
    shoulderL: [-0.04, 0, 0.13],
    elbowL: [-0.12, 0, 0.04],
    wristL: [0, 0, 0],
    shoulderR: [-0.04, 0, -0.13],
    elbowR: [-0.12, 0, -0.04],
    wristR: [0, 0, 0],
    hipL: [0, 0, 0.02],
    kneeL: [0.02, 0, 0],
    ankleL: [0, 0, 0],
    hipR: [0, 0, -0.02],
    kneeR: [0.02, 0, 0],
    ankleR: [0, 0, 0],
  },

  /**
   * Встречает: рука протянута навстречу, ладонь раскрыта.
   * Фигура при этом развёрнута в три четверти (см. GREET_TURN) — в фас
   * протянутая рука смотрит точно в камеру и читается как сложенная на груди.
   */
  greet: {
    hips: [0, 0.04, 0],
    spine: [-0.04, 0.03, 0],
    chest: [-0.02, -0.1, 0],
    neck: [0.1, 0.12, 0],
    head: [0.1, 0.1, -0.03],
    shoulderL: [-0.1, 0, 0.14],
    elbowL: [-0.22, 0, 0.08],
    wristL: [0.05, 0, 0],
    // Плечо вынесено вперёд (−x) и отведено от корпуса (+z для правой руки:
    // отрицательный z увёл бы её поперёк груди). Локоть почти разогнут.
    // Суммарный поворот около −1.4 рад разворачивает ладонь вверх сам собой.
    shoulderR: [-0.5, -0.1, 0.85],
    elbowR: [-0.55, 0.12, 0.18],
    wristR: [0.35, 0, 0.1],
    hipL: [-0.04, 0, 0.03],
    kneeL: [0.06, 0, 0],
    ankleL: [0, 0.16, 0],
    hipR: [0.05, 0, -0.03],
    kneeR: [0.04, 0, 0],
    ankleR: [0, -0.22, 0],
  },

  /** Сидит и слушает: колени согнуты, руки на подлокотниках. */
  sit: {
    hips: [0, 0, 0],
    spine: [-0.06, 0, 0],
    chest: [-0.04, 0, 0],
    neck: [0.06, 0, 0],
    head: [0.04, 0, 0],
    // руки лежат на коленях: знак z разный, иначе руки уходят внутрь корпуса
    shoulderL: [-0.32, 0, -0.16],
    elbowL: [-1.0, 0, 0.2],
    wristL: [0.2, 0, 0],
    shoulderR: [-0.32, 0, 0.16],
    elbowR: [-1.0, 0, -0.2],
    wristR: [0.2, 0, 0],
    hipL: [-1.5, 0.06, 0.08],
    kneeL: [1.35, 0, 0],
    ankleL: [0.18, 0, 0],
    hipR: [-1.5, -0.06, -0.08],
    kneeR: [1.35, 0, 0],
    ankleR: [0.18, 0, 0],
  },

  /** Думает: рука поднята к нижней рамке монитора. */
  think: {
    hips: [0, 0, 0],
    spine: [-0.03, 0.05, 0],
    chest: [-0.02, 0.08, 0],
    neck: [0.12, -0.05, 0.04],
    head: [0.08, -0.06, 0.05],
    shoulderL: [-0.32, 0, -0.16],
    elbowL: [-1.0, 0, 0.2],
    wristL: [0.2, 0, 0],
    // Локоть прижат к рёбрам, предплечье идёт вверх — классическая поза
    // «рука у подбородка». Отводить плечо вбок нельзя: тогда сгиб локтя
    // происходит вокруг наклонённой оси и предплечье уезжает вниз-в сторону.
    shoulderR: [-0.25, 0, -0.12],
    elbowR: [-2.55, -0.15, 0],
    wristR: [0.3, 0, 0.2],
    hipL: [-1.5, 0.06, 0.08],
    kneeL: [1.35, 0, 0],
    ankleL: [0.18, 0, 0],
    hipR: [-1.5, -0.06, -0.08],
    kneeR: [1.35, 0, 0],
    ankleR: [0.18, 0, 0],
  },

  /** Говорит: корпус чуть вперёд, раскрытая ладонь у груди. */
  talk: {
    hips: [0, 0, 0],
    spine: [-0.12, 0, 0],
    chest: [-0.06, -0.06, 0],
    neck: [0.04, 0.03, 0],
    head: [0.02, 0.04, 0],
    shoulderL: [-0.36, 0, -0.18],
    elbowL: [-1.05, 0, 0.2],
    wristL: [0.2, 0, 0],
    // раскрытая ладонь у груди — жест «рассказываю»
    shoulderR: [-0.72, -0.16, 0.42],
    elbowR: [-1.3, -0.22, -0.16],
    wristR: [0.42, 0, -0.2],
    hipL: [-1.5, 0.06, 0.08],
    kneeL: [1.35, 0, 0],
    ankleL: [0.18, 0, 0],
    hipR: [-1.5, -0.06, -0.08],
    kneeR: [1.35, 0, 0],
    ankleR: [0.18, 0, 0],
  },

  /**
   * Дышит: сидит, ладони на животе. Углы рук найдены перебором по расстоянию
   * от кисти до точки у пупка — на глаз такие позы не собираются.
   */
  breathe: {
    hips: [0, 0, 0],
    spine: [-0.02, 0, 0],
    chest: [-0.02, 0, 0],
    neck: [0.14, 0, 0],
    head: [0.1, 0, 0],
    shoulderL: [0.1, 0, -0.1],
    elbowL: [-1.5, 0, 0.6],
    wristL: [0.3, 0, 0],
    shoulderR: [0.1, 0, 0.1],
    elbowR: [-1.5, 0, -0.6],
    wristR: [0.3, 0, 0],
    hipL: [-1.5, 0.06, 0.08],
    kneeL: [1.35, 0, 0],
    ankleL: [0.18, 0, 0],
    hipR: [-1.5, -0.06, -0.08],
    kneeR: [1.35, 0, 0],
    ankleR: [0.18, 0, 0],
  },

  /** Машет: стоит, правая рука поднята, предплечье вертикально у виска. */
  wave: {
    hips: [0, 0.02, 0],
    spine: [-0.02, 0, 0.02],
    chest: [0, -0.06, 0.03],
    neck: [0.06, 0.06, -0.05],
    head: [0.04, 0.06, -0.06],
    shoulderL: [-0.06, 0, 0.14],
    elbowL: [-0.16, 0, 0.06],
    wristL: [0, 0, 0],
    shoulderR: [0, 0, 1.6],
    elbowR: [-0.1, -0.6, 1.8],
    wristR: [0, 0, 0],
    hipL: [0, 0, 0.03],
    kneeL: [0.03, 0, 0],
    ankleL: [0, 0.1, 0],
    hipR: [0, 0, -0.03],
    kneeR: [0.03, 0, 0],
    ankleR: [0, -0.1, 0],
  },
};

/** Позы, в которых фигура сидит в кресле. */
export const SEATED = new Set(['sit', 'think', 'talk', 'breathe']);

/**
 * Поза как отдельный слой. Держит текущие углы в своём состоянии, а в суставы
 * пишет сумму «поза + живое смещение».
 *
 * Так сделано не для красоты: если прибавлять дыхание и взгляд прямо к
 * rotation, на следующем кадре смешивание стартует уже со смещённого угла.
 * Смещения копятся и в равновесии оказываются во много раз больше задуманных,
 * а поза никогда не доходит до цели.
 */
export class Poser {
  constructor(joints, pose) {
    this.joints = joints;
    this.state = {};
    this.offsets = {};
    for (const name of Object.keys(pose)) this.state[name] = [...pose[name]];
  }

  /** Подтягивает позу к цели. k — доля пути за этот кадр. */
  blend(target, k) {
    for (const name of Object.keys(target)) {
      const current = this.state[name] || (this.state[name] = [0, 0, 0]);
      for (let i = 0; i < 3; i += 1) {
        current[i] += (target[name][i] - current[i]) * k;
      }
    }
  }

  /** Мгновенно ставит позу — для первого кадра. */
  set(pose) {
    this.blend(pose, 1);
  }

  /** Смещение поверх позы на один кадр (дыхание, взгляд, жест). */
  offset(name, x = 0, y = 0, z = 0) {
    const o = this.offsets[name] || (this.offsets[name] = [0, 0, 0]);
    o[0] += x;
    o[1] += y;
    o[2] += z;
  }

  /** Записывает результат в суставы и сбрасывает смещения. */
  apply() {
    for (const name of Object.keys(this.state)) {
      const joint = this.joints[name];
      if (!joint) continue;
      const [x, y, z] = this.state[name];
      const o = this.offsets[name];
      if (o) {
        joint.rotation.set(x + o[0], y + o[1], z + o[2]);
        o[0] = o[1] = o[2] = 0;
      } else {
        joint.rotation.set(x, y, z);
      }
    }
  }
}

/* --------------------------------------------------------------- свет */

export function addLights(THREE, scene) {
  // окружение (RoomEnvironment) уже даёт мягкий заполняющий свет,
  // поэтому полусфера и ключевой свет слабее, чем без него
  scene.add(new THREE.HemisphereLight('#f6f4f0', '#6f6a60', 0.45));

  const key = new THREE.DirectionalLight('#fff4e6', 1.85);
  key.position.set(4.5, 6.5, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight('#cfe0ee', 0.6);
  fill.position.set(-5.5, 1.5, 3.5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight('#ffffff', 1.5);
  rim.position.set(-2, 4, -5.5);
  scene.add(rim);
}

/* --------------------------------------------------------------- кадр */

/**
 * Кадры — точки, между которыми ездит камера. Задаются не позицией камеры,
 * а тем, что должно поместиться в кадр: центр, высота и ширина области.
 * Расстояние считается под пропорции контейнера, поэтому в узкой вертикальной
 * колонке и в широкой полосе на телефоне фигура не обрезается.
 */
export const FRAMES = {
  // стоит в полный рост, справа место под протянутую руку
  greet: { center: [0.6, 3.3, 0], height: 7.9, width: 6.5, lift: 1.0, side: 0.2 },
  wave: { center: [0.55, 3.45, 0], height: 7.6, width: 6.2, lift: 1.0, side: 0 },
  // сидит в кресле целиком
  sit: { center: [0, 2.72, 0], height: 6.5, width: 4.0, lift: 0.9, side: 0.35 },
  // ближе: корпус и голова — для дыхания и разговора
  close: { center: [0, 3.75, 0], height: 4.2, width: 3.3, lift: 0.6, side: 0.2 },
  // только голова и плечи — самая узкая колонка
  tight: { center: [0, 4.45, 0], height: 2.9, width: 2.6, lift: 0.3, side: 0 },
};

/**
 * Положение камеры, при котором область кадра целиком видна.
 * Возвращает { position: [x,y,z], target: [x,y,z] }.
 */
export function fitFrame(frame, aspect, fovDeg = 32) {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  const byHeight = frame.height / 2 / half;
  const byWidth = frame.width / 2 / (half * Math.max(0.2, aspect));
  const distance = Math.max(byHeight, byWidth);
  const [cx, cy, cz] = frame.center;
  return {
    position: [cx + frame.side, cy + frame.lift, cz + distance],
    target: [cx, cy, cz],
  };
}
