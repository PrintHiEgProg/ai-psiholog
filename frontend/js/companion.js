/* Выбор версии персонажа: 3D-сцена, если есть WebGL2, иначе плоская SVG-версия.

   createCompanion(el, { scene: 'greet' | 'sit' | 'breathe' | …, track, interactive })
     'greet' — стоит и протягивает руку (лендинг)
     'sit'   — сидит в кресле (разговор)
*/

function hasWebGL2() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

export async function createCompanion(container, options = {}) {
  if (hasWebGL2()) {
    try {
      const { Companion3D } = await import('./companion-3d.js');
      return new Companion3D(container, options);
    } catch (error) {
      console.warn('3D-сцена не запустилась, показываю плоскую версию:', error);
    }
  }
  // запасной вариант — плоский SVG-бюст с тем же интерфейсом
  const { CRTHead } = await import('./crt-head.js');
  container.classList.add('is-flat');
  return new CRTHead(container, options);
}
