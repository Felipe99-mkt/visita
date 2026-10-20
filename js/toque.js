// Controles de toque para celular e tablet:
// joystick virtual (andar), arrastar o dedo na tela (olhar), botões de pular, correr e menu.
import * as THREE from 'three';

export const EH_TOQUE = matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);

const RAIO_JOY = 50;          // px que o pino anda até a velocidade máxima
const SENS_OLHAR = 0.0045;    // radianos por pixel arrastado

export function criarControlesToque(camera, { onPular, onMenu }) {
  const raiz = document.getElementById('toque');
  const joy = document.getElementById('joystick');
  const pino = document.getElementById('joystick-pino');
  const btCorrer = document.getElementById('bt-correr');
  const estado = { frente: 0, lado: 0, correr: false, ativo: false };

  let idJoy = null, centro = { x: 0, y: 0 };
  let idOlhar = null, ultimo = { x: 0, y: 0 };
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function moverPino(dx, dy) {
    const d = Math.hypot(dx, dy), k = d > RAIO_JOY ? RAIO_JOY / d : 1;
    dx *= k; dy *= k;
    pino.style.transform = `translate(${dx}px, ${dy}px)`;
    estado.lado = dx / RAIO_JOY;
    estado.frente = -dy / RAIO_JOY;
  }

  joy.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0]; idJoy = t.identifier;
    const r = joy.getBoundingClientRect(); centro = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    moverPino(t.clientX - centro.x, t.clientY - centro.y);
  }, { passive: false });

  // olhar: qualquer toque que não comece num controle
  window.addEventListener('touchstart', e => {
    if (!estado.ativo) return;
    for (const t of e.changedTouches) {
      if (t.target.closest('#joystick, .bt-toque, .lil-gui')) continue;
      if (idOlhar === null) { idOlhar = t.identifier; ultimo = { x: t.clientX, y: t.clientY }; }
    }
  }, { passive: true });

  window.addEventListener('touchmove', e => {
    if (!estado.ativo) return;
    for (const t of e.changedTouches) {
      if (t.identifier === idJoy) moverPino(t.clientX - centro.x, t.clientY - centro.y);
      else if (t.identifier === idOlhar) {
        const dx = t.clientX - ultimo.x, dy = t.clientY - ultimo.y;
        ultimo = { x: t.clientX, y: t.clientY };
        euler.setFromQuaternion(camera.quaternion);
        euler.y -= dx * SENS_OLHAR;
        euler.x = THREE.MathUtils.clamp(euler.x - dy * SENS_OLHAR, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
        camera.quaternion.setFromEuler(euler);
      }
    }
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  function soltar(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === idJoy) { idJoy = null; moverPino(0, 0); }
      if (t.identifier === idOlhar) idOlhar = null;
    }
  }
  window.addEventListener('touchend', soltar);
  window.addEventListener('touchcancel', soltar);

  const botao = (id, fn) => document.getElementById(id).addEventListener('touchstart', e => { e.preventDefault(); fn(); }, { passive: false });
  botao('bt-pular', onPular);
  botao('bt-correr', () => { estado.correr = !estado.correr; btCorrer.classList.toggle('ativo', estado.correr); });
  botao('bt-menu', onMenu);
  // iOS: impede o zoom de pinça
  document.addEventListener('gesturestart', e => e.preventDefault());

  return {
    estado,
    ligar() { estado.ativo = true; raiz.classList.remove('escondido'); },
    desligar() {
      estado.ativo = false; raiz.classList.add('escondido');
      idJoy = idOlhar = null; moverPino(0, 0);
    },
  };
}

// tela cheia e paisagem quando o navegador permite (Android). No iPhone o Safari não deixa; não tem problema.
export async function pedirTelaCheia() {
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* ignora */ }
  try { await screen.orientation?.lock?.('landscape'); } catch { /* ignora */ }
}
